package app.jassi.android

import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONException
import org.json.JSONObject

typealias Reply = (JSONObject) -> Unit

fun ok(): JSONObject = JSONObject().put("ok", true)
fun fail(error: String): JSONObject = JSONObject().put("ok", false).put("error", error)

/**
 * window.jassiNative (contract §2). The page talks to us over a web message channel that
 * WebView itself only opens for the J.A.S.S.I origin; we also refuse anything that is not the main frame.
 */
class Bridge(private val activity: MainActivity, private val web: WebView) {
    private val main = Handler(Looper.getMainLooper())
    private val jassiOrigin = Origins.of(BuildConfig.JASSI_URL)!!
    private var page: JavaScriptReplyProxy? = null
    private val waiting = ArrayDeque<JSONObject>()

    fun install(): Boolean {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
        ) return false   // very old WebView: the site still loads, just without native extras
        val origins = setOf(jassiOrigin)
        WebViewCompat.addWebMessageListener(web, "__jassiHost", origins) { _, message, sourceOrigin, isMainFrame, reply ->
            if (isMainFrame && Origins.same(sourceOrigin.toString(), jassiOrigin)) message.data?.let { onMessage(it, reply) }
        }
        val script = activity.assets.open("bridge.js").bufferedReader().use { it.readText() }
            .replace("__VERSION__", BuildConfig.VERSION_NAME)
        WebViewCompat.addDocumentStartJavaScript(web, script, origins)
        return true
    }

    /** Shell → web event. Kept until a page is there to receive it. */
    fun event(detail: JSONObject) {
        main.post {
            val p = page
            if (p != null) send(p, JSONObject().put("event", detail))
            else if (waiting.size < 20) waiting.add(detail)
        }
    }

    private fun onMessage(raw: String, reply: JavaScriptReplyProxy) {
        val msg = try { JSONObject(raw) } catch (_: JSONException) { return }
        if (msg.has("hello")) {
            page = reply
            while (waiting.isNotEmpty()) send(reply, JSONObject().put("event", waiting.removeFirst()))
            return
        }
        val id = msg.optInt("id")
        var answered = false
        val done: Reply = { result ->
            main.post {
                if (!answered) {
                    answered = true
                    send(reply, JSONObject().put("id", id).put("result", result))
                }
            }
        }
        try {
            call(msg.optString("method"), msg.opt("args"), done)
        } catch (_: Exception) {
            done(fail("failed"))
        }
    }

    private fun send(to: JavaScriptReplyProxy, message: JSONObject) {
        try { to.postMessage(message.toString()) } catch (_: Exception) { }
    }

    private fun call(method: String, args: Any?, done: Reply) {
        val o = args as? JSONObject ?: JSONObject()
        when (method) {
            "openExternal" -> {
                val url = (args as? String) ?: o.optString("url")
                done(if (External.open(activity, url)) ok() else fail("bad_url"))
            }
            else -> done(fail("unsupported"))
        }
    }
}
