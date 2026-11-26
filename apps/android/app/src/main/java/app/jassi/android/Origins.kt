package app.jassi.android

import java.net.URI

/** Pure helpers for "is this address the J.A.S.S.I site?" and "may the device channel talk to this server?". */
object Origins {
    private val LOCAL_HOSTS = setOf("localhost", "127.0.0.1")

    /** scheme://host[:port] in lower case, or null when the address is not a plain web address. */
    fun of(url: String?): String? {
        if (url.isNullOrBlank()) return null
        val u = try { URI(url.trim()) } catch (_: Exception) { return null }
        val scheme = u.scheme?.lowercase() ?: return null
        if (scheme != "http" && scheme != "https") return null
        val host = u.host?.lowercase() ?: return null
        val standard = if (scheme == "https") 443 else 80
        return if (u.port == -1 || u.port == standard) "$scheme://$host" else "$scheme://$host:${u.port}"
    }

    fun same(a: String?, b: String?): Boolean {
        val x = of(a)
        return x != null && x == of(b)
    }

    /**
     * Contract §4 rule 6: HTTPS only; plain HTTP only for localhost in debug builds.
     * On top of that the server must be the site this app was built for, so a page can never
     * point screen control at some other server.
     */
    fun serverAllowed(server: String?, jassiUrl: String, debug: Boolean): Boolean {
        val origin = of(server) ?: return false
        val host = URI(origin).host
        if (origin.startsWith("http://")) return debug && host in LOCAL_HOSTS
        return origin == of(jassiUrl) || (debug && host in LOCAL_HOSTS)
    }
}
