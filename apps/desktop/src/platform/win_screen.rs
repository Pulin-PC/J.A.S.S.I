//! Windows: UI Automation reads the screen as text, SendInput clicks and types.
//! No screenshots. Nothing read here is stored or logged.
//! NOT run on a real PC yet: it compiles against the Windows API, nothing more. See the README.
#![allow(non_upper_case_globals)] // Windows names its constants like UIA_ButtonControlTypeId

use super::win::{com, start_apps};
use crate::policy::{Action, AppInfo, Dir, Front, KeyName, KeyPress, Mods, RawNode};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Mutex};
use std::thread::sleep;
use std::time::{Duration, Instant};
use windows::core::{BOOL, BSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Storage::Packaging::Appx::GetApplicationUserModelId;
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
use windows::Win32::System::Threading::{
    GetCurrentProcessId, GetCurrentThreadId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Accessibility::*;
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, EnumChildWindows, GetForegroundWindow, GetMessageW, GetSystemMetrics, GetWindowRect, GetWindowThreadProcessId,
    PostThreadMessageW, SetCursorPos, SetWindowsHookExW, UnhookWindowsHookEx, KBDLLHOOKSTRUCT, LLKHF_INJECTED, MSG, MSLLHOOKSTRUCT,
    SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, WH_KEYBOARD_LL, WH_MOUSE_LL, WM_QUIT,
};

type Res<T> = Result<T, &'static str>;

fn automation() -> Res<IUIAutomation> {
    com();
    unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }.map_err(|_| "failed")
}

// ---------------------------------------------------------------- the app in front

fn pid_of(hwnd: HWND) -> u32 {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    pid
}

/// (AppUserModelID if it is a packaged app, full path of the program)
fn process_identity(pid: u32) -> (String, String) {
    unsafe {
        let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return (String::new(), String::new()) };
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let aumid = if GetApplicationUserModelId(process, &mut len, Some(PWSTR(buf.as_mut_ptr()))).is_ok() && len > 1 {
            String::from_utf16_lossy(&buf[..len as usize - 1])
        } else {
            String::new()
        };
        let mut len = buf.len() as u32;
        let exe = if QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok() {
            String::from_utf16_lossy(&buf[..len as usize])
        } else {
            String::new()
        };
        let _ = CloseHandle(process);
        (aumid, exe)
    }
}

/// Store apps all sit inside one host program (ApplicationFrameHost). The real app owns a child window.
fn real_pid(hwnd: HWND) -> u32 {
    let host = pid_of(hwnd);
    let (_, exe) = process_identity(host);
    if !exe.to_lowercase().ends_with("applicationframehost.exe") {
        return host;
    }
    struct Search {
        host: u32,
        found: u32,
    }
    unsafe extern "system" fn each(child: HWND, param: LPARAM) -> BOOL {
        let search = &mut *(param.0 as *mut Search);
        let pid = pid_of(child);
        if pid != 0 && pid != search.host {
            search.found = pid;
            return BOOL(0);
        }
        BOOL(1)
    }
    let mut search = Search { host, found: 0 };
    unsafe {
        let _ = EnumChildWindows(Some(hwnd), Some(each), LPARAM(&mut search as *mut Search as isize));
    }
    if search.found != 0 {
        search.found
    } else {
        host
    }
}

fn front_window() -> Option<HWND> {
    let hwnd = unsafe { GetForegroundWindow() };
    (!hwnd.is_invalid()).then_some(hwnd)
}

/// The app in front. Its id is the same one `listApps()` gives: the AppUserModelID, lower case.
/// A program that is not in the Start menu is known by its file name instead (for example "notepad.exe").
pub fn front_app() -> Option<Front> {
    let hwnd = front_window()?;
    let pid = real_pid(hwnd);
    let (aumid, exe) = process_identity(pid);
    let exe_lower = exe.to_lowercase();
    let file = Path::new(&exe).file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default();
    let known = start_apps().into_iter().find(|a| {
        (!aumid.is_empty() && a.aumid.eq_ignore_ascii_case(&aumid)) || (!exe_lower.is_empty() && a.exe == exe_lower)
    });
    let (id, name) = match known {
        Some(a) => (a.aumid.to_lowercase(), a.name),
        None if !aumid.is_empty() => (aumid.to_lowercase(), file.trim_end_matches(".exe").to_string()),
        None => (file.to_lowercase(), file.trim_end_matches(".exe").to_string()),
    };
    Some(Front { app: AppInfo { id, name }, pid, own: pid == unsafe { GetCurrentProcessId() } })
}

