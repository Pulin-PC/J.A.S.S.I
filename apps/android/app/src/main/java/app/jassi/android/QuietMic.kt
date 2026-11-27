package app.jassi.android

/** The rules for the always-on (hands-free) microphone, as plain logic. */
object QuietMic {
    // SpeechRecognizer error numbers (kept as numbers so this runs in plain unit tests)
    private const val SPEECH_TIMEOUT = 6
    private const val NO_MATCH = 7
    private const val LANGUAGE_NOT_SUPPORTED = 12
    private const val LANGUAGE_UNAVAILABLE = 13

    /** A session that ended sooner than this is not restarted here: the page backs off instead of us spinning. */
    const val MIN_SESSION_MS = 1_500L

    /** Silence only: open the next session ourselves, so the page keeps one long, unbroken session. */
    fun restartsQuietly(error: Int, heardWords: Boolean, sessionMs: Long) =
        !heardWords && sessionMs >= MIN_SESSION_MS && (error == SPEECH_TIMEOUT || error == NO_MATCH)

    fun languageMissing(error: Int) = error == LANGUAGE_NOT_SUPPORTED || error == LANGUAGE_UNAVAILABLE
}
