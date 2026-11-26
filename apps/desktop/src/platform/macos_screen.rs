//! macOS: the Accessibility (AX) API reads the screen as text, CGEvent clicks and types.
//! No screenshots, so no Screen Recording permission. Nothing read here is stored or logged.

use crate::policy::{Action, AppInfo, Dir, Front, KeyName, KeyPress, Mods, RawNode};
use accessibility_sys::*;
use core_foundation::array::{CFArray, CFArrayGetCount, CFArrayGetValueAtIndex, CFArrayRef};
use core_foundation::base::{CFGetTypeID, CFRelease, CFRetain, CFType, CFTypeRef, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;
use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation, CGEventType, CGMouseButton, ScrollEventUnit};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use core_graphics::geometry::{CGPoint, CGSize};
use objc2::rc::autoreleasepool;
use objc2_app_kit::{NSRunningApplication, NSWorkspace};
use std::ffi::c_void;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread::sleep;
use std::time::{Duration, Instant};

type Res<T> = Result<T, &'static str>;

// ---------------------------------------------------------------- small AX helpers

/// An owned accessibility element.
struct Ax(AXUIElementRef);
unsafe impl Send for Ax {}
impl Drop for Ax {
    fn drop(&mut self) {
        unsafe { CFRelease(self.0 as CFTypeRef) }
    }
}
impl Clone for Ax {
    fn clone(&self) -> Self {
        unsafe { CFRetain(self.0 as CFTypeRef) };
        Ax(self.0)
    }
}

fn attr(el: AXUIElementRef, name: &'static str) -> Option<CFType> {
    let key = CFString::from_static_string(name);
    let mut value: CFTypeRef = std::ptr::null();
    let err = unsafe { AXUIElementCopyAttributeValue(el, key.as_concrete_TypeRef(), &mut value) };
    if err != kAXErrorSuccess || value.is_null() {
        return None;
    }
    Some(unsafe { CFType::wrap_under_create_rule(value) })
}

fn is_element(v: &CFType) -> bool {
    unsafe { CFGetTypeID(v.as_CFTypeRef()) == AXUIElementGetTypeID() }
}

fn attr_el(el: AXUIElementRef, name: &'static str) -> Option<Ax> {
    let v = attr(el, name)?;
    if !is_element(&v) {
        return None;
    }
    let raw = v.as_CFTypeRef() as AXUIElementRef;
    unsafe { CFRetain(raw as CFTypeRef) };
    Some(Ax(raw))
}

fn string(v: &Option<CFType>) -> String {
    v.as_ref().and_then(|v| v.downcast::<CFString>()).map(|s| s.to_string()).unwrap_or_default()
}

fn string_or_number(v: &Option<CFType>) -> String {
    let Some(v) = v else { return String::new() };
    if let Some(s) = v.downcast::<CFString>() {
        return s.to_string();
    }
    if let Some(n) = v.downcast::<CFNumber>() {
        if let Some(i) = n.to_i64() {
            return i.to_string();
        }
        if let Some(f) = n.to_f64() {
            return format!("{f:.2}");
        }
    }
    String::new()
}

fn boolean(v: &Option<CFType>, default: bool) -> bool {
    v.as_ref().and_then(|v| v.downcast::<CFBoolean>()).map(bool::from).unwrap_or(default)
}

fn number(v: &Option<CFType>) -> Option<i64> {
    v.as_ref().and_then(|v| v.downcast::<CFNumber>()).and_then(|n| n.to_i64())
}

fn ax_value<T: Default>(v: &Option<CFType>, kind: AXValueType) -> Option<T> {
    let v = v.as_ref()?;
    if unsafe { CFGetTypeID(v.as_CFTypeRef()) != AXValueGetTypeID() } {
        return None;
    }
    let mut out = T::default();
    let ok = unsafe { AXValueGetValue(v.as_CFTypeRef() as AXValueRef, kind, &mut out as *mut T as *mut c_void) };
    ok.then_some(out)
}

