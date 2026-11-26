package app.jassi.android

import android.content.Context
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * The device channel (contract §4): asks the server for the next thing to do, does it through
 * [ScreenService], posts the result. It runs in native code so it keeps going while another app
 * is in front, and only while the phone is paired AND the user has switched the service on.
 * The token is never logged; nothing read from the screen is stored.
 */
object DeviceChannel {
    private const val WAIT_SECONDS = 25

    @Volatile private var loop: Thread? = null
    @Volatile private var open: HttpURLConnection? = null

    /** Start or stop to match the current state. Call after pair / unpair and when the service comes or goes. */
    @Synchronized
    fun refresh(context: Context) {
        val app = context.applicationContext
        val shouldRun = ScreenService.instance != null && Vault.load(app) != null
        if (!shouldRun) return stop()
        if (loop?.isAlive == true) stop()   // paired again, maybe with a new token: start fresh
        loop = Thread({ run(app) }, "jassi-device-channel").apply {
            isDaemon = true
            start()
        }
    }

    @Synchronized
    fun stop() {
        val thread = loop ?: return
        loop = null
        thread.interrupt()
        Thread { open?.disconnect() }.start()
    }

    private fun active() = loop === Thread.currentThread()

    private fun run(context: Context) {
        val backoff = Backoff()
        while (active()) {
            val pairing = Vault.load(context) ?: break
            val service = ScreenService.instance ?: break
            if (!Origins.serverAllowed(pairing.server, BuildConfig.JASSI_URL, BuildConfig.DEBUG)) break
            try {
                val next = call("GET", "${pairing.server}/api/device/next?wait=$WAIT_SECONDS", pairing.token, null)
                when (next.code) {
                    200 -> {
                        backoff.reset()
                        val op = JSONObject(next.body)
                        val result = service.run(op.optString("op"), op.optJSONObject("args") ?: JSONObject())
                        if (active()) post(pairing, result.put("id", op.opt("id")))
                    }
                    204 -> backoff.reset()
                    401 -> {
                        // The server no longer knows this phone: forget the token and stop.
                        if (active()) {
                            Vault.clear(context)
                            synchronized(this) { if (active()) loop = null }
                        }
                        return
                    }
                    else -> Thread.sleep(backoff.nextDelay())
                }
            } catch (_: InterruptedException) {
                return
            } catch (_: Exception) {
                if (!active()) return
                try { Thread.sleep(backoff.nextDelay()) } catch (_: InterruptedException) { return }
            }
        }
    }

    private fun post(pairing: Vault.Pairing, result: JSONObject) {
        repeat(2) {
            try {
                if (call("POST", "${pairing.server}/api/device/result", pairing.token, result.toString()).code in 200..299) return
            } catch (_: InterruptedException) {
                return
            } catch (_: Exception) {
            }
            try { Thread.sleep(1_000) } catch (_: InterruptedException) { return }
        }
    }

    private class Answer(val code: Int, val body: String)

    private fun call(method: String, url: String, token: String, body: String?): Answer {
        val c = URL(url).openConnection() as HttpURLConnection
        open = c
        try {
            c.requestMethod = method
            c.connectTimeout = 10_000
            c.readTimeout = (WAIT_SECONDS + 10) * 1_000
            c.setRequestProperty("Authorization", "Bearer $token")
            c.setRequestProperty("Accept", "application/json")
            if (body != null) {
                c.doOutput = true
                c.setRequestProperty("Content-Type", "application/json")
                c.outputStream.use { it.write(body.toByteArray()) }
            }
            val code = c.responseCode
            val text = if (code == 200) c.inputStream.bufferedReader().use { it.readText() } else ""
            return Answer(code, text)
        } finally {
            open = null
            c.disconnect()
        }
    }
}
