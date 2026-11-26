package app.jassi.android

/** Contract §4: on errors wait 2 s, doubling up to 30 s. */
class Backoff(private val firstMs: Long = 2_000, private val maxMs: Long = 30_000) {
    private var next = firstMs

    fun nextDelay(): Long {
        val delay = next
        next = minOf(next * 2, maxMs)
        return delay
    }

    fun reset() {
        next = firstMs
    }
}