fn children(v: &Option<CFType>) -> Vec<Ax> {
    let Some(arr) = v.as_ref().and_then(|v| v.downcast::<CFArray>()) else { return Vec::new() };
    let raw: CFArrayRef = arr.as_concrete_TypeRef();
    let count = unsafe { CFArrayGetCount(raw) };
    let mut out = Vec::with_capacity(count as usize);
    for i in 0..count {
        let item = unsafe { CFArrayGetValueAtIndex(raw, i) };
        if item.is_null() || unsafe { CFGetTypeID(item as CFTypeRef) != AXUIElementGetTypeID() } {
            continue;
        }
        unsafe { CFRetain(item as CFTypeRef) };
        out.push(Ax(item as AXUIElementRef));
    }
    out
}

// The attributes read for every element, in one round trip.
const ATTRS: [&str; 11] = [
    "AXRole", "AXSubrole", "AXTitle", "AXValue", "AXDescription", "AXPlaceholderValue", "AXFocused", "AXEnabled", "AXPosition", "AXSize",
    "AXChildren",
];
const ROLE: usize = 0;
const SUBROLE: usize = 1;
const TITLE: usize = 2;
const VALUE: usize = 3;
const DESC: usize = 4;
const PLACEHOLDER: usize = 5;
const FOCUSED: usize = 6;
const ENABLED: usize = 7;
const POSITION: usize = 8;
const SIZE: usize = 9;
const CHILDREN: usize = 10;

fn attrs(el: AXUIElementRef, names: &CFArray<CFString>) -> Option<Vec<Option<CFType>>> {
    let mut out: CFArrayRef = std::ptr::null();
    let err = unsafe { AXUIElementCopyMultipleAttributeValues(el, names.as_concrete_TypeRef(), 0, &mut out) };
    if err != kAXErrorSuccess || out.is_null() {
        return None;
    }
    let arr: CFArray<CFType> = unsafe { CFArray::wrap_under_create_rule(out) };
    let vals: Vec<Option<CFType>> = arr
        .iter()
        .map(|v| {
            // A missing attribute comes back as an AXValue holding an error code.
            let missing = unsafe {
                CFGetTypeID(v.as_CFTypeRef()) == AXValueGetTypeID() && AXValueGetType(v.as_CFTypeRef() as AXValueRef) == kAXValueTypeAXError
            };
            if missing {
                None
            } else {
                Some(v.clone())
            }
        })
        .collect();
    (vals.len() == ATTRS.len()).then_some(vals)
}

fn role_word(role: &str, subrole: &str) -> String {
    match (role, subrole) {
        (_, "AXSecureTextField") => "field",
        (_, "AXSearchField") => "field",
        (_, "AXTabButton") => "tab",
        (_, "AXSwitch") | (_, "AXToggle") => "switch",
        ("AXStaticText", _) => "text",
        ("AXTextField", _) | ("AXTextArea", _) | ("AXComboBox", _) => "field",
        ("AXButton", _) | ("AXMenuButton", _) | ("AXPopUpButton", _) | ("AXDisclosureTriangle", _) => "button",
        ("AXCheckBox", _) => "checkbox",
        ("AXRadioButton", _) => "radio",
        ("AXLink", _) => "link",
        ("AXImage", _) => "image",
        ("AXWindow", _) | ("AXSheet", _) => "window",
        ("AXMenuItem", _) | ("AXMenuBarItem", _) => "menuitem",
        ("AXHeading", _) => "heading",
        ("AXSlider", _) => "slider",
        ("AXRow", _) => "row",
        ("AXCell", _) => "cell",
        (other, _) => return other.trim_start_matches("AX").to_lowercase(),
    }
    .to_string()
}

