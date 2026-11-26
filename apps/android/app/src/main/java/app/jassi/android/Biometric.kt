package app.jassi.android

import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity

/** biometric({ reason }): the real fingerprint / face prompt from Android. */
object Biometric {
    private const val ALLOWED = BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.BIOMETRIC_WEAK

    fun ask(activity: FragmentActivity, reason: String, done: Reply) {
        when (BiometricManager.from(activity).canAuthenticate(ALLOWED)) {
            BiometricManager.BIOMETRIC_SUCCESS -> {}
            BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> return done(fail("not_set_up"))   // no fingerprint or face saved on this phone
            else -> return done(fail("unsupported"))
        }
        val prompt = BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) = done(ok())

            override fun onAuthenticationError(code: Int, message: CharSequence) {
                val cancelled = code == BiometricPrompt.ERROR_USER_CANCELED || code == BiometricPrompt.ERROR_NEGATIVE_BUTTON ||
                    code == BiometricPrompt.ERROR_CANCELED
                done(fail(if (cancelled) "cancelled" else "failed"))
            }
        })
        prompt.authenticate(
            BiometricPrompt.PromptInfo.Builder()
                .setTitle(activity.getString(R.string.app_name))
                .setSubtitle(reason.trim().take(120).ifEmpty { activity.getString(R.string.confirm_its_you) })
                .setNegativeButtonText(activity.getString(R.string.cancel))
                .setAllowedAuthenticators(ALLOWED)
                .build()
        )
    }
}
