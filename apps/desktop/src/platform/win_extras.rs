//! Windows: Windows Hello, speaking (SpeechSynthesizer) and listening (SpeechRecognizer).
//! NOT run on a real PC yet: it compiles against the Windows API, nothing more. See the README.

use super::win::com;
use crate::shell;
use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use windows::core::{factory, Ref, HSTRING};
use windows::Foundation::TypedEventHandler;
use windows::Globalization::Language;
use windows::Media::Core::MediaSource;
use windows::Media::Playback::MediaPlayer;
use windows::Media::SpeechRecognition::{
    SpeechContinuousRecognitionCompletedEventArgs, SpeechContinuousRecognitionResultGeneratedEventArgs, SpeechContinuousRecognitionSession,
    SpeechRecognitionHypothesisGeneratedEventArgs, SpeechRecognitionResultStatus, SpeechRecognizer,
};
use windows::Media::SpeechSynthesis::SpeechSynthesizer;
use windows::Security::Credentials::UI::{UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability};
use windows::Win32::System::WinRT::IUserConsentVerifierInterop;
use windows_future::IAsyncOperation;

type Res<T> = Result<T, &'static str>;

// ---------------------------------------------------------------- Windows Hello

/// Shows the Windows Hello prompt (fingerprint, face, or the PIN the person set up for it) and waits.
pub fn biometric(app: &AppHandle, reason: &str) -> Res<()> {
    com();
    let ready = UserConsentVerifier::CheckAvailabilityAsync().and_then(|op| op.join()).map_err(|_| "unsupported")?;
    if ready != UserConsentVerifierAvailability::Available {
        return Err("unsupported"); // Windows Hello is not set up on this PC
    }
    let window = app.get_webview_window("main").and_then(|w| w.hwnd().ok()).ok_or("failed")?;
    let reason = if reason.trim().is_empty() { "Confirm it's you" } else { reason };
    let prompt = factory::<UserConsentVerifier, IUserConsentVerifierInterop>().map_err(|_| "unsupported")?;
    let asked: IAsyncOperation<UserConsentVerificationResult> =
        unsafe { prompt.RequestVerificationForWindowAsync(window, &HSTRING::from(reason)) }.map_err(|_| "failed")?;
    match asked.join() {
        Ok(UserConsentVerificationResult::Verified) => Ok(()),
        _ => Err("failed"),
    }
}

// ---------------------------------------------------------------- speaking

static PLAYER: Mutex<Option<MediaPlayer>> = Mutex::new(None);

fn hush() {
    if let Some(player) = PLAYER.lock().unwrap().take() {
        let _ = player.Pause();
        let _ = player.Close();
    }
}

fn speak_now(text: &str, lang: &str) -> windows::core::Result<()> {
    let voice = SpeechSynthesizer::new()?;
    let wanted = lang.to_lowercase();
    if let Some(short) = wanted.get(..2) {
        // Prefer an exact match ("en-in"), else any voice of the same language ("en").
        let mut pick = None;
        for v in &SpeechSynthesizer::AllVoices()? {
            let tag = v.Language()?.to_string().to_lowercase();
            if tag == wanted {
                pick = Some(v);
                break;
            }
            if pick.is_none() && tag.starts_with(short) {
                pick = Some(v);
            }
        }
        if let Some(v) = pick {
            voice.SetVoice(&v)?;
        }
    }
    let sound = voice.SynthesizeTextToStreamAsync(&HSTRING::from(text))?.join()?;
    let source = MediaSource::CreateFromStream(&sound, &sound.ContentType()?)?;
    let player = MediaPlayer::new()?;
    player.SetSource(&source)?;
    player.Play()?;
    *PLAYER.lock().unwrap() = Some(player);
    Ok(())
}

pub fn speak(_app: &AppHandle, text: String, lang: String) -> Res<()> {
    com();
    hush();
    speak_now(&text, &lang).map_err(|_| "failed")
}

