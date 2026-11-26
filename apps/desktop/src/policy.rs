//! The safety rules of the device channel (docs/native-contract.md §4) as pure logic.
//! No OS calls in here, so every rule is unit-tested (see the tests at the bottom).

use serde::Serialize;
use std::collections::HashSet;
use url::Url;

pub const MAX_NODES: usize = 300;
pub const MAX_TEXT: usize = 200;
pub const OP_LIMIT_SECS: u64 = 15;

/// Apps that are always locked, whatever the server or the web app says.
/// `setPolicy({ blockedApps })` adds to this list, it can never shrink it.
/// Ids are lower case: Apple bundle ids, Windows AppUserModelIDs or exe names.
const ALWAYS_LOCKED: &[&str] = &[
    "com.apple.keychainaccess",
    "com.apple.passwords",
    "com.1password.1password",
    "com.agilebits.onepassword7",
    "com.bitwarden.desktop",
    "org.keepassxc.keepassxc",
    "1password.exe",
    "bitwarden.exe",
    "keepassxc.exe",
    "keepass.exe",
];

/// System settings, permission prompts, sign-in prompts and installers: never acted on.
const PROTECTED: &[&str] = &[
    "com.apple.systempreferences",
    "com.apple.securityagent",
    "com.apple.installer",
    "com.apple.appstore",
    "com.apple.usernotificationcenter",
    "com.apple.accessibility.universalaccessauthwarn",
    "com.apple.coreservices.uiagent",
    "com.apple.localauthentication.ui",
    "com.apple.loginwindow",
    "windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel",
    "microsoft.desktopappinstaller_8wekyb3d8bbwe!app",
    "systemsettings.exe",
    "consent.exe",
    "credentialuibroker.exe",
    "msiexec.exe",
    "sechealthui.exe",
    "control.exe",
    "lockapp.exe",
    "appinstaller.exe",
];

fn norm(id: &str) -> String {
    id.trim().to_lowercase()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AppInfo {
    pub id: String,
    pub name: String,
}

/// The app in front, as the OS reports it. `own` = it is J.A.S.S.I itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Front {
    pub app: AppInfo,
    pub pid: u32,
    pub own: bool,
}

#[derive(Debug, Clone, Default)]
pub struct Policy {
    blocked: HashSet<String>,
}

impl Policy {
    pub fn new<I: IntoIterator<Item = String>>(ids: I) -> Self {
        Policy { blocked: ids.into_iter().map(|s| norm(&s)).filter(|s| !s.is_empty()).collect() }
    }

    pub fn ids(&self) -> Vec<String> {
        let mut v: Vec<String> = self.blocked.iter().cloned().collect();
        v.sort();
        v
    }

    pub fn is_blocked(&self, app_id: &str) -> bool {
        let id = norm(app_id);
        ALWAYS_LOCKED.contains(&id.as_str()) || self.blocked.contains(&id)
    }
}

pub fn is_protected(front: &Front) -> bool {
    front.own || PROTECTED.contains(&norm(&front.app.id).as_str())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    BlockedApp,
    ProtectedScreen,
    SecureField,
}

impl Refusal {
    pub fn code(self) -> &'static str {
        match self {
            Refusal::BlockedApp => "blocked_app",
            Refusal::ProtectedScreen => "protected_screen",
            Refusal::SecureField => "secure_field",
        }
    }
}

/// Rules 1-3 for `screen_act`. `uses_keyboard` = the action types text or presses a key;
/// `secure_target` = the field it would land in is a password / secure field.
pub fn check_act(policy: &Policy, front: &Front, uses_keyboard: bool, secure_target: bool) -> Result<(), Refusal> {
    if policy.is_blocked(&front.app.id) {
        return Err(Refusal::BlockedApp);
    }
    if is_protected(front) {
        return Err(Refusal::ProtectedScreen);
    }
    if uses_keyboard && secure_target {
        return Err(Refusal::SecureField);
    }
    Ok(())
}

