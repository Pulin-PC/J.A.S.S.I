//! The device channel (docs/native-contract.md §4): a long-poll loop in native code, so screen
//! control keeps working while another app is in front. The token is sent as a header and never logged.

use crate::policy::Backoff;
use crate::shell::{self, Shell};
use crate::store::Pairing;
use crate::{http, ops};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::{AppHandle, Manager};

#[derive(Deserialize)]
struct Job {
    id: String,
    op: String,
    #[serde(default)]
    args: Value,
}

/// Starts the loop for this pairing. Any loop already running stops.
pub fn start(app: &AppHandle, pairing: Pairing) {
    let me = app.state::<Shell>().channel.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    let _ = std::thread::Builder::new().name("jassi-channel".into()).spawn(move || run(app, pairing, me));
}

pub fn stop(app: &AppHandle) {
    app.state::<Shell>().channel.fetch_add(1, Ordering::SeqCst);
}

fn run(app: AppHandle, pairing: Pairing, me: u64) {
    let live = || app.state::<Shell>().channel.load(Ordering::SeqCst) == me;
    let nap = |secs: u64| {
        for _ in 0..secs * 10 {
            if !live() {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    };
    let agent = http::agent(40); // longer than the 25 s the server may hold a request
    let next = format!("{}/api/device/next?wait=25", pairing.server);
    let result = format!("{}/api/device/result", pairing.server);
    let auth = format!("Bearer {}", pairing.token);
    let mut backoff = Backoff::new();

    while live() {
        let job: Job = match agent.get(&next).set("Authorization", &auth).call() {
            Ok(resp) if resp.status() == 200 => {
                backoff.ok();
                match resp.into_json() {
                    Ok(job) => job,
                    Err(_) => continue,
                }
            }
            Ok(_) => {
                backoff.ok(); // 204: nothing to do, ask again
                continue;
            }
            Err(ureq::Error::Status(401, _)) => return shell::forget(&app),
            Err(_) => {
                nap(backoff.fail());
                continue;
            }
        };
        if !live() {
            return; // unpaired while waiting: do not run it
        }

        let body = match ops::run(&app, &job.op, &job.args) {
            Ok(data) => json!({ "id": job.id, "ok": true, "data": data }),
            Err(error) => json!({ "id": job.id, "ok": false, "error": error }),
        };
        // One retry: a lost answer would leave the server waiting.
        for attempt in 0..2 {
            match agent.post(&result).set("Authorization", &auth).send_json(&body) {
                Ok(_) => break,
                Err(ureq::Error::Status(401, _)) => return shell::forget(&app),
                Err(_) if attempt == 0 => nap(1),
                Err(_) => nap(backoff.fail()),
            }
        }
    }
}
