//! Runs one device-channel op under the safety rules of docs/native-contract.md §4:
//! locked apps, secure fields and protected screens are refused; the "J.A.S.S.I is working · Stop"
//! banner is up while it runs; Stop, the stop shortcut, or the user touching the mouse or keyboard
//! cancels at once; one op at a time, 15 seconds at most. Nothing read from the screen is stored or logged.

use crate::policy::{self, Policy};
use crate::shell::{self, Shell};
use crate::{banner, config, platform};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

/// Shared by the channel, the banner, the stop shortcut and `jassiNative.stop()`.
#[derive(Default)]
pub struct Control {
    cancel: Mutex<Option<Arc<AtomicBool>>>,
    /// After the user says Stop, ops are refused for a moment so a queued action cannot slip through.
    hold_until: Mutex<Option<Instant>>,
    told: Mutex<Option<Instant>>,
}

impl Control {
    fn holding(&self) -> bool {
        self.hold_until.lock().unwrap().is_some_and(|t| Instant::now() < t)
    }
}

/// Stop now. `tell_web` = the user did it (banner or shortcut), so the web app gets the `stopped` event.
pub fn user_stop(app: &AppHandle, tell_web: bool) {
    let control = &app.state::<Shell>().control;
    *control.hold_until.lock().unwrap() = Some(Instant::now() + Duration::from_secs(2));
    if let Some(cancel) = control.cancel.lock().unwrap().as_ref() {
        cancel.store(true, Ordering::SeqCst);
    }
    banner::hide(app);
    if tell_web {
        tell_stopped(app);
    }
}

/// Shell → web: `{ type: "stopped", by: "user" }`. Once per stop, even if the user both moved the mouse and pressed Stop.
fn tell_stopped(app: &AppHandle) {
    let control = &app.state::<Shell>().control;
    {
        let mut last = control.told.lock().unwrap();
        if last.is_some_and(|t| t.elapsed() < Duration::from_millis(1500)) {
            return;
        }
        *last = Some(Instant::now());
    }
    shell::emit(app, json!({ "type": "stopped", "by": "user" }));
}

pub fn run(app: &AppHandle, op: &str, args: &Value) -> Result<Value, String> {
    if op == "list_apps" {
        return Ok(json!({ "ok": true, "apps": platform::list_apps(), "partial": false }));
    }
    // "dev_wait" exists in dev builds only: an op that never finishes, to show the 15 second limit.
    if !(matches!(op, "screen_read" | "screen_act" | "open_app") || (config::DEV && op == "dev_wait")) {
        return Err("unknown_op".into());
    }
    let shell = app.state::<Shell>();
    let control = &shell.control;
    // Rule 5: only while paired, with the screen permission granted.
    if !*shell.paired.lock().unwrap() {
        return Err("not_paired".into());
    }
    if platform::screen_state() != "granted" {
        return Err("no_permission".into());
    }
    if control.holding() {
        return Err("stopped".into());
    }

    let cancel = Arc::new(AtomicBool::new(false));
    *control.cancel.lock().unwrap() = Some(cancel.clone());
    banner::show(app);

    let policy = shell.policy.read().unwrap().clone();
    let (tx, rx) = mpsc::channel();
    let worker = {
        let (op, args, cancel) = (op.to_string(), args.clone(), cancel.clone());
        std::thread::spawn(move || {
            let _ = tx.send(exec(&op, &args, &policy, &cancel));
        })
    };

    let started = Instant::now();
    let watch = platform::InputWatch::start();
    let out = loop {
        match rx.recv_timeout(Duration::from_millis(15)) {
            Ok(out) => break out.map_err(String::from),
            Err(RecvTimeoutError::Disconnected) => break Err("failed".to_string()),
            Err(RecvTimeoutError::Timeout) => {}
        }
        if cancel.load(Ordering::SeqCst) {
            break Err("stopped".into()); // Stop button, shortcut or jassiNative.stop()
        }
        if watch.user_acted() {
            cancel.store(true, Ordering::SeqCst);
            tell_stopped(app);
            break Err("stopped".into());
        }
        if started.elapsed() >= Duration::from_secs(policy::OP_LIMIT_SECS) {
            cancel.store(true, Ordering::SeqCst);
            break Err("timeout".into());
        }
    };
    // One op at a time: the next one waits until this one has really let go.
    let _ = worker.join();
    *control.cancel.lock().unwrap() = None;
    banner::hide_soon(app);
    out
}

fn exec(op: &str, args: &Value, policy: &Policy, cancel: &AtomicBool) -> Result<Value, &'static str> {
    match op {
        "screen_read" => {
            let front = platform::front_app().ok_or("failed")?;
            if policy.is_blocked(&front.app.id) {
                platform::forget_screen();
                return Ok(json!({ "app": front.app, "nodes": [], "blocked": true }));
            }
            let (raw, view) = platform::read_screen(&front, cancel)?;
            Ok(json!({ "app": front.app, "nodes": policy::filter_nodes(&raw, view) }))
        }
        "screen_act" => {
            let action = policy::parse_action(args)?;
            let front = platform::front_app().ok_or("failed")?;
            let secure = match &action {
                policy::Action::Type { n: Some(n), .. } => platform::node_is_secure(&front, *n),
                a if a.uses_keyboard() => platform::focused_is_secure(),
                _ => false,
            };
            policy::check_act(policy, &front, action.uses_keyboard(), secure).map_err(|r| r.code())?;
            platform::act(&front, &action, cancel)?;
            Ok(json!({ "done": true }))
        }
        "open_app" => {
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("").trim().to_lowercase();
            if !policy::app_id_ok(&id) {
                return Err("bad_args");
            }
            if policy.is_blocked(&id) {
                return Err("blocked_app");
            }
            platform::open_app(&id, cancel)?;
            Ok(json!({ "done": true }))
        }
        "dev_wait" => {
            while !cancel.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(50));
            }
            Err("stopped")
        }
        _ => Err("unknown_op"),
    }
}