// ---------------------------------------------------------------- screen_read: nodes

/// One element exactly as the OS reports it, before any filtering.
#[derive(Debug, Clone, Default)]
pub struct RawNode {
    pub role: String,
    pub text: String,
    pub hint: String,
    pub editable: bool,
    pub clickable: bool,
    pub focused: bool,
    pub secure: bool,
    pub bounds: [i32; 4],
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// One element as it leaves the device.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Node {
    pub n: usize,
    pub role: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    #[serde(skip_serializing_if = "is_false")]
    pub editable: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub clickable: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub focused: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub secure: bool,
    pub bounds: [i32; 4],
}

pub fn cut(s: &str, max: usize) -> String {
    s.trim().chars().take(max).collect()
}

fn overlaps(a: [i32; 4], b: [i32; 4]) -> bool {
    a[2] > 0 && a[3] > 0 && a[0] < b[0] + b[2] && a[0] + a[2] > b[0] && a[1] < b[1] + b[3] && a[1] + a[3] > b[1]
}

/// Rule 2 and the size limits: only what is visible inside `view`, at most 300 nodes,
/// text cut at 200 characters, and the text of a secure field never leaves the device.
/// `n` is the index into `raw`, so the platform can find the element again for `screen_act`.
pub fn filter_nodes(raw: &[RawNode], view: [i32; 4]) -> Vec<Node> {
    let mut out = Vec::new();
    for (n, r) in raw.iter().enumerate() {
        if out.len() >= MAX_NODES {
            break;
        }
        if !overlaps(r.bounds, view) {
            continue;
        }
        let text = if r.secure { String::new() } else { cut(&r.text, MAX_TEXT) };
        let hint = cut(&r.hint, MAX_TEXT);
        if text.is_empty() && hint.is_empty() && !r.clickable && !r.editable {
            continue;
        }
        out.push(Node {
            n,
            role: r.role.clone(),
            hint: if hint.is_empty() || hint == text { None } else { Some(hint) },
            text,
            editable: r.editable,
            clickable: r.clickable,
            focused: r.focused,
            secure: r.secure,
            bounds: r.bounds,
        });
    }
    out
}

