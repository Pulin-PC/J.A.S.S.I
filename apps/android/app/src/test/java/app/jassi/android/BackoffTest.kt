package app.jassi.android

import org.junit.Assert.assertEquals
import org.junit.Test

class BackoffTest {
    @Test fun `waits 2 s, then doubles, and never more than 30 s`() {
        val b = Backoff()
        assertEquals(listOf(2_000L, 4_000L, 8_000L, 16_000L, 30_000L, 30_000L, 30_000L), List(7) { b.nextDelay() })
    }

    @Test fun `starts again from 2 s after a good answer`() {
        val b = Backoff()
        repeat(4) { b.nextDelay() }
        b.reset()
        assertEquals(2_000L, b.nextDelay())
        assertEquals(4_000L, b.nextDelay())
    }
}