fn raw_node(vals: &[Option<CFType>]) -> RawNode {
    let role = string(&vals[ROLE]);
    let subrole = string(&vals[SUBROLE]);
    let enabled = boolean(&vals[ENABLED], true);
    let secure = subrole == "AXSecureTextField";
    let field = secure || subrole == "AXSearchField" || matches!(role.as_str(), "AXTextField" | "AXTextArea" | "AXComboBox");
    let toggle = matches!(role.as_str(), "AXCheckBox" | "AXRadioButton");
    let clickable = enabled
        && matches!(
            role.as_str(),
            "AXButton" | "AXMenuButton" | "AXPopUpButton" | "AXCheckBox" | "AXRadioButton" | "AXLink" | "AXMenuItem" | "AXMenuBarItem"
                | "AXDisclosureTriangle" | "AXIncrementor" | "AXColorWell" | "AXDockItem"
        );
    let title = string(&vals[TITLE]);
    let desc = string(&vals[DESC]);
    let placeholder = string(&vals[PLACEHOLDER]);
    // The text of a secure field is never even looked at.
    let value = if secure || toggle { String::new() } else { string_or_number(&vals[VALUE]) };

    let (text, hint) = if field {
        (value, [placeholder, title, desc].into_iter().find(|s| !s.is_empty()).unwrap_or_default())
    } else if toggle {
        let state = match number(&vals[VALUE]) {
            Some(0) => "off",
            Some(_) => "on",
            None => "",
        };
        (if title.is_empty() { desc } else { title }, state.to_string())
    } else {
        // A plain button's "value" is only its pressed state (0 / 1), not something to read out.
        let value = if clickable && role != "AXPopUpButton" { String::new() } else { value };
        let text = [title, value, desc.clone()].into_iter().find(|s| !s.is_empty()).unwrap_or_default();
        (text, desc)
    };

    let bounds = match (ax_value::<CGPoint>(&vals[POSITION], kAXValueTypeCGPoint), ax_value::<CGSize>(&vals[SIZE], kAXValueTypeCGSize)) {
        (Some(p), Some(s)) => [p.x.round() as i32, p.y.round() as i32, s.width.round() as i32, s.height.round() as i32],
        _ => [0; 4],
    };

    RawNode {
        role: role_word(&role, &subrole),
        text,
        hint,
        editable: field && enabled,
        clickable,
        focused: boolean(&vals[FOCUSED], false),
        secure,
        bounds,
    }
}

fn overlaps(a: [i32; 4], b: [i32; 4]) -> bool {
    a[0] < b[0] + b[2] && a[0] + a[2] > b[0] && a[1] < b[1] + b[3] && a[1] + a[3] > b[1]
}

// ---------------------------------------------------------------- the app in front

fn app_identity(pid: i32) -> (String, String) {
    autoreleasepool(|_| {
        #[allow(unused_unsafe)]
        let app = unsafe { NSRunningApplication::runningApplicationWithProcessIdentifier(pid) };
        let Some(app) = app else { return (String::new(), String::new()) };
        #[allow(unused_unsafe)]
        let id = unsafe { app.bundleIdentifier() }.map(|s| s.to_string()).unwrap_or_default();
        #[allow(unused_unsafe)]
        let name = unsafe { app.localizedName() }.map(|s| s.to_string()).unwrap_or_default();
        (id, name)
    })
}

fn focused_pid() -> Option<i32> {
    let system = Ax(unsafe { AXUIElementCreateSystemWide() });
    let app = attr_el(system.0, "AXFocusedApplication")?;
    let mut pid = 0;
    (unsafe { AXUIElementGetPid(app.0, &mut pid) } == kAXErrorSuccess).then_some(pid)
}

fn workspace_front_pid() -> Option<i32> {
    autoreleasepool(|_| {
        #[allow(unused_unsafe)]
        let app = unsafe { NSWorkspace::sharedWorkspace().frontmostApplication() }?;
        #[allow(unused_unsafe)]
        Some(unsafe { app.processIdentifier() })
    })
}

pub fn front_app() -> Option<Front> {
    let pid = focused_pid().or_else(workspace_front_pid)?;
    let (id, name) = app_identity(pid);
    Some(Front { app: AppInfo { id: id.to_lowercase(), name }, pid: pid as u32, own: pid as u32 == std::process::id() })
}

// ---------------------------------------------------------------- screen_read

/// What the last `screen_read` saw: `n` in `screen_act` is an index into this. Replaced by the next read.
/// Kept in memory only, never written anywhere.
struct Screen {
    pid: u32,
    els: Vec<Ax>,
    raw: Vec<RawNode>,
}
static SCREEN: Mutex<Option<Screen>> = Mutex::new(None);