// ---------------------------------------------------------------- screen_read

/// What the last `screen_read` saw: `n` in `screen_act` is an index into this. Replaced by the next read.
/// Kept in memory only, never written anywhere.
struct Screen {
    pid: u32,
    els: Vec<IUIAutomationElement>,
    raw: Vec<RawNode>,
    invoke: Vec<bool>,
}
unsafe impl Send for Screen {}
static SCREEN: Mutex<Option<Screen>> = Mutex::new(None);

const MAX_WALK: i32 = 1500;

pub fn forget_screen() {
    *SCREEN.lock().unwrap() = None;
}

fn role_word(kind: UIA_CONTROLTYPE_ID) -> &'static str {
    match kind {
        UIA_ButtonControlTypeId | UIA_SplitButtonControlTypeId => "button",
        UIA_EditControlTypeId | UIA_DocumentControlTypeId | UIA_ComboBoxControlTypeId => "field",
        UIA_TextControlTypeId => "text",
        UIA_HyperlinkControlTypeId => "link",
        UIA_CheckBoxControlTypeId => "checkbox",
        UIA_RadioButtonControlTypeId => "radio",
        UIA_ImageControlTypeId => "image",
        UIA_WindowControlTypeId => "window",
        UIA_MenuItemControlTypeId => "menuitem",
        UIA_TabItemControlTypeId => "tab",
        UIA_ListItemControlTypeId | UIA_TreeItemControlTypeId | UIA_DataItemControlTypeId => "row",
        UIA_SliderControlTypeId => "slider",
        UIA_HeaderControlTypeId | UIA_HeaderItemControlTypeId => "heading",
        UIA_PaneControlTypeId | UIA_GroupControlTypeId => "group",
        UIA_ListControlTypeId | UIA_TreeControlTypeId | UIA_TableControlTypeId | UIA_DataGridControlTypeId => "list",
        UIA_MenuControlTypeId | UIA_MenuBarControlTypeId => "menu",
        UIA_ToolBarControlTypeId => "toolbar",
        UIA_ScrollBarControlTypeId => "scrollbar",
        UIA_ProgressBarControlTypeId => "progressindicator",
        _ => "item",
    }
}

fn text_of(v: windows::core::Result<VARIANT>) -> String {
    v.ok().and_then(|v| BSTR::try_from(&v).ok()).map(|b| b.to_string()).unwrap_or_default()
}

fn int_of(v: windows::core::Result<VARIANT>) -> Option<i32> {
    v.ok().and_then(|v| i32::try_from(&v).ok())
}

fn bool_of(v: windows::core::Result<VARIANT>) -> bool {
    v.ok().and_then(|v| bool::try_from(&v).ok()).unwrap_or(false)
}

