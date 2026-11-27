package app.jassi.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BubbleGeometryTest {
    // a 400 × 800 screen with a 40 status bar and a 48 navigation bar, density 1
    private val g = BubbleGeometry(Area(0f, 40f, 400f, 752f), 1f)
    private fun centred(x: Float, y: Float) = Spot(x - g.size / 2, y - g.size / 2)

    @Test fun `starts against the right edge, a third of the way down`() {
        assertEquals(Spot(318f, 40f + 712f * 0.34f), g.home())
    }

    @Test fun `the bin sits at the bottom centre, above the navigation bar`() {
        assertEquals(Spot(200f, 668f), g.bin)
        assertTrue(g.bin.y + g.binSize / 2 < g.area.bottom)
    }

    @Test fun `follows the finger exactly away from the bin`() {
        assertEquals(Spot(100f, 200f) to false, g.dragged(Spot(100f, 200f)))
    }

    @Test fun `snaps into the bin within 86 dp, not beyond`() {
        val snapped = centred(g.bin.x, g.bin.y)
        assertEquals(snapped to true, g.dragged(centred(200f, 668f - 85f)))
        assertEquals(snapped to true, g.dragged(centred(200f + 60f, 668f - 60f)))
        assertFalse(g.dragged(centred(200f, 668f - 87f)).second)
        assertFalse(g.dragged(centred(200f + 87f, 668f)).second)
    }

    @Test fun `the magnet grows with the screen density`() {
        val dense = BubbleGeometry(Area(0f, 0f, 1200f, 2400f), 3f)
        val at = Spot(dense.bin.x - dense.size / 2, dense.bin.y - dense.size / 2 - 250f)
        assertTrue(dense.overBin(at))
        assertFalse(dense.overBin(at.copy(y = at.y - 10f)))
    }

    @Test fun `cannot be dragged off the screen`() {
        assertEquals(Spot(-20f, 40f), g.dragged(Spot(-500f, -500f)).first)
        assertEquals(Spot(340f, 712f), g.dragged(Spot(900f, 900f)).first)
    }

    @Test fun `comes to rest against the nearer side`() {
        assertEquals(Spot(2f, 300f), g.rest(Spot(100f, 300f), 0f, 0f))
        assertEquals(Spot(318f, 300f), g.rest(Spot(220f, 300f), 0f, 0f))
    }

    @Test fun `a fling carries it to the other side`() {
        assertEquals(Spot(318f, 300f), g.rest(Spot(100f, 300f), 2000f, 0f))
        assertEquals(Spot(2f, 420f), g.rest(Spot(300f, 300f), -2000f, 1000f))
    }

    @Test fun `rests clear of the top and bottom`() {
        assertEquals(70f, g.rest(Spot(0f, 100f), 0f, -9000f).y)
        assertEquals(642f, g.rest(Spot(0f, 600f), 0f, 9000f).y)
    }

    @Test fun `keeps its side when the screen turns`() {
        val wide = BubbleGeometry(Area(0f, 24f, 800f, 380f), 1f)
        val right = wide.moved(Spot(318f, 396f), g)
        assertEquals(718f, right.x)
        assertEquals(202f, right.y)
        assertEquals(2f, wide.moved(Spot(2f, 396f), g).x)
    }

    @Test fun `the caption takes the side with more room`() {
        val onRight = Spot(318f, 300f)
        assertTrue(g.captionOnLeft(onRight))
        assertEquals(318f, g.captionRoom(onRight))
        assertEquals(Spot(124f, 315f), g.caption(onRight, 200f, 50f))
        val onLeft = Spot(2f, 300f)
        assertFalse(g.captionOnLeft(onLeft))
        assertEquals(318f, g.captionRoom(onLeft))
        assertEquals(Spot(76f, 315f), g.caption(onLeft, 200f, 50f))
    }

    @Test fun `the caption stays on the screen`() {
        assertEquals(0f, g.caption(Spot(318f, 300f), 390f, 50f).x)
        assertEquals(40f, g.caption(Spot(318f, 40f), 100f, 120f).y)
    }

    @Test fun `the spring starts at 0, overshoots and ends at 1`() {
        assertEquals(0f, BubbleGeometry.spring(0f), 0.0001f)
        assertEquals(1f, BubbleGeometry.spring(1f), 0.0001f)
        assertTrue(BubbleGeometry.spring(0.7f) > 1f)
    }
}

class CaptionsTest {
    @Test fun `keeps the newest words until they fit`() {
        assertEquals("…three four", Captions.newest("one two three four") { it.length <= 12 })
        assertEquals("short", Captions.newest("short") { true })
        assertEquals("unbreakable", Captions.newest("unbreakable") { false })
    }

    @Test fun `long live words are cut to the end`() {
        val shown = Captions.newest("a".repeat(100) + " the end " + "b".repeat(20)) { true }
        assertEquals(109, shown.length)
        assertTrue(shown.startsWith("…") && shown.endsWith("b"))
    }

    @Test fun `live words fade sooner than a reply, and no reply stays over 9 seconds`() {
        assertEquals(2600L, Captions.stays("hello", mine = true))
        assertEquals(4325L, Captions.stays("hello", mine = false))
        assertEquals(9000L, Captions.stays("x".repeat(400), mine = false))
    }

    @Test fun `tidies spaces`() = assertEquals("a b c", Captions.clean("  a \n b   c "))
}

class QuietMicTest {
    @Test fun `silence reopens the microphone without telling the page`() {
        assertTrue(QuietMic.restartsQuietly(6, heardWords = false, sessionMs = 5000))
        assertTrue(QuietMic.restartsQuietly(7, heardWords = false, sessionMs = 1500))
    }

    @Test fun `words, instant failures and real errors go to the page`() {
        assertFalse(QuietMic.restartsQuietly(7, heardWords = true, sessionMs = 5000))
        assertFalse(QuietMic.restartsQuietly(7, heardWords = false, sessionMs = 200))
        assertFalse(QuietMic.restartsQuietly(8, heardWords = false, sessionMs = 5000))
        assertFalse(QuietMic.restartsQuietly(9, heardWords = false, sessionMs = 5000))
    }
}
