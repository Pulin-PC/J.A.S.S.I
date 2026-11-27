package app.jassi.android

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.Shader
import android.graphics.SweepGradient
import android.os.SystemClock
import android.view.View
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.min

private const val CYAN = 0x46ECFF
private const val RED = 0xFF5C70

private fun argb(alpha: Float, rgb: Int) = ((alpha.coerceIn(0f, 1f) * 255).toInt() shl 24) or (rgb and 0xFFFFFF)

/** The glass orb, drawn like the Mac bubble: sleep, listening, thinking and speaking looks. */
@SuppressLint("ViewConstructor")
class OrbView(context: Context) : View(context) {
    var state = "sleep"
        set(value) { field = value; invalidate() }
    var dragging = false
        set(value) { field = value; invalidate() }
    var hot = false
        set(value) { field = value; invalidate() }

    private val dp = resources.displayMetrics.density
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val turn = Matrix()
    private var scale = 1f
    private var alphaNow = 0.72f
    private var glow = 0.18f
    private var last = 0L
    private var popAt = 0L
    private var byeAt = 0L
    private var colour = CYAN
    private var shaders = Shaders(CYAN)

    /** Gradients in dp, centred on the orb; rebuilt only when the colour changes (cyan, or red over the bin). */
    private class Shaders(c: Int) {
        private fun radial(x: Float, y: Float, r: Float, vararg stops: Pair<Float, Int>) = RadialGradient(
            x, y, r, stops.map { it.second }.toIntArray(), stops.map { it.first }.toFloatArray(), Shader.TileMode.CLAMP
        )

        val halo = radial(0f, 0f, 39f, 0f to argb(.55f, c), .35f to argb(.42f, c), .74f to argb(.1f, c), 1f to argb(0f, c))
        val shadow = radial(0f, 5f, 36f, 0f to argb(.6f, 0), .68f to argb(.45f, 0), 1f to argb(0f, 0))
        val glass = radial(0f, 2.6f, 38.6f, 0f to 0xFF0B3247.toInt(), .46f to 0xFF04182A.toInt(), .74f to 0xFF01060C.toInt())
        val shine = radial(-9.4f, -12.5f, 22f, 0f to argb(.42f, 0xAAF5FF), 1f to argb(0f, 0xAAF5FF))
        val inner = radial(0f, -5f, 31f, 0f to argb(0f, c), .68f to argb(0f, c), 1f to argb(.3f, c))
        val coreGlow = radial(0f, 0f, 17f, 0f to argb(.7f, c), .45f to argb(.35f, c), 1f to argb(0f, c))
        val core = radial(
            0f, 0f, 14.1f, 0f to 0xFFF2FEFF.toInt(), .18f to 0xFFF2FEFF.toInt(), .38f to argb(1f, c),
            .62f to argb(.25f, c), .74f to argb(0f, c),
        )
        val glint = radial(0f, 0f, 5.5f, 0f to argb(.6f, 0xFFFFFF), .55f to argb(.45f, 0xFFFFFF), 1f to argb(0f, 0xFFFFFF))
        val arc = SweepGradient(
            0f, 0f, intArrayOf(argb(0f, c), argb(0f, c), argb(.9f, c), argb(.95f, 0xFFFFFF), argb(0f, c), argb(0f, c)),
            floatArrayOf(0f, .55f, .82f, .86f, .87f, 1f),
        )
    }

    /** Appear with a little bounce. */
    fun pop() {
        popAt = SystemClock.uptimeMillis()
        byeAt = 0
        invalidate()
    }

