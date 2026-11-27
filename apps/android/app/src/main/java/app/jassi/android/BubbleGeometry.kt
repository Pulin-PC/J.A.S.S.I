package app.jassi.android

import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

/** A top-left corner on the screen, in pixels. */
data class Spot(val x: Float, val y: Float)

/** The usable part of the screen: below the status bar, above the navigation bar. */
data class Area(val left: Float, val top: Float, val right: Float, val bottom: Float)

/** Where the bubble, its bin and its caption go (same numbers as the Mac app). Pure arithmetic, unit tested. */
class BubbleGeometry(val area: Area, private val density: Float) {
    /** The bubble window: a 52 dp orb plus room for its glow. */
    val size = SIZE * density
    val binSize = BIN * density
    private val edge = 2 * density
    private val margin = 30 * density
    private val midX = (area.left + area.right) / 2

    /** The bin's centre: bottom middle, above the navigation bar. */
    val bin = Spot(midX, area.bottom - 14 * density - binSize / 2)

    fun home() = Spot(area.right - size - edge, area.top + (area.bottom - area.top) * 0.34f)

    /** True when a bubble whose corner is at [at] is close enough to snap into the bin. */
    fun overBin(at: Spot) = hypot(at.x + size / 2 - bin.x, at.y + size / 2 - bin.y) < 86 * density

    /** Where the bubble is drawn while the finger holds it at [wanted], and whether it has snapped into the bin. */
    fun dragged(wanted: Spot): Pair<Spot, Boolean> =
        if (overBin(wanted)) Spot(bin.x - size / 2, bin.y - size / 2) to true
        else Spot(
            wanted.x.within(area.left - size / 4, area.right - size * 3 / 4),
            wanted.y.within(area.top, area.bottom - size / 2),
        ) to false

    /** Where a bubble let go at [from] with speed (vx, vy) px/s comes to rest: against the nearer side. */
    fun rest(from: Spot, vx: Float, vy: Float): Spot {
        val x = from.x + vx * 0.12f
        val y = from.y + vy * 0.12f
        return Spot(
            if (x + size / 2 < midX) area.left + edge else area.right - size - edge,
            y.within(area.top + margin, area.bottom - size - margin),
        )
    }

    /** The same place on a screen that changed shape (rotation): same side, same height in proportion. */
    fun moved(at: Spot, from: BubbleGeometry): Spot {
        val up = (at.y - from.area.top) / max(1f, from.area.bottom - from.area.top)
        val y = area.top + up * (area.bottom - area.top)
        return rest(Spot(if (at.x + from.size / 2 < from.midX) area.left else area.right - size, y), 0f, 0f)
    }

    /** The caption goes on the side with more room. */
    fun captionOnLeft(at: Spot) = at.x + size / 2 > midX

    fun captionRoom(at: Spot): Float =
        max(0f, if (captionOnLeft(at)) at.x - area.left else area.right - at.x - size)

    /** Top-left of a caption window of [w] × [h], tucked 6 dp into the bubble's glow and centred on it. */
    fun caption(at: Spot, w: Float, h: Float): Spot {
        val tuck = 6 * density
        val x = if (captionOnLeft(at)) at.x - w + tuck else at.x + size - tuck
        return Spot(x.within(area.left, area.right - w), (at.y + size / 2 - h / 2).within(area.top, area.bottom - h))
    }

    companion object {
        const val SIZE = 80f
        const val BIN = 140f
        const val SETTLE_MS = 420L

        /** Spring-like glide (ease-out-back): overshoots a little, then comes back. */
        fun spring(t: Float): Float {
            val c = 1.3f
            return 1 + (c + 1) * (t - 1).pow(3) + c * (t - 1).pow(2)
        }

        private fun Float.within(low: Float, high: Float) = max(low, min(this, high))
    }
}

/** The caption's words and how long they stay. */
object Captions {
    private const val LONGEST_LIVE = 110

    fun clean(text: String) = text.replace(Regex("\\s+"), " ").trim().take(400)

    /** Live words: keep the newest ones in view, dropping the oldest until [fits] says two lines are enough. */
    fun newest(text: String, fits: (String) -> Boolean): String {
        var shown = if (text.length > LONGEST_LIVE) "…" + text.takeLast(LONGEST_LIVE - 2) else text
        while (!fits(shown)) {
            val rest = shown.removePrefix("…")
            val space = rest.indexOf(' ')
            if (space < 0) break
            shown = "…" + rest.substring(space + 1)
        }
        return shown
    }

    /** Milliseconds after the last words before the caption fades. */
    fun stays(text: String, mine: Boolean): Long = if (mine) 2600L else min(9000L, 4200L + text.length * 25L)
}