/// Returns the node and whether it can be pressed without the mouse (Invoke).
fn raw_node(el: &IUIAutomationElement) -> (RawNode, bool) {
    unsafe {
        let kind = el.CachedControlType().unwrap_or(UIA_CustomControlTypeId);
        let name = el.CachedName().map(|b| b.to_string()).unwrap_or_default();
        let enabled = el.CachedIsEnabled().map(|b| b.as_bool()).unwrap_or(true);
        let secure = el.CachedIsPassword().map(|b| b.as_bool()).unwrap_or(false);
        let field = secure || matches!(kind, UIA_EditControlTypeId | UIA_DocumentControlTypeId | UIA_ComboBoxControlTypeId);
        let toggle = matches!(kind, UIA_CheckBoxControlTypeId | UIA_RadioButtonControlTypeId);
        let invoke = bool_of(el.GetCachedPropertyValue(UIA_IsInvokePatternAvailablePropertyId));
        let clickable = enabled
            && (invoke
                || matches!(
                    kind,
                    UIA_ButtonControlTypeId | UIA_SplitButtonControlTypeId | UIA_HyperlinkControlTypeId | UIA_CheckBoxControlTypeId
                        | UIA_RadioButtonControlTypeId | UIA_MenuItemControlTypeId | UIA_TabItemControlTypeId | UIA_ListItemControlTypeId
                        | UIA_TreeItemControlTypeId
                ));
        let help = el.CachedHelpText().map(|b| b.to_string()).unwrap_or_default();
        // The text of a password box is never even asked for.
        let (text, hint) = if field {
            let value = if secure { String::new() } else { text_of(el.GetCachedPropertyValue(UIA_ValueValuePropertyId)) };
            (value, if name.is_empty() { help } else { name })
        } else if toggle {
            let state = match int_of(el.GetCachedPropertyValue(UIA_ToggleToggleStatePropertyId)) {
                Some(0) => "off",
                Some(_) => "on",
                None => "",
            };
            (name, state.to_string())
        } else {
            (name, help)
        };
        let r = el.CachedBoundingRectangle().unwrap_or_default();
        let node = RawNode {
            role: role_word(kind).to_string(),
            text,
            hint,
            editable: field && enabled,
            clickable,
            focused: el.CachedHasKeyboardFocus().map(|b| b.as_bool()).unwrap_or(false),
            secure,
            bounds: [r.left, r.top, r.right - r.left, r.bottom - r.top],
        };
        (node, invoke)
    }
}

/// Reads the window in front as a flat list of elements, top to bottom.
/// Returns the elements and the window's frame (what counts as "visible").
pub fn read_screen(front: &Front, cancel: &AtomicBool) -> Res<(Vec<RawNode>, [i32; 4])> {
    forget_screen();
    let Some(hwnd) = front_window() else { return Ok((Vec::new(), [0; 4])) };
    let uia = automation()?;
    unsafe {
        let root = uia.ElementFromHandle(hwnd).map_err(|_| "failed")?;
        let cache = uia.CreateCacheRequest().map_err(|_| "failed")?;
        for property in [
            UIA_NamePropertyId,
            UIA_ControlTypePropertyId,
            UIA_IsEnabledPropertyId,
            UIA_IsPasswordPropertyId,
            UIA_HasKeyboardFocusPropertyId,
            UIA_BoundingRectanglePropertyId,
            UIA_HelpTextPropertyId,
            UIA_ValueValuePropertyId,
            UIA_ToggleToggleStatePropertyId,
            UIA_IsInvokePatternAvailablePropertyId,
        ] {
            cache.AddProperty(property).map_err(|_| "failed")?;
        }
        // Only what is on screen: UI Automation leaves out everything scrolled away.
        let on_screen = uia.CreatePropertyCondition(UIA_IsOffscreenPropertyId, &VARIANT::from(false)).map_err(|_| "failed")?;
        let found = root.FindAllBuildCache(TreeScope_Subtree, &on_screen, &cache).map_err(|_| "failed")?;
        let count = found.Length().unwrap_or(0).min(MAX_WALK);
        let mut els = Vec::with_capacity(count as usize);
        let mut raw = Vec::with_capacity(count as usize);
        let mut invoke = Vec::with_capacity(count as usize);
        for i in 0..count {
            if cancel.load(Ordering::Relaxed) {
                return Err("stopped");
            }
            let Ok(el) = found.GetElement(i) else { continue };
            let (node, can_invoke) = raw_node(&el);
            raw.push(node);
            invoke.push(can_invoke);
            els.push(el);
        }
        let mut frame = RECT::default();
        let _ = GetWindowRect(hwnd, &mut frame);
        let view = [frame.left, frame.top, frame.right - frame.left, frame.bottom - frame.top];
        *SCREEN.lock().unwrap() = Some(Screen { pid: front.pid, els, raw: raw.clone(), invoke });
        Ok((raw, view))
    }
}