    /** Shrink away (dropped on the bin). */
    fun bye() {
        byeAt = SystemClock.uptimeMillis()
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        val now = SystemClock.uptimeMillis()
        val moving = ValueAnimator.areAnimatorsEnabled()
        val dt = if (last == 0L) 1000f else (now - last).toFloat()
        last = now
        val k = if (moving) min(1f, dt / 110f) else 1f
        val wantScale = if (hot) .8f else if (dragging) 1.12f else 1f
        val wantAlpha = if (state == "sleep" && !dragging) .72f else 1f
        val wantGlow = when (state) { "listening" -> 1f; "thinking" -> .75f; "speaking" -> .9f; else -> .18f }
        scale += (wantScale - scale) * k
        alphaNow += (wantAlpha - alphaNow) * k
        glow += (wantGlow - glow) * k
        val c = if (hot) RED else CYAN
        if (c != colour) {
            colour = c
            shaders = Shaders(c)
        }

        var s = scale
        var a = alphaNow
        if (popAt != 0L) {
            val t = (now - popAt) / 520f
            if (t >= 1f || !moving) popAt = 0
            else {
                s *= if (t < .7f) .3f + .78f * easeOut(t / .7f) else 1.08f - .08f * ((t - .7f) / .3f)
                a *= min(1f, t / .7f)
            }
        }
        if (byeAt != 0L) {
            val t = min(1f, (now - byeAt) / 240f)
            s *= 1f - .95f * t
            a *= 1f - t
        }

        canvas.save()
        canvas.translate(width / 2f, height / 2f)
        canvas.scale(dp * s, dp * s)
        val seconds = if (moving) now / 1000f else 0f

        // halo
        val pulse = if (state == "listening") wave(seconds, 1.5f) else 0f
        canvas.save()
        canvas.scale(1 + .12f * pulse, 1 + .12f * pulse)
        fill(canvas, shaders.halo, 39f, a * glow * (1 - .45f * pulse))
        canvas.restore()

        // rings
        if (state == "listening") ring(canvas, seconds, 1.5f, 0f, a)
        if (state == "speaking") for (i in 0..2) ring(canvas, seconds, 1.25f, i * .42f, a)

        // thinking arc
        if (state == "thinking") {
            turn.setRotate(seconds / .85f % 1f * 360f)
            shaders.arc.setLocalMatrix(turn)
            stroke(2f, a)
            paint.shader = shaders.arc
            canvas.drawCircle(0f, 0f, 29.75f, paint)
        }

        // glass shell
        fill(canvas, shaders.shadow, 36f, a)
        fill(canvas, shaders.glass, 26f, a)
        fill(canvas, shaders.shine, 26f, a)
        fill(canvas, shaders.inner, 26f, a)
        stroke(1f, a)
        paint.color = argb(.55f * a, colour)
        canvas.drawCircle(0f, 0f, 25.5f, paint)

        // core
        var coreScale = 1f
        var coreAlpha = 1f
        when (state) {
            "sleep" -> wave(seconds, 4.2f).let { coreScale = .82f + .12f * it; coreAlpha = .55f + .25f * it }
            "thinking" -> wave(seconds, 1.1f).let { coreScale = 1f - .06f * it; coreAlpha = 1f - .2f * it }
            "speaking" -> coreScale = .9f + .22f * wave(seconds, 1f)
        }
        canvas.save()
        canvas.scale(coreScale, coreScale)
        fill(canvas, shaders.coreGlow, 17f, a * coreAlpha)
        fill(canvas, shaders.core, 11f, a * coreAlpha)
        canvas.restore()

        // glint
        canvas.save()
        canvas.translate(-8f, -14f)
        canvas.rotate(-28f)
        canvas.scale(1f, .6f)
        fill(canvas, shaders.glint, 5.5f, a)
        canvas.restore()
        canvas.restore()

        // Full frame rate only while something is happening; the slow sleep breathing needs far less battery.
        val settling = popAt != 0L || byeAt != 0L || kotlin.math.abs(wantScale - scale) > .005f ||
            kotlin.math.abs(wantAlpha - alphaNow) > .005f || kotlin.math.abs(wantGlow - glow) > .005f
        if (moving && (settling || state != "sleep")) postInvalidateOnAnimation()
        else if (moving) postInvalidateDelayed(50)
    }

    private fun fill(canvas: Canvas, shader: Shader, radius: Float, alpha: Float) {
        paint.style = Paint.Style.FILL
        paint.color = argb(alpha, 0xFFFFFF)
        paint.shader = shader
        canvas.drawCircle(0f, 0f, radius, paint)
        paint.shader = null
    }

