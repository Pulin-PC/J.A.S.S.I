package app.jassi.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OriginsTest {
    private val site = "https://jassi.pulin-chaudhari.workers.dev"

    @Test fun `an origin is scheme, host and any unusual port`() {
        assertEquals(site, Origins.of("$site/setup?x=1#top"))
        assertEquals(site, Origins.of("HTTPS://JASSI.pulin-chaudhari.workers.dev:443/"))
        assertEquals("http://localhost:8787", Origins.of("http://localhost:8787/api"))
    }

    @Test fun `anything that is not a plain web address has no origin`() {
        for (url in listOf(null, "", "jassi://auth?code=1", "javascript:alert(1)", "intent://x#Intent;end", "file:///sdcard/x", "not a url")) {
            assertNull("$url", Origins.of(url))
        }
    }

    @Test fun `look-alike addresses are not the site`() {
        assertTrue(Origins.same("$site/anything", site))
        assertFalse(Origins.same("https://jassi.pulin-chaudhari.workers.dev.evil.com/", site))
        assertFalse(Origins.same("https://jassi.pulin-chaudhari.workers.dev@evil.com/", site))
        assertFalse(Origins.same("http://jassi.pulin-chaudhari.workers.dev/", site))
        assertFalse(Origins.same(null, site))
    }

    @Test fun `the device channel only talks to the site this app was built for, over HTTPS`() {
        assertTrue(Origins.serverAllowed(site, site, debug = false))
        assertTrue(Origins.serverAllowed("$site/", site, debug = false))
        assertFalse(Origins.serverAllowed("https://evil.example", site, debug = false))
        assertFalse(Origins.serverAllowed("https://evil.example", site, debug = true))
        assertFalse(Origins.serverAllowed("http://jassi.pulin-chaudhari.workers.dev", site, debug = true))
        assertFalse(Origins.serverAllowed("", site, debug = true))
        assertFalse(Origins.serverAllowed(null, site, debug = true))
    }

    @Test fun `plain HTTP is only for localhost, and only in debug builds`() {
        assertTrue(Origins.serverAllowed("http://localhost:8787", site, debug = true))
        assertTrue(Origins.serverAllowed("http://127.0.0.1:8787", site, debug = true))
        assertFalse(Origins.serverAllowed("http://localhost:8787", site, debug = false))
        assertFalse(Origins.serverAllowed("http://192.168.1.20:8787", site, debug = true))
        assertFalse(Origins.serverAllowed("http://example.com", site, debug = true))
    }
}
