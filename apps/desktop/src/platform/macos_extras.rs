//! macOS: Touch ID, speaking (AVSpeechSynthesizer) and listening (Apple Speech + the microphone).

use crate::shell;
use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::Bool;
use objc2::AnyThread;
use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};
use objc2_avf_audio::{
    AVAudioEngine, AVAudioInputNode, AVAudioPCMBuffer, AVAudioTime, AVSpeechBoundary, AVSpeechSynthesisVoice, AVSpeechSynthesizer,
    AVSpeechUtterance,
};
use objc2_foundation::{NSBundle, NSError, NSLocale, NSString};
use objc2_local_authentication::{LAContext, LAPolicy};
use objc2_speech::{
    SFSpeechAudioBufferRecognitionRequest, SFSpeechRecognitionResult, SFSpeechRecognitionTask, SFSpeechRecognizer,
    SFSpeechRecognizerAuthorizationStatus,
};
use serde_json::json;
use std::process::Command;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::Duration;
use tauri::AppHandle;

type Res<T> = Result<T, &'static str>;

// ---------------------------------------------------------------- Touch ID

/// Shows the system's Touch ID sheet and waits for the finger. Fingerprint only: no password fallback.
pub fn biometric(_app: &AppHandle, reason: &str) -> Res<()> {
    let policy = LAPolicy::DeviceOwnerAuthenticationWithBiometrics;
    let context = unsafe { LAContext::new() };
    if unsafe { context.canEvaluatePolicy_error(policy) }.is_err() {
        return Err("unsupported"); // no Touch ID on this Mac, none enrolled, or the lid is closed
    }
    let reason = if reason.trim().is_empty() { "confirm it's you" } else { reason };
    let (tx, rx) = mpsc::channel();
    let reply = RcBlock::new(move |ok: Bool, _error: *mut NSError| {
        let _ = tx.send(ok.as_bool());
    });
    unsafe { context.evaluatePolicy_localizedReason_reply(policy, &NSString::from_str(reason), &reply) };
    match rx.recv_timeout(Duration::from_secs(60)) {
        Ok(true) => Ok(()),
        Ok(false) => Err("failed"),
        Err(_) => {
            unsafe { context.invalidate() };
            Err("timeout")
        }
    }
}

// ---------------------------------------------------------------- permissions: microphone, speech

/// Asking for the microphone or speech without these lines in Info.plist makes macOS end the app.
fn has_usage_text(key: &str) -> bool {
    NSBundle::mainBundle().objectForInfoDictionaryKey(&NSString::from_str(key)).is_some()
}

pub fn mic_state() -> &'static str {
    let Some(audio) = (unsafe { AVMediaTypeAudio }) else { return "unsupported" };
    let status = unsafe { AVCaptureDevice::authorizationStatusForMediaType(audio) };
    if status == AVAuthorizationStatus::Authorized {
        "granted"
    } else if status == AVAuthorizationStatus::NotDetermined {
        "ask"
    } else {
        "denied"
    }
}

pub fn speech_state() -> &'static str {
    let status = unsafe { SFSpeechRecognizer::authorizationStatus() };
    if status == SFSpeechRecognizerAuthorizationStatus::Authorized {
        "granted"
    } else if status == SFSpeechRecognizerAuthorizationStatus::NotDetermined {
        "ask"
    } else {
        "denied"
    }
}

fn open_settings(pane: &str) {
    let _ = Command::new("/usr/bin/open").arg(pane).status();
}

pub fn open_mic_permission() -> bool {
    match mic_state() {
        "ask" if has_usage_text("NSMicrophoneUsageDescription") => {
            let Some(audio) = (unsafe { AVMediaTypeAudio }) else { return false };
            let done = RcBlock::new(|_granted: Bool| {});
            unsafe { AVCaptureDevice::requestAccessForMediaType_completionHandler(audio, &done) };
        }
        "denied" => open_settings("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"),
        "granted" => {}
        _ => return false,
    }
    true
}

pub fn open_speech_permission() -> bool {
    match speech_state() {
        "ask" if has_usage_text("NSSpeechRecognitionUsageDescription") => {
            let done = RcBlock::new(|_status: SFSpeechRecognizerAuthorizationStatus| {});
            unsafe { SFSpeechRecognizer::requestAuthorization(&done) };
        }
        "denied" => open_settings("x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition"),
        "granted" => {}
        _ => return false,
    }
    true
}

// ---------------------------------------------------------------- speaking

thread_local! {
    // Only ever touched on the main thread.
    static VOICE: Retained<AVSpeechSynthesizer> = unsafe { AVSpeechSynthesizer::new() };
}

pub fn speak(app: &AppHandle, text: String, lang: String) -> Res<()> {
    app.run_on_main_thread(move || {
        VOICE.with(|voice| unsafe {
            voice.stopSpeakingAtBoundary(AVSpeechBoundary::Immediate);
            let words = AVSpeechUtterance::speechUtteranceWithString(&NSString::from_str(&text));
            if !lang.is_empty() {
                if let Some(v) = AVSpeechSynthesisVoice::voiceWithLanguage(Some(&NSString::from_str(&lang))) {
                    words.setVoice(Some(&v));
                }
            }
            voice.speakUtterance(&words);
        });
    })
    .map_err(|_| "failed")
}

pub fn speak_stop(app: &AppHandle) -> Res<()> {
    app.run_on_main_thread(|| {
        VOICE.with(|voice| unsafe {
            voice.stopSpeakingAtBoundary(AVSpeechBoundary::Immediate);
        });
    })
    .map_err(|_| "failed")
}

// ---------------------------------------------------------------- listening

