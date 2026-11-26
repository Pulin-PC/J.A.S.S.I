import AVFoundation
import Speech
import JassiCore

/// Speech-to-text: `listenStart` / `listenStop`. Sends `speech` events as words arrive, then `speech-end`.
@MainActor
final class Listener {
    private let emit: (NativeEvent) -> Void
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var heard = ""
    private var sentFinal = false

    var isListening: Bool { request != nil }

    init(emit: @escaping (NativeEvent) -> Void) {
        self.emit = emit
    }

    func start(lang: String) -> [String: Any] {
        finish(error: nil)
        guard Permissions.mic == .granted, Permissions.speech == .granted else { return BridgeReply.fail("permission") }
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: lang)), recognizer.isAvailable else {
            return BridgeReply.unsupported
        }

        let audio = AVAudioSession.sharedInstance()
        do {
            try audio.setCategory(.playAndRecord, mode: .measurement, options: [.duckOthers, .defaultToSpeaker])
            try audio.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            return BridgeReply.fail("failed")
        }
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { // no microphone to read from
            try? audio.setActive(false, options: .notifyOthersOnDeactivation)
            return BridgeReply.unsupported
        }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            try? audio.setActive(false, options: .notifyOthersOnDeactivation)
            return BridgeReply.fail("failed")
        }

        self.request = request
        heard = ""
        sentFinal = false
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            let text = result?.bestTranscription.formattedString
            let isFinal = result?.isFinal ?? false
            let failed = error != nil
            Task { @MainActor in
                guard let self, self.request === request else { return } // an older session: ignore
                if let text {
                    self.heard = text
                    self.sentFinal = isFinal
                    self.emit(.speech(text: text, final: isFinal))
                }
                if isFinal {
                    self.finish(error: nil)
                } else if failed {
                    self.finish(error: "failed")
                }
            }
        }
        return BridgeReply.ok
    }

    func stop() -> [String: Any] {
        finish(error: nil)
        return BridgeReply.ok
    }

    /// Ends the session, if one is running: the words so far become final, then `speech-end`.
    private func finish(error: String?) {
        guard let request else { return }
        self.request = nil
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        request.endAudio()
        task?.cancel()
        task = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        if error == nil, !sentFinal, !heard.isEmpty {
            emit(.speech(text: heard, final: true))
        }
        emit(.speechEnd(error: error))
    }
}

/// Text-to-speech: `speak` / `speakStop`.
@MainActor
final class Speaker {
    private let voice = AVSpeechSynthesizer()

    /// `whileListening`: the microphone session is in charge of the audio, so leave it alone.
    func speak(text: String, lang: String, whileListening: Bool) -> [String: Any] {
        voice.stopSpeaking(at: .immediate)
        if !whileListening {
            // Speak even when the ring switch is on silent: the user asked to hear the answer.
            try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio, options: .duckOthers)
        }
        let line = AVSpeechUtterance(string: text)
        line.voice = AVSpeechSynthesisVoice(language: lang) ?? AVSpeechSynthesisVoice(language: BridgeDefaults.lang)
        voice.speak(line)
        return BridgeReply.ok
    }

    func stop() -> [String: Any] {
        voice.stopSpeaking(at: .immediate)
        return BridgeReply.ok
    }
}
