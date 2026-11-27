package app.jassi.android

import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
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
    private var handsFree = false
    private val missing = mutableSetOf<String>()   // languages the on-device recogniser doesn't have
    @Volatile private var tts: TextToSpeech? = null
    private var ttsReady = false
    private val ttsThread = Executors.newSingleThreadExecutor()   // the speech engine can be slow to answer: keep it off the main thread
    private var afterTtsReady: (() -> Unit)? = null

    // ── listening ───────────────────────────────────────────────────────────────────────────

    /**
     * [onDevice] is hands-free: the page keeps the microphone open and waits for "Jassi". It only ever uses the
     * phone's own recogniser (no audio leaves the phone, and it does not beep on every start like the other one),
     * and a foreground service holds the microphone so it works behind other apps.
     */
    fun listenStart(lang: String?, onDevice: Boolean = false): JSONObject {
        if (!activity.hasMic()) return fail("permission")
        if (onDevice) {
            if (Presence.off) return fail("stopped")
            if (Build.VERSION.SDK_INT < 31 || !SpeechRecognizer.isOnDeviceRecognitionAvailable(activity)) return fail("unsupported")
            Presence.listen(activity)
        } else if (!SpeechRecognizer.isRecognitionAvailable(activity)) {
            return fail("unsupported")
        }
        handsFree = onDevice
        start(lang ?: DEFAULT_LANG)
        return ok()
    }

    private fun start(lang: String) {
        recognizer?.destroy()
        val quiet = handsFree
        val r = if (quiet && Build.VERSION.SDK_INT >= 31) SpeechRecognizer.createOnDeviceSpeechRecognizer(activity.applicationContext)
        else SpeechRecognizer.createSpeechRecognizer(activity)
        recognizer = r
        val spoken = if (quiet && lang in missing) FALLBACK_LANG else lang
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE, spoken)
            .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        if (quiet) intent.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
        val began = SystemClock.elapsedRealtime()
        r.setRecognitionListener(object : RecognitionListener {
            private var any = false

            override fun onPartialResults(partial: Bundle?) {
                words(partial)?.let { any = true; heard(it, final = false) }
            }

            override fun onResults(results: Bundle?) {
                words(results)?.let { heard(it, final = true) }
                ended(r, null)
            }

            override fun onError(error: Int) {
                if (recognizer !== r) return
                if (quiet && QuietMic.languageMissing(error) && spoken != FALLBACK_LANG) {
                    // ask the phone to fetch the language for next time, and listen in English meanwhile
                    if (Build.VERSION.SDK_INT >= 33) r.triggerModelDownload(intent)
                    missing.add(lang)
                    start(lang)
                } else if (quiet && QuietMic.restartsQuietly(error, any, SystemClock.elapsedRealtime() - began)) {
                    start(lang)
                } else {
                    ended(r, reason(error))
                }
            }

            override fun onReadyForSpeech(params: Bundle?) {}
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onEvent(eventType: Int, params: Bundle?) {}
        })
        r.startListening(intent)
    }

    /** Stops the microphone; the words heard so far still arrive as a final `speech` event. */
    fun listenStop(): JSONObject {
        // Hands-free stops at once and silently, so nothing late can end the session the page opens next.
        if (handsFree) cancel() else recognizer?.stopListening()
        return ok()
    }

    fun cancel() {
        recognizer?.destroy()
        recognizer = null
    }

    /** Stops now and tells the page the session is over. */
    fun end() {
        recognizer?.let { ended(it, null) }
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
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "permission"
        SpeechRecognizer.ERROR_AUDIO -> "audio"
        else -> "failed"
    }

    // ── speaking ────────────────────────────────────────────────────────────────────────────

    fun speak(text: String, lang: String?, done: Reply) {
        if (text.isBlank()) return done(fail("bad_args"))
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
        cancel()
        val engine = tts
        tts = null
        ttsReady = false
        ttsThread.execute { engine?.shutdown() }
    }

    private companion object {
        const val DEFAULT_LANG = "en-IN"
        const val FALLBACK_LANG = "en-US"
    }
}