const MAX_WALK: usize = 1500;
const MAX_DEPTH: usize = 40;

pub fn forget_screen() {
    *SCREEN.lock().unwrap() = None;
}

/// Reads the front window of the app in front as a flat list of elements, top to bottom.
/// Returns the elements and the window's frame (what counts as "visible").
pub fn read_screen(front: &Front, cancel: &AtomicBool) -> Res<(Vec<RawNode>, [i32; 4])> {
    forget_screen();
    let app = Ax(unsafe { AXUIElementCreateApplication(front.pid as i32) });
    unsafe { AXUIElementSetMessagingTimeout(app.0, 1.5) };
    let window = attr_el(app.0, "AXFocusedWindow")
        .or_else(|| attr_el(app.0, "AXMainWindow"))
        .or_else(|| children(&attr(app.0, "AXWindows")).into_iter().next());
    let Some(window) = window else { return Ok((Vec::new(), [0; 4])) };

    let names = CFArray::from_CFTypes(&ATTRS.map(CFString::from_static_string));
    let mut els = Vec::new();
    let mut raw = Vec::new();
    let mut view = [0; 4];
    let mut stack = vec![(window, 0usize)];
    while let Some((el, depth)) = stack.pop() {
        if cancel.load(Ordering::Relaxed) {
            return Err("stopped");
        }
        if raw.len() >= MAX_WALK {
            break;
        }
        let Some(vals) = attrs(el.0, &names) else { continue };
        let node = raw_node(&vals);
        if raw.is_empty() {
            view = node.bounds;
        }
        let sized = node.bounds[2] > 0 && node.bounds[3] > 0;
        // Skip whole branches that are scrolled out of the window.
        if depth < MAX_DEPTH && (!sized || overlaps(node.bounds, view)) {
            for child in children(&vals[CHILDREN]).into_iter().rev() {
                stack.push((child, depth + 1));
            }
        }
        raw.push(node);
        els.push(el);
    }
    *SCREEN.lock().unwrap() = Some(Screen { pid: front.pid, els, raw: raw.clone() });
    Ok((raw, view))
}

fn target(front: &Front, n: usize) -> Res<(Ax, RawNode)> {
    let screen = SCREEN.lock().unwrap();
    let screen = screen.as_ref().ok_or("stale")?;
    if screen.pid != front.pid {
        return Err("stale"); // another app came to the front since the last read
    }
    match (screen.els.get(n), screen.raw.get(n)) {
        (Some(el), Some(node)) => Ok((el.clone(), node.clone())),
        _ => Err("stale"),
    }
}

/// Is element `n` of the last read a password / secure field?
pub fn node_is_secure(front: &Front, n: usize) -> bool {
    target(front, n).map(|(_, node)| node.secure).unwrap_or(false)
}

fn focused_element() -> Option<Ax> {
    let system = Ax(unsafe { AXUIElementCreateSystemWide() });
    attr_el(system.0, "AXFocusedUIElement")
}

/// Is the field that has the keyboard right now a password / secure field?
pub fn focused_is_secure() -> bool {
    focused_element().is_some_and(|el| string(&attr(el.0, "AXSubrole")) == "AXSecureTextField")
}

/// Does a text box have the keyboard right now? Typed letters outside a text box would act as
/// shortcuts in whatever app is in front, so `type` refuses to run without one.
fn focused_is_text_box() -> bool {
    focused_element().is_some_and(|el| {
        matches!(string(&attr(el.0, "AXRole")).as_str(), "AXTextField" | "AXTextArea" | "AXComboBox")
            || string(&attr(el.0, "AXSubrole")) == "AXSearchField"
    })
}

// ---------------------------------------------------------------- screen_act

// Every event J.A.S.S.I makes is posted at the session level, never the HID level: see `InputWatch`.
fn source() -> Res<CGEventSource> {
    CGEventSource::new(CGEventSourceStateID::CombinedSessionState).map_err(|_| "failed")
}