fn target(front: &Front, n: usize) -> Res<(IUIAutomationElement, RawNode, bool)> {
    let screen = SCREEN.lock().unwrap();
    let screen = screen.as_ref().ok_or("stale")?;
    if screen.pid != front.pid {
        return Err("stale"); // another app came to the front since the last read
    }
    match (screen.els.get(n), screen.raw.get(n), screen.invoke.get(n)) {
        (Some(el), Some(node), Some(invoke)) => Ok((el.clone(), node.clone(), *invoke)),
        _ => Err("stale"),
    }
}

/// Is element `n` of the last read a password box?
pub fn node_is_secure(front: &Front, n: usize) -> bool {
    target(front, n).map(|(_, node, _)| node.secure).unwrap_or(false)
}

fn focused() -> Option<IUIAutomationElement> {
    unsafe { automation().ok()?.GetFocusedElement().ok() }
}

/// Is the box that has the keyboard right now a password box?
pub fn focused_is_secure() -> bool {
    focused().is_some_and(|el| unsafe { el.CurrentIsPassword() }.map(|b| b.as_bool()).unwrap_or(false))
}

/// Does a text box have the keyboard right now? Typed letters outside a text box would act as
/// shortcuts in whatever app is in front, so `type` refuses to run without one.
fn focused_is_text_box() -> bool {
    focused().is_some_and(|el| {
        matches!(unsafe { el.CurrentControlType() }, Ok(UIA_EditControlTypeId) | Ok(UIA_DocumentControlTypeId) | Ok(UIA_ComboBoxControlTypeId))
    })
}

// ---------------------------------------------------------------- screen_act

fn send(inputs: &[INPUT]) -> Res<()> {
    let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent as usize == inputs.len() {
        Ok(())
    } else {
        Err("failed") // Windows refuses input into a window that runs with higher rights
    }
}

fn mouse(flags: MOUSE_EVENT_FLAGS, x: i32, y: i32, data: i32) -> INPUT {
    INPUT { r#type: INPUT_MOUSE, Anonymous: INPUT_0 { mi: MOUSEINPUT { dx: x, dy: y, mouseData: data as u32, dwFlags: flags, time: 0, dwExtraInfo: 0 } } }
}

fn key(vk: VIRTUAL_KEY, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: vk, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } } }
}

fn center(b: [i32; 4]) -> Res<(i32, i32)> {
    if b[2] <= 0 || b[3] <= 0 {
        return Err("stale");
    }
    Ok((b[0] + b[2] / 2, b[1] + b[3] / 2))
}

/// Screen pixels → the 0..65535 scale SendInput wants, across all monitors.
fn absolute(x: i32, y: i32) -> (i32, i32) {
    unsafe {
        let (left, top) = (GetSystemMetrics(SM_XVIRTUALSCREEN), GetSystemMetrics(SM_YVIRTUALSCREEN));
        let (width, height) = (GetSystemMetrics(SM_CXVIRTUALSCREEN).max(1), GetSystemMetrics(SM_CYVIRTUALSCREEN).max(1));
        (((x - left) as i64 * 65535 / width as i64) as i32, ((y - top) as i64 * 65535 / height as i64) as i32)
    }
}

fn click(at: (i32, i32)) -> Res<()> {
    let (x, y) = absolute(at.0, at.1);
    let place = MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
    send(&[mouse(MOUSEEVENTF_MOVE | place, x, y, 0)])?;
    sleep(Duration::from_millis(30));
    send(&[mouse(MOUSEEVENTF_LEFTDOWN | place, x, y, 0), mouse(MOUSEEVENTF_LEFTUP | place, x, y, 0)])
}

fn tap(el: &IUIAutomationElement, node: &RawNode, can_invoke: bool) -> Res<()> {
    unsafe {
        if node.editable {
            if el.SetFocus().is_ok() {
                return Ok(());
            }
        } else if can_invoke {
            if let Ok(pattern) = el.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId) {
                if pattern.Invoke().is_ok() {
                    return Ok(());
                }
            }
        }
    }
    click(center(node.bounds)?)
}

