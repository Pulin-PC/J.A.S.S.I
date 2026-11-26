package app.jassi.android

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.browser.customtabs.CustomTabsIntent

/** Opens anything that is not the J.A.S.S.I site outside the WebView. */
object External {
    private val OTHER_SCHEMES = setOf("mailto", "tel", "sms", "geo", "market", "whatsapp")

    fun open(context: Context, url: String?): Boolean {
        val uri = try { Uri.parse(url?.trim().orEmpty()) } catch (_: Exception) { return false }
        val scheme = uri.scheme?.lowercase() ?: return false
        return try {
            when (scheme) {
                "http", "https" -> if (!inApp(context, uri)) CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(context, uri)
                in OTHER_SCHEMES -> context.startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                else -> return false
            }
            true
        } catch (_: Exception) {
            false
        }
    }

    /** A web link an installed app owns (wa.me → WhatsApp, YouTube, Maps…) opens in that app; otherwise false. */
    private fun inApp(context: Context, uri: Uri): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return false
        return try {
            context.startActivity(Intent(Intent.ACTION_VIEW, uri)
                .addCategory(Intent.CATEGORY_BROWSABLE)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REQUIRE_NON_BROWSER))
            true
        } catch (_: Exception) {
            false
        }
    }
}