fn center(b: [i32; 4]) -> Res<CGPoint> {
    if b[2] <= 0 || b[3] <= 0 {
        return Err("stale");
    }
    Ok(CGPoint::new(b[0] as f64 + b[2] as f64 / 2.0, b[1] as f64 + b[3] as f64 / 2.0))
}

fn click(at: CGPoint) -> Res<()> {
    for kind in [CGEventType::MouseMoved, CGEventType::LeftMouseDown, CGEventType::LeftMouseUp] {
        let ev = CGEvent::new_mouse_event(source()?, kind, at, CGMouseButton::Left).map_err(|_| "failed")?;
        ev.set_flags(CGEventFlags::CGEventFlagNull);
        ev.post(CGEventTapLocation::Session);
        sleep(Duration::from_millis(30));
    }
    Ok(())
}

fn perform(el: &Ax, action: &'static str) -> bool {
    let name = CFString::from_static_string(action);
    unsafe { AXUIElementPerformAction(el.0, name.as_concrete_TypeRef()) == kAXErrorSuccess }
}

fn focus(el: &Ax) -> bool {
    let key = CFString::from_static_string("AXFocused");
    unsafe { AXUIElementSetAttributeValue(el.0, key.as_concrete_TypeRef(), CFBoolean::true_value().as_CFTypeRef()) == kAXErrorSuccess }
}

fn tap(el: &Ax, node: &RawNode) -> Res<()> {
    if node.editable {
        if focus(el) {
            return Ok(());
        }
    } else if perform(el, "AXPress") {
        return Ok(());
    }
    click(center(node.bounds)?)
}

fn key_event(code: u16, down: bool, flags: CGEventFlags, text: Option<&[u16]>) -> Res<()> {
    let ev = CGEvent::new_keyboard_event(source()?, code, down).map_err(|_| "failed")?;
    ev.set_flags(flags);
    if let Some(text) = text {
        ev.set_string_from_utf16_unchecked(text);
    }
    ev.post(CGEventTapLocation::Session);
    Ok(())
}

const KEY_RETURN: u16 = 36;

fn type_text(text: &str, cancel: &AtomicBool) -> Res<()> {
    let none = CGEventFlags::CGEventFlagNull;
    for (i, line) in text.split('\n').enumerate() {
        if i > 0 {
            key_event(KEY_RETURN, true, none, None)?;
            key_event(KEY_RETURN, false, none, None)?;
            sleep(Duration::from_millis(10));
        }
        let chars: Vec<char> = line.chars().filter(|c| *c != '\r').collect();
        for chunk in chars.chunks(10) {
            if cancel.load(Ordering::Relaxed) {
                return Err("stopped");
            }
            let units: Vec<u16> = chunk.iter().collect::<String>().encode_utf16().collect();
            key_event(0, true, none, Some(&units))?;
            key_event(0, false, none, Some(&units))?;
            sleep(Duration::from_millis(12));
        }
    }
    Ok(())
}

fn key_code(key: KeyName) -> Option<u16> {
    Some(match key {
        KeyName::Enter => KEY_RETURN,
        KeyName::Tab => 48,
        KeyName::Space => 49,
        KeyName::Backspace => 51,
        KeyName::Escape => 53,
        KeyName::Delete => 117,
        KeyName::Home => 115,
        KeyName::End => 119,
        KeyName::PageUp => 116,
        KeyName::PageDown => 121,
        KeyName::Left => 123,
        KeyName::Right => 124,
        KeyName::Down => 125,
        KeyName::Up => 126,
        KeyName::Char(c) => match c.to_ascii_lowercase() {
            'a' => 0, 's' => 1, 'd' => 2, 'f' => 3, 'h' => 4, 'g' => 5, 'z' => 6, 'x' => 7, 'c' => 8, 'v' => 9, 'b' => 11, 'q' => 12,
            'w' => 13, 'e' => 14, 'r' => 15, 'y' => 16, 't' => 17, '1' => 18, '2' => 19, '3' => 20, '4' => 21, '6' => 22, '5' => 23,
            '9' => 25, '7' => 26, '8' => 28, '0' => 29, 'o' => 31, 'u' => 32, 'i' => 34, 'p' => 35, 'l' => 37, 'j' => 38, 'k' => 40,
            'n' => 45, 'm' => 46,
            _ => return None,
        },
    })
}