// ---------------------------------------------------------------- screen_act: arguments

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dir {
    Up,
    Down,
    Left,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyName {
    Enter,
    Tab,
    Escape,
    Backspace,
    Delete,
    Space,
    Up,
    Down,
    Left,
    Right,
    Home,
    End,
    PageUp,
    PageDown,
    /// A letter or digit, only together with a modifier (for example "cmd+a").
    Char(char),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Mods {
    pub cmd: bool,
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyPress {
    pub key: KeyName,
    pub mods: Mods,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    Tap { n: usize },
    Type { n: Option<usize>, text: String },
    Scroll { n: Option<usize>, dir: Dir },
    Back,
    Home,
    Key { key: KeyPress },
}

impl Action {
    pub fn uses_keyboard(&self) -> bool {
        matches!(self, Action::Type { .. } | Action::Key { .. } | Action::Back)
    }
}

/// "enter", "tab", "escape", "cmd+a", "ctrl+shift+t" … (case does not matter).
pub fn parse_key(s: &str) -> Option<KeyPress> {
    let mut mods = Mods::default();
    let mut key = None;
    for part in s.split('+').map(|p| p.trim().to_lowercase()) {
        match part.as_str() {
            "cmd" | "command" | "meta" | "win" | "super" => mods.cmd = true,
            "ctrl" | "control" => mods.ctrl = true,
            "alt" | "option" | "opt" => mods.alt = true,
            "shift" => mods.shift = true,
            other => {
                if key.is_some() {
                    return None;
                }
                key = Some(match other {
                    "enter" | "return" => KeyName::Enter,
                    "tab" => KeyName::Tab,
                    "escape" | "esc" => KeyName::Escape,
                    "backspace" => KeyName::Backspace,
                    "delete" | "del" => KeyName::Delete,
                    "space" => KeyName::Space,
                    "up" => KeyName::Up,
                    "down" => KeyName::Down,
                    "left" => KeyName::Left,
                    "right" => KeyName::Right,
                    "home" => KeyName::Home,
                    "end" => KeyName::End,
                    "pageup" => KeyName::PageUp,
                    "pagedown" => KeyName::PageDown,
                    c => {
                        let mut it = c.chars();
                        match (it.next(), it.next()) {
                            (Some(ch), None) if ch.is_ascii_alphanumeric() => KeyName::Char(ch),
                            _ => return None,
                        }
                    }
                });
            }
        }
    }
    let key = key?;
    // A bare letter is typing, not a key press: use the "type" action for that.
    if matches!(key, KeyName::Char(_)) && !(mods.cmd || mods.ctrl || mods.alt) {
        return None;
    }
    Some(KeyPress { key, mods })
}

/// Reads the `args` of `screen_act`. Anything unknown is refused with `bad_args`.
pub fn parse_action(args: &serde_json::Value) -> Result<Action, &'static str> {
    let n = args.get("n").and_then(|v| v.as_u64()).map(|v| v as usize);
    let text = args.get("text").and_then(|v| v.as_str());
    match args.get("action").and_then(|v| v.as_str()).unwrap_or("") {
        "tap" => Ok(Action::Tap { n: n.ok_or("bad_args")? }),
        "type" => match text {
            Some(t) if !t.is_empty() && t.chars().count() <= 2000 => Ok(Action::Type { n, text: t.to_string() }),
            _ => Err("bad_args"),
        },
        "scroll" => {
            let dir = match args.get("dir").and_then(|v| v.as_str()).unwrap_or("down") {
                "up" => Dir::Up,
                "down" => Dir::Down,
                "left" => Dir::Left,
                "right" => Dir::Right,
                _ => return Err("bad_args"),
            };
            Ok(Action::Scroll { n, dir })
        }
        "back" => Ok(Action::Back),
        "home" => Ok(Action::Home),
        "key" => {
            let key = args.get("key").and_then(|v| v.as_str()).and_then(parse_key).ok_or("bad_args")?;
            Ok(Action::Key { key })
        }
        _ => Err("bad_args"),
    }
}

// ---------------------------------------------------------------- channel: back-off, addresses

/// "On errors wait 2 s, doubling up to 30 s."
#[derive(Debug)]
pub struct Backoff {
    next: u64,
}

impl Backoff {
    pub fn new() -> Self {
        Backoff { next: 2 }
    }
    /// Call after an error: how many seconds to wait now.
    pub fn fail(&mut self) -> u64 {
        let wait = self.next;
        self.next = (self.next * 2).min(30);
        wait
    }
    /// Call after a good answer.
    pub fn ok(&mut self) {
        self.next = 2;
    }
}

fn is_localhost(u: &Url) -> bool {
    matches!(u.host_str(), Some("localhost") | Some("127.0.0.1") | Some("[::1]"))
}

/// Rule 6: HTTPS only. Plain HTTP only for localhost, and only in dev builds.
/// Returns the server address without a trailing slash.
pub fn check_server(server: &str, dev: bool) -> Result<String, &'static str> {
    let u = Url::parse(server.trim()).map_err(|_| "bad_server")?;
    let allowed = match u.scheme() {
        "https" => true,
        "http" => dev && is_localhost(&u),
        _ => false,
    };
    if !allowed {
        return Err("https_only");
    }
    if u.host_str().is_none() || !u.username().is_empty() || u.password().is_some() || u.query().is_some() || u.fragment().is_some() {
        return Err("bad_server");
    }
    Ok(u.as_str().trim_end_matches('/').to_string())
}

pub fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme() && a.host_str() == b.host_str() && a.port_or_known_default() == b.port_or_known_default()
}

/// Is this page one of ours? Only then does it get the bridge and the events.
pub fn is_jassi_page(page: &str, jassi: &Url) -> bool {
    Url::parse(page).map(|u| same_origin(&u, jassi)).unwrap_or(false)
}