fn type_text(text: &str, cancel: &AtomicBool) -> Res<()> {
    let units: Vec<u16> = text.replace("\r\n", "\n").encode_utf16().collect();
    for chunk in units.chunks(10) {
        if cancel.load(Ordering::Relaxed) {
            return Err("stopped");
        }
        let mut inputs = Vec::with_capacity(chunk.len() * 2);
        for unit in chunk {
            if *unit == b'\n' as u16 {
                inputs.push(key(VK_RETURN, 0, KEYBD_EVENT_FLAGS(0)));
                inputs.push(key(VK_RETURN, 0, KEYEVENTF_KEYUP));
            } else {
                inputs.push(key(VIRTUAL_KEY(0), *unit, KEYEVENTF_UNICODE));
                inputs.push(key(VIRTUAL_KEY(0), *unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
            }
        }
        send(&inputs)?;
        sleep(Duration::from_millis(12));
    }
    Ok(())
}

fn key_code(key: KeyName) -> Option<VIRTUAL_KEY> {
    Some(match key {
        KeyName::Enter => VK_RETURN,
        KeyName::Tab => VK_TAB,
        KeyName::Space => VK_SPACE,
        KeyName::Backspace => VK_BACK,
        KeyName::Escape => VK_ESCAPE,
        KeyName::Delete => VK_DELETE,
        KeyName::Home => VK_HOME,
        KeyName::End => VK_END,
        KeyName::PageUp => VK_PRIOR,
        KeyName::PageDown => VK_NEXT,
        KeyName::Left => VK_LEFT,
        KeyName::Right => VK_RIGHT,
        KeyName::Down => VK_DOWN,
        KeyName::Up => VK_UP,
        // Letters and digits: the virtual-key code is the upper-case character.
        KeyName::Char(c) if c.is_ascii_alphanumeric() => VIRTUAL_KEY(c.to_ascii_uppercase() as u16),
        KeyName::Char(_) => return None,
    })
}

/// Presses one key with its modifiers. "cmd" means the main shortcut key: Ctrl on Windows.
fn press_code(code: VIRTUAL_KEY, mods: Mods) -> Res<()> {
    let mut held = Vec::new();
    if mods.cmd || mods.ctrl {
        held.push(VK_CONTROL);
    }
    if mods.alt {
        held.push(VK_MENU);
    }
    if mods.shift {
        held.push(VK_SHIFT);
    }
    let mut inputs: Vec<INPUT> = held.iter().map(|m| key(*m, 0, KEYBD_EVENT_FLAGS(0))).collect();
    inputs.push(key(code, 0, KEYBD_EVENT_FLAGS(0)));
    inputs.push(key(code, 0, KEYEVENTF_KEYUP));
    inputs.extend(held.iter().rev().map(|m| key(*m, 0, KEYEVENTF_KEYUP)));
    send(&inputs)
}

fn press(key: KeyPress) -> Res<()> {
    press_code(key_code(key.key).ok_or("bad_args")?, key.mods)
}

fn scroll(at: (i32, i32), dir: Dir) -> Res<()> {
    unsafe {
        let _ = SetCursorPos(at.0, at.1);
    }
    sleep(Duration::from_millis(30));
    const NOTCH: i32 = 120;
    match dir {
        Dir::Up => send(&[mouse(MOUSEEVENTF_WHEEL, 0, 0, NOTCH * 3)]),
        Dir::Down => send(&[mouse(MOUSEEVENTF_WHEEL, 0, 0, -NOTCH * 3)]),
        Dir::Left => send(&[mouse(MOUSEEVENTF_HWHEEL, 0, 0, -NOTCH * 3)]),
        Dir::Right => send(&[mouse(MOUSEEVENTF_HWHEEL, 0, 0, NOTCH * 3)]),
    }
}

/// Carries out one action. The caller has already checked the locked-app, protected-screen and
/// secure-field rules; the keyboard paths check the live focus once more right before typing.
pub fn act(front: &Front, action: &Action, cancel: &AtomicBool) -> Res<()> {
    com();
    match action {
        Action::Tap { n } => {
            let (el, node, can_invoke) = target(front, *n)?;
            tap(&el, &node, can_invoke)
        }
        Action::Type { n, text } => {
            if let Some(n) = n {
                let (el, node, _) = target(front, *n)?;
                if node.secure {
                    return Err("secure_field");
                }
                if !node.editable {
                    return Err("not_editable");
                }
                if unsafe { el.SetFocus() }.is_err() {
                    click(center(node.bounds)?)?;
                }
                sleep(Duration::from_millis(120));
            }
            if focused_is_secure() {
                return Err("secure_field");
            }
            if !focused_is_text_box() {
                return Err("not_editable");
            }
            type_text(text, cancel)
        }
        Action::Scroll { n, dir } => {
            let bounds = match n {
                Some(n) => target(front, *n)?.1.bounds,
                None => SCREEN.lock().unwrap().as_ref().and_then(|s| s.raw.first().map(|w| w.bounds)).ok_or("stale")?,
            };
            scroll(center(bounds)?, *dir)
        }
        Action::Key { key } => {
            if focused_is_secure() {
                return Err("secure_field");
            }
            press(*key)
        }
        // "Back" on Windows: Alt + Left (browsers, File Explorer, Settings-style apps).
        Action::Back => {
            if focused_is_secure() {
                return Err("secure_field");
            }
            press_code(VK_LEFT, Mods { alt: true, ..Mods::default() })
        }
        // A computer has no Home button.
        Action::Home => Err("unsupported"),
    }
}

// ---------------------------------------------------------------- the user takes over

static USER_ACTED: AtomicBool = AtomicBool::new(false);

unsafe extern "system" fn on_key(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    if code >= 0 {
        let event = &*(l.0 as *const KBDLLHOOKSTRUCT);
        if (event.flags.0 & LLKHF_INJECTED.0) == 0 {
            USER_ACTED.store(true, Ordering::SeqCst);
        }
    }
    CallNextHookEx(None, code, w, l)
}

unsafe extern "system" fn on_mouse(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    const LLMHF_INJECTED: u32 = 1;
    if code >= 0 {
        let event = &*(l.0 as *const MSLLHOOKSTRUCT);
        if (event.flags & LLMHF_INJECTED) == 0 {
            USER_ACTED.store(true, Ordering::SeqCst);
        }
    }
    CallNextHookEx(None, code, w, l)
}

/// Watches for the real mouse or keyboard being used while an op runs. Windows marks the input
/// J.A.S.S.I makes itself as "injected", so only a person's own input counts.
/// The hooks exist only for as long as the op does.
pub struct InputWatch {
    thread: u32,
}

impl InputWatch {
    pub fn start() -> Self {
        USER_ACTED.store(false, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || unsafe {
            let keys = SetWindowsHookExW(WH_KEYBOARD_LL, Some(on_key), None, 0);
            let mice = SetWindowsHookExW(WH_MOUSE_LL, Some(on_mouse), None, 0);
            let _ = tx.send(GetCurrentThreadId());
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {}
            if let Ok(hook) = keys {
                let _ = UnhookWindowsHookEx(hook);
            }
            if let Ok(hook) = mice {
                let _ = UnhookWindowsHookEx(hook);
            }
        });
        InputWatch { thread: rx.recv_timeout(Duration::from_secs(2)).unwrap_or(0) }
    }

    pub fn user_acted(&self) -> bool {
        USER_ACTED.load(Ordering::SeqCst)
    }
}

impl Drop for InputWatch {
    fn drop(&mut self) {
        if self.thread != 0 {
            unsafe {
                let _ = PostThreadMessageW(self.thread, WM_QUIT, WPARAM(0), LPARAM(0));
            }
        }
    }
}

// ---------------------------------------------------------------- open_app

pub fn open_app(id: &str, cancel: &AtomicBool) -> Res<()> {
    let app = start_apps().into_iter().find(|a| a.aumid.eq_ignore_ascii_case(id)).ok_or("not_found")?;
    open::that_detached(format!("shell:AppsFolder\\{}", app.aumid)).map_err(|_| "not_found")?;
    // Wait until it is really in front, so the next screen_read sees it.
    let until = Instant::now() + Duration::from_secs(6);
    while Instant::now() < until {
        if cancel.load(Ordering::Relaxed) {
            return Err("stopped");
        }
        if front_app().is_some_and(|f| f.app.id == id.to_lowercase()) {
            break;
        }
        sleep(Duration::from_millis(100));
    }
    Ok(())
}
