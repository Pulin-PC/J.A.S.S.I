package app.jassi.android

import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import org.json.JSONObject
import java.util.Locale
import java.util.concurrent.Executors

/** listenStart / listenStop (speech-to-text with partial results) and speak / speakStop (text-to-speech). */
class Voice(private val activity: MainActivity) {
    private var recognizer: SpeechRecognizer? = null
    @Volatile private var tts: TextToSpeech? = null
    private var ttsReady = false
    private val ttsThread = Executors.newSingleThreadExecutor()   // the speech engine can be slow to answer: keep it off the main thread
    private var afterTtsReady: (() -> Unit)? = null

    // ── listening ───────────────────────────────────────────────────────────────────────────

    fun listenStart(lang: String?): JSONObject {
        if (!SpeechRecognizer.isRecognitionAvailable(activity)) return fail("unsupported")
        if (!activity.hasMic()) return fail("mic_not_allowed")
        recognizer?.destroy()
        val r = SpeechRecognizer.createSpeechRecognizer(activity)
        recognizer = r
        r.setRecognitionListener(object : RecognitionListener {
            override fun onPartialResults(partial: Bundle?) {
                words(partial)?.let { heard(it, final = false) }
            }

            override fun onResults(results: Bundle?) {
                words(results)?.let { heard(it, final = true) }
                ended(r, null)
            }

            override fun onError(error: Int) = ended(r, reason(error))
            override fun onReadyForSpeech(params: Bundle?) {}
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onEvent(eventType: Int, params: Bundle?) {}
        })
        r.startListening(
            Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang ?: DEFAULT_LANG)
                .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        )
        return ok()
    }

    /** Stops the microphone; the words heard so far still arrive as a final `speech` event. */
    fun listenStop(): JSONObject {
        recognizer?.stopListening()
        return ok()
    }

    private fun words(bundle: Bundle?): String? =
        bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.takeIf { it.isNotBlank() }

    private fun heard(text: String, final: Boolean) =
        activity.bridge.event(JSONObject().put("type", "speech").put("text", text).put("final", final))

    private fun ended(r: SpeechRecognizer, error: String?) {
        if (recognizer !== r) return
        recognizer = null
        r.destroy()
        val event = JSONObject().put("type", "speech-end")
        if (error != null) event.put("error", error)
        activity.bridge.event(event)
    }

    private fun reason(error: Int): String = when (error) {
        SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "no_speech"
        SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT, SpeechRecognizer.ERROR_SERVER -> "network"
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "mic_not_allowed"
        SpeechRecognizer.ERROR_AUDIO -> "audio"
        else -> "failed"
    }

    // ── speaking ────────────────────────────────────────────────────────────────────────────

    fun speak(text: String, lang: String?, done: Reply) {
        if (text.isBlank()) return done(fail("bad_request"))
        val say = { ttsThread.execute { done(say(text, lang)) } }
        when {
            ttsReady -> say()
            tts != null -> afterTtsReady = say   // still starting: say the newest request once it is ready
            else -> {
                afterTtsReady = say
                tts = TextToSpeech(activity) { status ->
                    ttsReady = status == TextToSpeech.SUCCESS
                    val waiting = afterTtsReady
                    afterTtsReady = null
                    if (ttsReady) waiting?.invoke() else {
                        tts = null
                        done(fail("unsupported"))
                    }
                }
            }
        }
    }

    private fun say(text: String, lang: String?): JSONObject {
        val engine = tts ?: return fail("unsupported")
        if (engine.setLanguage(Locale.forLanguageTag(lang ?: DEFAULT_LANG)) < TextToSpeech.LANG_AVAILABLE) {
            engine.setLanguage(Locale.getDefault())
        }
        val started = engine.speak(text.take(TextToSpeech.getMaxSpeechInputLength()), TextToSpeech.QUEUE_FLUSH, null, "jassi")
        return if (started == TextToSpeech.SUCCESS) ok() else fail("failed")
    }

    fun speakStop(): JSONObject {
        ttsThread.execute { tts?.stop() }
        return ok()
    }

    fun shutDown() {
        recognizer?.destroy()
        recognizer = null
        val engine = tts
        tts = null
        ttsReady = false
        ttsThread.execute { engine?.shutdown() }
    }

    private companion object {
        const val DEFAULT_LANG = "en-IN"
    }
}
