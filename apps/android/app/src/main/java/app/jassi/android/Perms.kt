package app.jassi.android

import android.Manifest
import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.speech.SpeechRecognizer
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject

/** Permission states for the bridge: "granted" | "denied" | "ask" | "unsupported". */
object Perms {
    private const val SCREEN_SERVICE = "app.jassi.android.ScreenService"

    fun snapshot(activity: Activity): JSONObject = JSONObject()
        .put("screen", if (screenOn(activity)) "granted" else "ask")
        .put("mic", mic(activity))
        .put("speech", if (SpeechRecognizer.isRecognitionAvailable(activity)) mic(activity) else "unsupported")
        .put("notifications", notifications(activity))

    /** True when the user has switched on J.A.S.S.I under Accessibility. */
    fun screenOn(context: Context): Boolean {
        val me = ComponentName(context.packageName, SCREEN_SERVICE)
        val on = Settings.Secure.getString(context.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES).orEmpty()
        return on.split(':').any { ComponentName.unflattenFromString(it) == me }
    }

    fun mic(activity: Activity) = runtime(activity, Manifest.permission.RECORD_AUDIO, "asked_mic")

    fun notifications(activity: Activity): String = when {
        Build.VERSION.SDK_INT >= 33 -> runtime(activity, Manifest.permission.POST_NOTIFICATIONS, "asked_notifications")
        NotificationManagerCompat.from(activity).areNotificationsEnabled() -> "granted"
        else -> "denied"
    }

    fun markAsked(context: Context, key: String) = Vault.prefs(context).edit().putBoolean(key, true).apply()

    private fun runtime(activity: Activity, permission: String, askedKey: String): String = when {
        ContextCompat.checkSelfPermission(activity, permission) == PackageManager.PERMISSION_GRANTED -> "granted"
        // Asked before, and Android will not show the prompt again: only Settings can change it now.
        Vault.prefs(activity).getBoolean(askedKey, false) && !activity.shouldShowRequestPermissionRationale(permission) -> "denied"
        else -> "ask"
    }

    /** Opens Accessibility settings as close to the J.A.S.S.I entry as this Android allows. */
    fun openScreenSettings(context: Context): Boolean {
        val me = ComponentName(context.packageName, SCREEN_SERVICE).flattenToString()
        val ourPage = Intent("android.settings.ACCESSIBILITY_DETAILS_SETTINGS").putExtra(Intent.EXTRA_COMPONENT_NAME, me)
        val list = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)   // fall back to the list, with our row highlighted
            .putExtra(":settings:fragment_args_key", me)
            .putExtra(":settings:show_fragment_args", Bundle().apply { putString(":settings:fragment_args_key", me) })
        return start(context, ourPage) || start(context, list)
    }

    fun openAppSettings(context: Context) =
        start(context, Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null)))

    fun openNotificationSettings(context: Context) =
        start(context, Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName))

    private fun start(context: Context, intent: Intent): Boolean = try {
        context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        true
    } catch (_: Exception) {
        false
    }
}
