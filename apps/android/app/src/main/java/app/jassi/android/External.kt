package app.jassi.android

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent

/** Opens anything that is not the J.A.S.S.I site outside the WebView. */
object External {
    private val OTHER_SCHEMES = setOf("mailto", "tel", "sms", "geo", "market")

    fun open(context: Context, url: String?): Boolean {
        val uri = try { Uri.parse(url?.trim().orEmpty()) } catch (_: Exception) { return false }
        val scheme = uri.scheme?.lowercase() ?: return false
        return try {
            when (scheme) {
                "http", "https" -> CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(context, uri)
                in OTHER_SCHEMES -> context.startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                else -> return false
            }
            true
        } catch (_: Exception) {
            false
        }
    }
}