/// `openExternal` and outside links: only ordinary web, mail and phone links reach the default browser.
pub fn external_ok(link: &str) -> bool {
    match Url::parse(link) {
        Ok(u) => matches!(u.scheme(), "http" | "https" | "mailto" | "tel") && link.len() <= 4096,
        Err(_) => false,
    }
}

/// A `jassi://auth…` link becomes the `auth` event. Every other `jassi://` link is ignored.
pub fn auth_link(link: &str) -> Option<String> {
    let u = Url::parse(link).ok()?;
    if u.scheme() == "jassi" && u.host_str() == Some("auth") && link.len() <= 2048 {
        Some(link.to_string())
    } else {
        None
    }
}

/// Pairing tokens and device ids travel in an HTTP header: plain visible characters only.
pub fn token_ok(s: &str) -> bool {
    !s.is_empty() && s.len() <= 4096 && s.bytes().all(|b| b.is_ascii_graphic())
}

/// App ids are passed to the OS to open an app: keep them to plain id characters.
pub fn app_id_ok(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 300
        && !id.starts_with('-')
        && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '!' | '{' | '}' | '\\' | ' '))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn front(id: &str) -> Front {
        Front { app: AppInfo { id: id.into(), name: "App".into() }, pid: 1, own: false }
    }
    fn raw(text: &str) -> RawNode {
        RawNode { role: "text".into(), text: text.into(), bounds: [10, 10, 100, 20], ..Default::default() }
    }
    const VIEW: [i32; 4] = [0, 0, 800, 600];

    #[test]
    fn locked_apps_are_refused_whatever_the_case() {
        let p = Policy::new(vec!["Com.MyBank.App".to_string(), "  ".to_string()]);
        assert!(p.is_blocked("com.mybank.app"));
        assert!(p.is_blocked("COM.MYBANK.APP "));
        assert!(!p.is_blocked("com.apple.TextEdit"));
        assert_eq!(p.ids(), vec!["com.mybank.app"]);
        assert_eq!(check_act(&p, &front("com.mybank.app"), false, false), Err(Refusal::BlockedApp));
        assert_eq!(check_act(&p, &front("com.apple.TextEdit"), true, false), Ok(()));
    }

    #[test]
    fn password_managers_are_locked_even_with_an_empty_policy() {
        let p = Policy::default();
        assert!(p.is_blocked("com.apple.keychainaccess"));
        assert!(p.is_blocked("com.1password.1password"));
        assert!(p.is_blocked("KeePassXC.exe"));
    }

    #[test]
    fn protected_screens_and_our_own_window_are_never_acted_on() {
        let p = Policy::default();
        assert_eq!(check_act(&p, &front("com.apple.systempreferences"), false, false), Err(Refusal::ProtectedScreen));
        assert_eq!(check_act(&p, &front("com.apple.SecurityAgent"), false, false), Err(Refusal::ProtectedScreen));
        assert_eq!(check_act(&p, &front("SystemSettings.exe"), false, false), Err(Refusal::ProtectedScreen));
        let own = Front { app: AppInfo { id: "app.jassi.desktop".into(), name: "J.A.S.S.I".into() }, pid: 1, own: true };
        assert_eq!(check_act(&p, &own, false, false), Err(Refusal::ProtectedScreen));
    }

    #[test]
    fn locked_wins_over_protected_and_secure() {
        let p = Policy::new(vec!["com.apple.systempreferences".to_string()]);
        assert_eq!(check_act(&p, &front("com.apple.systempreferences"), true, true), Err(Refusal::BlockedApp));
    }

    #[test]
    fn typing_into_a_secure_field_is_refused_but_tapping_it_is_not() {
        let p = Policy::default();
        let f = front("com.apple.Safari");
        assert_eq!(check_act(&p, &f, true, true), Err(Refusal::SecureField));
        assert_eq!(check_act(&p, &f, false, true), Ok(()));
        assert_eq!(Refusal::SecureField.code(), "secure_field");
        assert_eq!(Refusal::BlockedApp.code(), "blocked_app");
        assert_eq!(Refusal::ProtectedScreen.code(), "protected_screen");
    }

    #[test]
    fn secure_text_never_leaves_the_device() {
        let mut r = raw("hunter2");
        r.secure = true;
        r.editable = true;
        r.hint = "Password".into();
        let out = filter_nodes(&[r], VIEW);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].text, "");
        assert!(out[0].secure);
        assert_eq!(out[0].hint.as_deref(), Some("Password"));
        let sent = serde_json::to_string(&out).unwrap();
        assert!(!sent.contains("hunter2"));
    }

    #[test]
    fn text_is_cut_at_200_characters_not_bytes() {
        let long = "é".repeat(500);
        let out = filter_nodes(&[raw(&long)], VIEW);
        assert_eq!(out[0].text.chars().count(), 200);
    }

    #[test]
    fn at_most_300_nodes_and_n_points_back_at_the_raw_list() {
        let mut all: Vec<RawNode> = (0..500).map(|i| raw(&format!("row {i}"))).collect();
        all[0].bounds = [0, 0, 0, 0]; // no size: not visible
        all[1].bounds = [5000, 10, 50, 20]; // off screen
        all[2].text = String::new(); // nothing to say and not clickable: noise
        let out = filter_nodes(&all, VIEW);
        assert_eq!(out.len(), MAX_NODES);
        assert_eq!(out[0].n, 3);
        assert_eq!(out[0].text, "row 3");
    }

    #[test]
    fn empty_buttons_and_fields_are_kept_and_false_flags_are_left_out() {
        let mut b = raw("");
        b.role = "button".into();
        b.clickable = true;
        let out = filter_nodes(&[b], VIEW);
        assert_eq!(out.len(), 1);
        let v = serde_json::to_value(&out[0]).unwrap();
        assert_eq!(v, json!({ "n": 0, "role": "button", "text": "", "clickable": true, "bounds": [10, 10, 100, 20] }));
    }

    #[test]
    fn actions_are_parsed_and_junk_is_refused() {
        assert_eq!(parse_action(&json!({ "action": "tap", "n": 4 })), Ok(Action::Tap { n: 4 }));
        assert_eq!(parse_action(&json!({ "action": "tap" })), Err("bad_args"));
        assert_eq!(parse_action(&json!({ "action": "type", "n": 2, "text": "hi" })), Ok(Action::Type { n: Some(2), text: "hi".into() }));
        assert_eq!(parse_action(&json!({ "action": "type", "text": "" })), Err("bad_args"));
        assert_eq!(parse_action(&json!({ "action": "scroll", "dir": "up" })), Ok(Action::Scroll { n: None, dir: Dir::Up }));
        assert_eq!(parse_action(&json!({ "action": "scroll", "dir": "sideways" })), Err("bad_args"));
        assert_eq!(parse_action(&json!({ "action": "back" })), Ok(Action::Back));
        assert_eq!(parse_action(&json!({ "action": "format_disk" })), Err("bad_args"));
        assert_eq!(parse_action(&json!({})), Err("bad_args"));
        assert!(parse_action(&json!({ "action": "key", "key": "enter" })).unwrap().uses_keyboard());
        assert!(!Action::Tap { n: 1 }.uses_keyboard());
    }

    #[test]
    fn keys_are_parsed() {
        assert_eq!(parse_key("Enter"), Some(KeyPress { key: KeyName::Enter, mods: Mods::default() }));
        let k = parse_key("cmd+shift+s").unwrap();
        assert_eq!(k.key, KeyName::Char('s'));
        assert!(k.mods.cmd && k.mods.shift && !k.mods.ctrl);
        assert_eq!(parse_key("a"), None); // plain letters go through "type"
        assert_eq!(parse_key("cmd+a+b"), None);
        assert_eq!(parse_key("launch"), None);
        assert_eq!(parse_key(""), None);
    }

    #[test]
    fn back_off_doubles_from_2_to_30_seconds_and_resets() {
        let mut b = Backoff::new();
        let waits: Vec<u64> = (0..7).map(|_| b.fail()).collect();
        assert_eq!(waits, vec![2, 4, 8, 16, 30, 30, 30]);
        b.ok();
        assert_eq!(b.fail(), 2);
    }

    #[test]
    fn https_only_with_localhost_allowed_in_dev_builds_alone() {
        assert_eq!(check_server("https://jassi.pulin-chaudhari.workers.dev/", false).unwrap(), "https://jassi.pulin-chaudhari.workers.dev");
        assert_eq!(check_server("http://localhost:8799", true).unwrap(), "http://localhost:8799");
        assert_eq!(check_server("http://127.0.0.1:8799/", true).unwrap(), "http://127.0.0.1:8799");
        assert_eq!(check_server("http://localhost:8799", false), Err("https_only"));
        assert_eq!(check_server("http://example.com", true), Err("https_only"));
        assert_eq!(check_server("http://localhost.evil.com", true), Err("https_only"));
        assert_eq!(check_server("ftp://example.com", true), Err("https_only"));
        assert_eq!(check_server("https://user:pw@example.com", false), Err("bad_server"));
        assert_eq!(check_server("not a url", true), Err("bad_server"));
    }

    #[test]
    fn only_the_jassi_origin_gets_the_bridge() {
        let jassi = Url::parse("https://jassi.pulin-chaudhari.workers.dev").unwrap();
        assert!(is_jassi_page("https://jassi.pulin-chaudhari.workers.dev/setup?x=1", &jassi));
        assert!(!is_jassi_page("https://jassi.pulin-chaudhari.workers.dev.evil.com/", &jassi));
        assert!(!is_jassi_page("http://jassi.pulin-chaudhari.workers.dev/", &jassi));
        assert!(!is_jassi_page("https://accounts.google.com/", &jassi));
        assert!(!is_jassi_page("tauri://localhost/index.html", &jassi));
        assert!(!is_jassi_page("about:blank", &jassi));
    }

    #[test]
    fn outside_links_are_web_mail_or_phone_only() {
        assert!(external_ok("https://wa.me/919999999999?text=hi"));
        assert!(external_ok("mailto:someone@example.com"));
        assert!(!external_ok("file:///etc/passwd"));
        assert!(!external_ok("x-apple.systempreferences:com.apple.preference.security"));
        assert!(!external_ok("ms-settings:privacy"));
        assert!(!external_ok("javascript:alert(1)"));
        assert!(!external_ok("nonsense"));
    }

    #[test]
    fn only_auth_links_become_the_auth_event() {
        assert_eq!(auth_link("jassi://auth?code=abc123").as_deref(), Some("jassi://auth?code=abc123"));
        assert_eq!(auth_link("jassi://other?code=abc"), None);
        assert_eq!(auth_link("https://auth?code=abc"), None);
        assert_eq!(auth_link(&format!("jassi://auth?code={}", "x".repeat(3000))), None);
    }

    #[test]
    fn tokens_are_plain_visible_text() {
        assert!(token_ok("eyJhbGciOi.J9-_~+/="));
        assert!(!token_ok(""));
        assert!(!token_ok("abc def"));
        assert!(!token_ok("abc\r\nX-Evil: 1"));
        assert!(!token_ok(&"x".repeat(5000)));
    }

    #[test]
    fn app_ids_are_plain() {
        assert!(app_id_ok("com.apple.TextEdit"));
        assert!(app_id_ok("Microsoft.WindowsCalculator_8wekyb3d8bbwe!App"));
        assert!(app_id_ok("{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\notepad.exe"));
        assert!(!app_id_ok("-a Terminal"));
        assert!(!app_id_ok("com.x; rm -rf ~"));
        assert!(!app_id_ok(""));
    }
}