fn press_code(code: u16, mods: Mods) -> Res<()> {
    let mut flags = CGEventFlags::CGEventFlagNull;
    if mods.cmd {
        flags |= CGEventFlags::CGEventFlagCommand;
    }
    if mods.ctrl {
        flags |= CGEventFlags::CGEventFlagControl;
    }
    if mods.alt {
        flags |= CGEventFlags::CGEventFlagAlternate;
    }
    if mods.shift {
        flags |= CGEventFlags::CGEventFlagShift;
    }
    key_event(code, true, flags, None)?;
    sleep(Duration::from_millis(20));
    key_event(code, false, flags, None)
}

fn press(key: KeyPress) -> Res<()> {
    press_code(key_code(key.key).ok_or("bad_args")?, key.mods)
}

fn scroll(at: CGPoint, dir: Dir) -> Res<()> {
    let mv = CGEvent::new_mouse_event(source()?, CGEventType::MouseMoved, at, CGMouseButton::Left).map_err(|_| "failed")?;
    mv.post(CGEventTapLocation::Session);
    sleep(Duration::from_millis(30));
    let (dy, dx) = match dir {
        Dir::Up => (6, 0),
        Dir::Down => (-6, 0),
        Dir::Left => (0, 6),
        Dir::Right => (0, -6),
    };
    let ev = CGEvent::new_scroll_event(source()?, ScrollEventUnit::LINE, 2, dy, dx, 0).map_err(|_| "failed")?;
    ev.post(CGEventTapLocation::Session);
    Ok(())
}

/// Carries out one action. The caller has already checked the locked-app, protected-screen and
/// secure-field rules; the keyboard paths check the live focus once more right before typing.
pub fn act(front: &Front, action: &Action, cancel: &AtomicBool) -> Res<()> {
    match action {
        Action::Tap { n } => {
            let (el, node) = target(front, *n)?;
            tap(&el, &node)
        }
        Action::Type { n, text } => {
            if let Some(n) = n {
                let (el, node) = target(front, *n)?;
                if node.secure {
                    return Err("secure_field");
                }
                if !node.editable {
                    return Err("not_editable");
                }
                if !focus(&el) {
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
        // "Back" on a Mac: Command-[ (browsers, Finder, Settings-style apps).
        Action::Back => {
            if focused_is_secure() {
                return Err("secure_field");
            }
            press_code(33, Mods { cmd: true, ..Mods::default() })
        }
        // A computer has no Home button.
        Action::Home => Err("unsupported"),
    }
}

// ---------------------------------------------------------------- the user takes over

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
}

/// Watches for the real mouse, trackpad or keyboard being used. It reads the hardware (HID) event
/// clock. J.A.S.S.I's own clicks and typing are posted one level above it (`CGEventTapLocation::Session`),
/// so they never count as the user; anything arriving at the hardware level does.
pub struct InputWatch {
    start: Instant,
}

impl InputWatch {
    pub fn start() -> Self {
        InputWatch { start: Instant::now() }
    }

    pub fn user_acted(&self) -> bool {
        const HID_SYSTEM_STATE: i32 = 1;
        // left / right / other mouse down, mouse moved, dragged, key down, modifier keys, scroll wheel
        const EVENTS: [u32; 8] = [1, 3, 25, 5, 6, 10, 12, 22];
        let since = self.start.elapsed().as_secs_f64();
        EVENTS.iter().any(|t| unsafe { CGEventSourceSecondsSinceLastEventType(HID_SYSTEM_STATE, *t) } < since)
    }
}

// ---------------------------------------------------------------- open_app

pub fn open_app(id: &str, cancel: &AtomicBool) -> Res<()> {
    let opened = Command::new("/usr/bin/open").args(["-b", id]).status().map(|s| s.success()).unwrap_or(false);
    if !opened {
        return Err("not_found");
    }
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
