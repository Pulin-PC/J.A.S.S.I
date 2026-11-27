package app.jassi.android

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.content.res.Configuration
import android.os.Build
import android.os.IBinder
import android.provider.Settings
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject

/**
 * What the page wants J.A.S.S.I to be while the user is in other apps: a bubble on screen, and / or the
 * microphone held for hands-free. [PresenceService] makes it so. Main thread only.
 */
object Presence {
    private val STATES = setOf("sleep", "listening", "thinking", "speaking")

    var bubble = false
        private set
    var mic = false
        private set
    var state = "sleep"
        private set

    /** The user tapped "Turn off" on the notification: quiet until they open J.A.S.S.I again. */
    var off = false
        private set

    @SuppressLint("StaticFieldLeak")
    var service: PresenceService? = null
    private var starting = false

    /** bubble({ visible?, state?, text?, who? }) from the page. */
    fun bubble(context: Context, args: JSONObject): JSONObject {
        val newState = args.optString("state")
        if (newState.isNotEmpty() && newState !in STATES) return fail("bad_args")
        if (newState.isNotEmpty()) state = newState
        if (args.has("visible")) {
            bubble = args.optBoolean("visible") && !off
            if (!args.optBoolean("visible")) mic = false   // the page only hides it when hands-free is switched off
        }
        sync(context)
        val text = args.optString("text")
        if (text.isNotEmpty()) service?.bubbleView?.say(text, mine = args.optString("who") != "jassi")
        return if (bubble && !Settings.canDrawOverlays(context)) fail("permission") else ok()
    }

    /** Hands-free listening is starting: hold the microphone so it keeps working behind other apps. */
    fun listen(context: Context) {
        if (mic && service != null) return
        mic = true
        sync(context)
    }

    fun turnOff() {
        off = true
        bubble = false
        mic = false
        Shell.activity?.voice?.end()   // tell the page, so it can listen again later
        Shell.bridge?.event(JSONObject().put("type", "bubble").put("action", "dismissed"))
        service?.apply()
    }

    fun dismissed() {
        bubble = false
        Shell.bridge?.event(JSONObject().put("type", "bubble").put("action", "dismissed"))
    }

    fun appOpened(context: Context) {
        off = false
        sync(context)
    }

    /** The page is gone (app closed or reloaded). */
    fun end() {
        bubble = false
        mic = false
        state = "sleep"
        service?.apply()
    }

    fun sync(context: Context) {
        val running = service
        if (running != null) return running.apply()
        if (starting || !(mic || bubble && Settings.canDrawOverlays(context))) return
        starting = try {
            ContextCompat.startForegroundService(context, Intent(context, PresenceService::class.java))
            true
        } catch (_: Exception) {   // Android won't start it from the background: try again when the app is opened
            false
        }
    }

    fun started(s: PresenceService) {
        starting = false
        service = s
    }
}

/** The foreground service that owns the bubble and keeps the microphone allowed while other apps are in front. */
class PresenceService : Service() {
    var bubbleView: Bubble? = null
        private set
    private var types = 0
    private var foreground = false
    private var text = 0

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL, getString(R.string.presence), NotificationManager.IMPORTANCE_LOW)
        )
        Presence.started(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == OFF) Presence.turnOff() else apply()
        return START_NOT_STICKY
    }

    /** Matches the service to what [Presence] asks for. */
    fun apply() {
        val overlay = Presence.bubble && Settings.canDrawOverlays(this)
        // Android insists a started service goes to the foreground, even one that is about to stop.
        if (!goForeground(overlay) || !(overlay || Presence.mic)) return quit()
        if (overlay) {
            val bubble = bubbleView ?: Bubble(this, onTap = {
                Shell.bridge?.event(JSONObject().put("type", "bubble").put("action", "tap"))
            }, onDropped = Presence::dismissed, onGone = ::apply).also { bubbleView = it }
            bubble.state = Presence.state
            if (!bubble.show()) bubbleView = null
        } else if (bubbleView?.leaving != true) {   // let it finish shrinking into the bin
            bubbleView?.remove()
            bubbleView = null
        }
    }

    private fun goForeground(overlay: Boolean): Boolean {
        var wanted = types
        val micAllowed = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        if (Build.VERSION.SDK_INT >= 30 && Presence.mic && micAllowed) wanted = wanted or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        if (Build.VERSION.SDK_INT >= 34 && (overlay || wanted == 0)) wanted = wanted or ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
        val label = if (Presence.mic) R.string.listening_for_jassi else R.string.bubble_on
        if (foreground && wanted == types) {
            if (label != text) getSystemService(NotificationManager::class.java).notify(ID, notification(label))
            text = label
            return true
        }
        if (enter(label, wanted)) return true
        // e.g. asking for the microphone from the background: keep what we have, or start without it
        return foreground || Build.VERSION.SDK_INT >= 34 && enter(label, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    }

    private fun enter(label: Int, wanted: Int): Boolean = try {
        ServiceCompat.startForeground(this, ID, notification(label), wanted)
        types = wanted
        text = label
        foreground = true
        true
    } catch (_: Exception) {
        false
    }

    private fun notification(label: Int) = NotificationCompat.Builder(this, CHANNEL)
        .setSmallIcon(R.drawable.ic_notify)
        .setContentTitle(getString(label))
        .setOngoing(true)
        .setSilent(true)
        .setContentIntent(
            PendingIntent.getActivity(
                this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE
            )
        )
        .addAction(
            0, getString(R.string.turn_off),
            PendingIntent.getService(this, 1, Intent(this, PresenceService::class.java).setAction(OFF), PendingIntent.FLAG_IMMUTABLE),
        )
        .build()

    private fun quit() {
        bubbleView?.remove()
        bubbleView = null
        if (Presence.service === this) Presence.service = null
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onTaskRemoved(rootIntent: Intent?) = Presence.end()

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        bubbleView?.reflow()
    }

    override fun onDestroy() {
        bubbleView?.remove()
        bubbleView = null
        if (Presence.service === this) Presence.service = null
        super.onDestroy()
    }

    private companion object {
        const val CHANNEL = "presence"
        const val ID = 1001
        const val OFF = "app.jassi.android.OFF"
    }
}