pub fn speak_stop(_app: &AppHandle) -> Res<()> {
    hush();
    Ok(())
}

// ---------------------------------------------------------------- listening

static LISTENING: Mutex<Option<SpeechRecognizer>> = Mutex::new(None);
/// Counts sessions. A session that a newer `listenStart` has replaced stays silent: its `speech-end`
/// would arrive after the new one began, and the web app would take it as the new one ending.
static SESSION: AtomicU64 = AtomicU64::new(0);

fn listen_now(app: &AppHandle, lang: &str, me: u64) -> windows::core::Result<SpeechRecognizer> {
    let current = move || SESSION.load(Ordering::SeqCst) == me;
    let language = Language::CreateLanguage(&HSTRING::from(if lang.trim().is_empty() { "en-US" } else { lang }))?;
    let recognizer = SpeechRecognizer::Create(&language)?;
    recognizer.CompileConstraintsAsync()?.join()?; // no constraints added = free dictation

    let events = app.clone();
    recognizer.HypothesisGenerated(&TypedEventHandler::new(
        move |_: Ref<SpeechRecognizer>, args: Ref<SpeechRecognitionHypothesisGeneratedEventArgs>| {
            if let (true, Some(args)) = (current(), args.as_ref()) {
                let text = args.Hypothesis()?.Text()?.to_string();
                shell::emit(&events, json!({ "type": "speech", "text": text, "final": false }));
            }
            Ok(())
        },
    ))?;

    let session = recognizer.ContinuousRecognitionSession()?;
    let events = app.clone();
    session.ResultGenerated(&TypedEventHandler::new(
        move |_: Ref<SpeechContinuousRecognitionSession>, args: Ref<SpeechContinuousRecognitionResultGeneratedEventArgs>| {
            if let (true, Some(args)) = (current(), args.as_ref()) {
                let text = args.Result()?.Text()?.to_string();
                shell::emit(&events, json!({ "type": "speech", "text": text, "final": true }));
            }
            Ok(())
        },
    ))?;
    let events = app.clone();
    session.Completed(&TypedEventHandler::new(
        move |_: Ref<SpeechContinuousRecognitionSession>, args: Ref<SpeechContinuousRecognitionCompletedEventArgs>| {
            let failed = args.as_ref().and_then(|a| a.Status().ok()).is_some_and(|s| {
                s != SpeechRecognitionResultStatus::Success && s != SpeechRecognitionResultStatus::UserCanceled
            });
            if !current() {
                return Ok(());
            }
            LISTENING.lock().unwrap().take();
            if failed {
                shell::emit(&events, json!({ "type": "speech-end", "error": "failed" }));
            } else {
                shell::emit(&events, json!({ "type": "speech-end" }));
            }
            Ok(())
        },
    ))?;
    session.StartAsync()?.join()?;
    Ok(recognizer)
}

/// Starts native speech-to-text. Words arrive as `speech` events, then one `speech-end`.
pub fn listen_start(app: &AppHandle, lang: String) -> Res<()> {
    com();
    if super::win::mic_state() == "denied" {
        return Err("no_permission");
    }
    let me = SESSION.fetch_add(1, Ordering::SeqCst) + 1; // from here on the old session is silent
    let _ = listen_stop(app);
    let recognizer = listen_now(app, &lang, me).map_err(|_| "unavailable")?;
    *LISTENING.lock().unwrap() = Some(recognizer);
    Ok(())
}

/// Stops listening. Windows then reports the session as completed, which sends `speech-end`.
pub fn listen_stop(_app: &AppHandle) -> Res<()> {
    com();
    let current = LISTENING.lock().unwrap().clone();
    if let Some(recognizer) = current {
        let _ = recognizer.ContinuousRecognitionSession().and_then(|s| s.StopAsync()).and_then(|op| op.join());
    }
    Ok(())
}