    private fun stroke(width: Float, alpha: Float) {
        paint.shader = null
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = width
        paint.color = argb(alpha, 0xFFFFFF)
    }

    private fun ring(canvas: Canvas, seconds: Float, period: Float, delay: Float, alpha: Float) {
        val t = ((seconds - delay) / period).mod(1f)
        val e = easeOut(t)
        stroke(1.5f, 1f)
        paint.color = argb(.7f * .8f * (1 - e) * alpha, colour)
        canvas.drawCircle(0f, 0f, 26f * (1 + .52f * e), paint)
    }

    private fun easeOut(t: Float) = 1 - (1 - t) * (1 - t)

    /** 0 → 1 → 0 once per [period] seconds. */
    private fun wave(seconds: Float, period: Float) = (.5 - .5 * cos(2 * PI * (seconds / period).mod(1f))).toFloat()
}

/** The round bin that appears while the bubble is dragged; red when the bubble is over it. */
@SuppressLint("ViewConstructor")
class BinView(context: Context) : View(context) {
    var hot = false
        set(value) {
            if (field == value) return
            field = value
            animate().scaleX(if (value) 1.28f else 1f).scaleY(if (value) 1.28f else 1f).translationY(0f).alpha(1f)
                .setDuration(250).start()
            invalidate()
        }

    private val dp = resources.displayMetrics.density
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val idle = RadialGradient(0f, -10f, 46f, 0xEB283C4B.toInt(), 0xF0080E14.toInt(), Shader.TileMode.CLAMP)
    private val over = RadialGradient(0f, -10f, 46f, 0xF2FF5C70.toInt(), 0xF2961428.toInt(), Shader.TileMode.CLAMP)
    private val redGlow = RadialGradient(
        0f, 0f, 54f, intArrayOf(argb(.6f, RED), argb(.45f, RED), argb(0f, RED)), floatArrayOf(0f, .6f, 1f), Shader.TileMode.CLAMP
    )

    override fun onDraw(canvas: Canvas) {
        canvas.translate(width / 2f, height / 2f)
        canvas.scale(dp, dp)
        paint.style = Paint.Style.FILL
        paint.color = Color.WHITE
        if (hot) {
            paint.shader = redGlow
            canvas.drawCircle(0f, 0f, 54f, paint)
        }
        paint.shader = if (hot) over else idle
        canvas.drawCircle(0f, 0f, 32f, paint)
        paint.shader = null
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = 1f
        paint.color = argb(.14f, 0xFFFFFF)
        canvas.drawCircle(0f, 0f, 31.5f, paint)

        // the trash can, on a 24 × 24 grid
        if (hot) { canvas.translate(0f, -1f); canvas.rotate(-8f) }
        canvas.translate(-12f, -12f)
        paint.strokeWidth = 1.8f
        paint.strokeCap = Paint.Cap.ROUND
        paint.strokeJoin = Paint.Join.ROUND
        paint.color = if (hot) Color.WHITE else argb(.9f, 0xE1F5FF)
        canvas.drawPath(CAN, paint)
    }

    private companion object {
        val CAN = android.graphics.Path().apply {
            moveTo(4f, 7f); lineTo(20f, 7f)
            moveTo(9.5f, 7f); lineTo(9.5f, 5.2f); quadTo(9.5f, 4f, 10.7f, 4f); lineTo(13.3f, 4f); quadTo(14.5f, 4f, 14.5f, 5.2f); lineTo(14.5f, 7f)
            moveTo(6.3f, 7f); lineTo(7.2f, 18.6f); quadTo(7.35f, 20.3f, 9.1f, 20.3f); lineTo(14.9f, 20.3f); quadTo(16.65f, 20.3f, 16.8f, 18.6f); lineTo(17.7f, 7f)
            moveTo(10.2f, 11f); lineTo(10.2f, 16.2f)
            moveTo(13.8f, 11f); lineTo(13.8f, 16.2f)
        }
    }
}
