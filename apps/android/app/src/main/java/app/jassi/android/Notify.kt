package app.jassi.android

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import org.json.JSONObject

/** notify({ title, body }): a normal system notification that opens J.A.S.S.I when tapped. */
object Notify {
    private const val CHANNEL = "alerts"
    private var nextId = 1

    fun show(context: Context, title: String, body: String): JSONObject {
        val manager = NotificationManagerCompat.from(context)
        if (!manager.areNotificationsEnabled()) return fail("permission")
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL, context.getString(R.string.alerts), NotificationManager.IMPORTANCE_DEFAULT)
        )
        val open = PendingIntent.getActivity(
            context, 0, Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle(title.ifBlank { context.getString(R.string.app_name) })
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        return try {
            manager.notify(nextId++, notification)
            ok()
        } catch (_: SecurityException) {
            fail("permission")
        }
    }
}