/// One listening session. Created, used and dropped on the main thread only.
struct Listening {
    id: u64,
    engine: Retained<AVAudioEngine>,
    input: Retained<AVAudioInputNode>,
    request: Retained<SFSpeechAudioBufferRecognitionRequest>,
    task: Retained<SFSpeechRecognitionTask>,
    _recognizer: Retained<SFSpeechRecognizer>,
    /// The user asked to stop: an "error" after this is just the recogniser closing, not a failure.
    stopping: bool,
}
struct MainOnly(Listening);
unsafe impl Send for MainOnly {}

static LISTENING: Mutex<Option<MainOnly>> = Mutex::new(None);
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn hang_up(l: &Listening) {
    unsafe {
        l.engine.stop();
        l.input.removeTapOnBus(0);
        l.request.endAudio();
    }
}

/// Ends session `id` (if it is still the current one) and tells the web app: `speech-end`.
fn end(app: &AppHandle, id: u64, error: Option<&str>) {
    end_session(app, id, error, true)
}

/// `announce: false` when a new `listenStart` replaces this session: a `speech-end` for the old
/// one would arrive after the new one began, and the web app would take it as the new one ending.
fn end_session(app: &AppHandle, id: u64, error: Option<&str>, announce: bool) {
    let ended = {
        let mut current = LISTENING.lock().unwrap();
        if current.as_ref().is_some_and(|l| l.0.id == id) {
            current.take()
        } else {
            None
        }
    };
    let Some(MainOnly(l)) = ended else { return };
    hang_up(&l);
    unsafe { l.task.cancel() };
    if !announce {
        return;
    }
    let error = if l.stopping { None } else { error };
    match error {
        Some(e) => shell::emit(app, json!({ "type": "speech-end", "error": e })),
        None => shell::emit(app, json!({ "type": "speech-end" })),
    }
}

fn start_on_main(app: AppHandle, lang: String) -> Res<()> {
    unsafe {
        let lang = if lang.trim().is_empty() { "en-US".to_string() } else { lang };
        let locale = NSLocale::localeWithLocaleIdentifier(&NSString::from_str(&lang));
        let recognizer = SFSpeechRecognizer::initWithLocale(SFSpeechRecognizer::alloc(), &locale).ok_or("unsupported")?;
        if !recognizer.isAvailable() {
            return Err("unavailable");
        }
        let request = SFSpeechAudioBufferRecognitionRequest::new();
        request.setShouldReportPartialResults(true);

        let engine = AVAudioEngine::new();
        let input = engine.inputNode();
        let format = input.outputFormatForBus(0);
        if format.sampleRate() == 0.0 || format.channelCount() == 0 {
            return Err("no_microphone");
        }
        let feed = request.clone();
        let tap = RcBlock::new(move |buffer: NonNull<AVAudioPCMBuffer>, _when: NonNull<AVAudioTime>| {
            feed.appendAudioPCMBuffer(buffer.as_ref());
        });
        input.installTapOnBus_bufferSize_format_block(0, 1024, Some(&format), &*tap as *const _ as *mut _);
        engine.prepare();
        if engine.startAndReturnError().is_err() {
            input.removeTapOnBus(0);
            return Err("no_microphone");
        }

        let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
        let events = app.clone();
        let on_result = RcBlock::new(move |result: *mut SFSpeechRecognitionResult, error: *mut NSError| {
            match result.as_ref() {
                Some(result) => {
                    let current = LISTENING.lock().unwrap().as_ref().is_some_and(|l| l.0.id == id);
                    let last = result.isFinal();
                    if current {
                        let text = result.bestTranscription().formattedString().to_string();
                        shell::emit(&events, json!({ "type": "speech", "text": text, "final": last }));
                    }
                    if last {
                        end(&events, id, None);
                    }
                }
                None => end(&events, id, if error.is_null() { None } else { Some("failed") }),
            }
        });
        let task = recognizer.recognitionTaskWithRequest_resultHandler(&request, &on_result);
        *LISTENING.lock().unwrap() = Some(MainOnly(Listening { id, engine, input, request, task, _recognizer: recognizer, stopping: false }));
        Ok(())
    }
}

/// Starts native speech-to-text. Words arrive as `speech` events, then one `speech-end`.
pub fn listen_start(app: &AppHandle, lang: String) -> Res<()> {
    if mic_state() != "granted" || speech_state() != "granted" {
        return Err("no_permission");
    }
    let (tx, rx) = mpsc::channel();
    let on_main = app.clone();
    app.run_on_main_thread(move || {
        let old = LISTENING.lock().unwrap().as_ref().map(|l| l.0.id);
        if let Some(old) = old {
            end_session(&on_main, old, None, false);
        }
        let _ = tx.send(start_on_main(on_main.clone(), lang));
    })
    .map_err(|_| "failed")?;
    rx.recv_timeout(Duration::from_secs(5)).map_err(|_| "failed")?
}

/// Stops listening. The words heard so far still arrive as a last `speech` event, then `speech-end`.
pub fn listen_stop(app: &AppHandle) -> Res<()> {
    let on_main = app.clone();
    app.run_on_main_thread(move || {
        let id = {
            let mut current = LISTENING.lock().unwrap();
            let Some(l) = current.as_mut() else { return };
            l.0.stopping = true;
            hang_up(&l.0);
            unsafe { l.0.task.finish() };
            l.0.id
        };
        // If the recogniser never answers, close the session anyway.
        let later = on_main.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(2));
            let again = later.clone();
            let _ = later.run_on_main_thread(move || end(&again, id, None));
        });
    })
    .map_err(|_| "failed")
}
