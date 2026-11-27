package app.jassi.android

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.hardware.display.DisplayManager
import android.hardware.input.InputManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.text.SpannableString
import android.text.Spanned
import android.text.TextUtils
import android.text.style.ForegroundColorSpan
import android.text.style.RelativeSizeSpan
import android.text.style.StyleSpan
import android.view.Display
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.View
import android.view.View.MeasureSpec
import android.view.ViewConfiguration
import android.view.WindowInsets
import android.view.WindowManager
import android.view.animation.LinearInterpolator
import android.view.animation.OvershootInterpolator
import android.widget.FrameLayout
import android.widget.TextView
import kotlin.math.hypot
import kotlin.math.roundToInt

/**
 * The bubble, its bin and its caption, drawn over other apps. None of them ever takes focus.
 * Main thread only. [PresenceService] owns it.
 */
@SuppressLint("ClickableViewAccessibility")
class Bubble(
    base: Context,
    private val onTap: () -> Unit,
    private val onDropped: () -> Unit,   // let go over the bin
    private val onGone: () -> Unit,      // …and it has finished shrinking into it
) {
    private val context: Context = if (Build.VERSION.SDK_INT >= 30) {
        val screen = base.getSystemService(DisplayManager::class.java).getDisplay(Display.DEFAULT_DISPLAY)
        base.createDisplayContext(screen).createWindowContext(WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY, null)
    } else base
    private val windows = context.getSystemService(WindowManager::class.java)
    private val density = context.resources.displayMetrics.density
    private val main = Handler(Looper.getMainLooper())

    private var geometry = measure()
    private var orb: OrbView? = null
    private var bin: Pair<FrameLayout, BinView>? = null
    private var caption: Pair<FrameLayout, TextView>? = null
    private var at = geometry.home()
    private var settle: ValueAnimator? = null
    private var dragging = false
    var leaving = false
        private set
    var state = "sleep"
        set(value) { field = value; orb?.state = value }

    val shown get() = orb != null && !leaving

    fun show(): Boolean {
        if (shown) return true
        if (orb != null) remove()   // still shrinking into the bin: start fresh
        geometry = measure().also { at = it.moved(at, geometry) }
        return try {
            // The bin goes in first so the bubble is drawn on top of it. Its window is GONE until a drag.
            val binView = BinView(context)
            val holder = FrameLayout(context).apply {
                visibility = View.GONE
                clipChildren = false
                addView(binView, FrameLayout.LayoutParams(geometry.binSize.px(), geometry.binSize.px()))
            }
            windows.addView(holder, params(geometry.binSize.px(), geometry.binSize.px(), touchable = false).apply {
                x = (geometry.bin.x - geometry.binSize / 2).px()
                y = (geometry.bin.y - geometry.binSize / 2).px()
            })
            bin = holder to binView

            val view = OrbView(context).apply {
                state = this@Bubble.state
                contentDescription = context.getString(R.string.bubble_label)
                setOnClickListener { onTap() }
                setOnTouchListener(Drag())
            }
            windows.addView(view, params(geometry.size.px(), geometry.size.px(), touchable = true).apply {
                x = at.x.px()
                y = at.y.px()
            })
            orb = view
            // let a drag start at the screen edge without Android reading it as "back"
            if (Build.VERSION.SDK_INT >= 29) view.post {
                view.systemGestureExclusionRects = listOf(Rect(0, 0, view.width, view.height))
            }
            view.pop()
            true
        } catch (_: Exception) {   // "Display over other apps" was switched off
            remove()
            false
        }
    }

    fun remove() {
        main.removeCallbacksAndMessages(null)
        settle?.cancel()
        removeCaption()
        listOfNotNull(orb, bin?.first).forEach { try { windows.removeViewImmediate(it) } catch (_: Exception) { } }
        orb = null
        bin = null
        dragging = false
        leaving = false
    }

    /** The screen changed shape: stay on the same side. */
    fun reflow() {
        val next = measure()
        at = next.moved(at, geometry)
        geometry = next
        clearCaption()
        place(at)
        bin?.let { (holder, _) ->
            update(holder) { x = (geometry.bin.x - geometry.binSize / 2).px(); y = (geometry.bin.y - geometry.binSize / 2).px() }
        }
    }

    // ── caption ─────────────────────────────────────────────────────────────────────────────

    private val fade = Runnable { clearCaption() }

    fun say(text: String, mine: Boolean) {
        val words = Captions.clean(text)
        if (words.isEmpty() || !shown || dragging) return
        val shadow = (10 * density).roundToInt()
        val room = minOf((geometry.captionRoom(at) + 6 * density).roundToInt() - shadow, (280 * density).roundToInt())
        if (room < 80 * density) return

        val (holder, label) = caption ?: buildCaption(shadow).also { caption = it }
        val who = if (mine) "YOU" else "J.A.S.S.I"
        fun styled(body: String) = SpannableString("$who  $body").apply {
            val flags = Spanned.SPAN_EXCLUSIVE_EXCLUSIVE
            setSpan(RelativeSizeSpan(10f / 13f), 0, who.length, flags)
            setSpan(StyleSpan(Typeface.BOLD), 0, who.length, flags)
            setSpan(ForegroundColorSpan(if (mine) 0xB3AAD7E6.toInt() else 0xFF46ECFF.toInt()), 0, who.length, flags)
        }
        label.maxWidth = room
        label.setTextColor(if (mine) 0xD1E3F8FF.toInt() else 0xFFE3F8FF.toInt())
        label.gravity = if (geometry.captionOnLeft(at)) Gravity.END else Gravity.START
        label.text = styled(
            if (!mine) words else Captions.newest(words) {
                label.text = styled(it)
                label.maxLines = Int.MAX_VALUE
                label.measure(MeasureSpec.makeMeasureSpec(room, MeasureSpec.AT_MOST), MeasureSpec.UNSPECIFIED)
                label.lineCount <= 2
            }
        )
        label.maxLines = 2
        holder.measure(MeasureSpec.UNSPECIFIED, MeasureSpec.UNSPECIFIED)
        val w = holder.measuredWidth
        val h = holder.measuredHeight
        // the shadow padding overlaps the bubble's glow; the pill itself sits just beside it
        val spot = geometry.caption(at, (w - 2 * shadow).toFloat(), h.toFloat())
        val x = spot.x.px() - shadow
        try {
            if (holder.parent == null) {
                windows.addView(holder, params(w, h, touchable = false).apply { this.x = x; y = spot.y.px() })
                label.alpha = 0f
                label.translationX = (if (geometry.captionOnLeft(at)) 6 else -6) * density
                label.scaleX = .97f
                label.scaleY = .97f
            } else update(holder) { width = w; height = h; this.x = x; y = spot.y.px() }
        } catch (_: Exception) {
            caption = null
            return
        }
        label.animate().cancel()
        label.animate().alpha(1f).translationX(0f).scaleX(1f).scaleY(1f).setDuration(300)
            .setInterpolator(OvershootInterpolator(1f)).withEndAction(null).start()
        main.removeCallbacks(fade)
        main.postDelayed(fade, Captions.stays(words, mine))
    }

    fun clearCaption() {
        main.removeCallbacks(fade)
        val (holder, label) = caption ?: return
        label.animate().alpha(0f).setDuration(280).withEndAction { if (caption?.first === holder) removeCaption() }.start()
    }

    private fun removeCaption() {
        val holder = caption?.first
        caption = null
        if (holder?.parent != null) try { windows.removeViewImmediate(holder) } catch (_: Exception) { }
    }

    private fun buildCaption(shadow: Int): Pair<FrameLayout, TextView> {
        fun dp(v: Int) = (v * density).roundToInt()
        val label = TextView(context).apply {
            textSize = 13f
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            ellipsize = TextUtils.TruncateAt.END
            setPadding(dp(12), dp(7), dp(12), dp(8))
            background = GradientDrawable().apply {
                cornerRadius = 14 * density
                setColor(0xF204101A.toInt())
                setStroke(dp(1), 0x3846ECFF)
            }
            elevation = 6 * density
        }
        val holder = FrameLayout(context).apply {
            clipToPadding = false
            setPadding(shadow, shadow, shadow, shadow)
            addView(label, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT))
        }
        return holder to label
    }

    // ── dragging ────────────────────────────────────────────────────────────────────────────

    private inner class Drag : View.OnTouchListener {
        private var downX = 0f
        private var downY = 0f
        private var from = Spot(0f, 0f)
        private var speed: VelocityTracker? = null
        private val slop = ViewConfiguration.get(context).scaledTouchSlop

        override fun onTouch(view: View, event: MotionEvent): Boolean {
            if (leaving) return true
            // the window moves under the finger, so measure speed in screen coordinates
            val onScreen = MotionEvent.obtain(event).apply { offsetLocation(event.rawX - event.x, event.rawY - event.y) }
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    settle?.cancel()
                    downX = event.rawX
                    downY = event.rawY
                    from = at
                    speed?.recycle()
                    speed = VelocityTracker.obtain().also { it.addMovement(onScreen) }
                }
                MotionEvent.ACTION_MOVE -> {
                    speed?.addMovement(onScreen)
                    val dx = event.rawX - downX
                    val dy = event.rawY - downY
                    if (!dragging && hypot(dx, dy) >= slop) startDrag()
                    if (dragging) {
                        val (spot, hot) = geometry.dragged(Spot(from.x + dx, from.y + dy))
                        if (hot != orb?.hot) {
                            orb?.hot = hot
                            bin?.second?.hot = hot
                            if (hot) view.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
                        }
                        place(spot)
                    }
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    val cancelled = event.actionMasked == MotionEvent.ACTION_CANCEL
                    if (dragging) {
                        speed?.computeCurrentVelocity(1000)
                        endDrag(if (cancelled) 0f else speed?.xVelocity ?: 0f, if (cancelled) 0f else speed?.yVelocity ?: 0f, cancelled)
                    } else {
                        if (!cancelled) view.performClick()
                        if (at != from || settle?.isStarted != true) glide(geometry.rest(at, 0f, 0f))   // a touch may have stopped a glide
                    }
                    speed?.recycle()
                    speed = null
                }
            }
            onScreen.recycle()
            return true
        }
    }

    private fun startDrag() {
        dragging = true
        orb?.dragging = true
        clearCaption()
        bin?.let { (holder, view) ->
            holder.visibility = View.VISIBLE
            view.animate().cancel()
            view.hot = false
            view.alpha = 0f
            view.scaleX = .8f
            view.scaleY = .8f
            view.translationY = 26 * density
            view.animate().alpha(1f).scaleX(1f).scaleY(1f).translationY(0f).setDuration(300)
                .setInterpolator(OvershootInterpolator(1.4f)).withEndAction(null).start()
        }
    }

    private fun endDrag(vx: Float, vy: Float, cancelled: Boolean) {
        dragging = false
        val dropped = orb?.hot == true && !cancelled
        orb?.dragging = false
        bin?.let { (holder, view) ->
            view.animate().alpha(0f).scaleX(.8f).scaleY(.8f).translationY(26 * density).setDuration(220)
                .setInterpolator(LinearInterpolator()).withEndAction { holder.visibility = View.GONE }.start()
        }
        if (dropped) {
            leaving = true
            at = geometry.home()   // comes back at its usual place, not on top of the bin
            orb?.bye()
            onDropped()
            main.postDelayed({
                remove()
                onGone()
            }, 260)
        } else {
            orb?.hot = false
            glide(geometry.rest(at, vx, vy))
        }
    }

    private fun glide(to: Spot) {
        val from = at
        settle = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = BubbleGeometry.SETTLE_MS
            interpolator = LinearInterpolator()
            addUpdateListener {
                val k = BubbleGeometry.spring(it.animatedValue as Float)
                place(Spot(from.x + (to.x - from.x) * k, from.y + (to.y - from.y) * k))
            }
            start()
        }
    }

    private fun place(spot: Spot) {
        at = spot
        orb?.let { update(it) { x = spot.x.px(); y = spot.y.px() } }
    }

    // ── windows ─────────────────────────────────────────────────────────────────────────────

    private fun Float.px() = roundToInt()

    private fun update(view: View, change: WindowManager.LayoutParams.() -> Unit) {
        val params = view.layoutParams as? WindowManager.LayoutParams ?: return
        params.change()
        try { windows.updateViewLayout(view, params) } catch (_: Exception) { }
    }

    private fun params(width: Int, height: Int, touchable: Boolean) = WindowManager.LayoutParams(
        width, height, WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
            WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or
            WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED or
            (if (touchable) 0 else WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE),
        PixelFormat.TRANSLUCENT,
    ).apply {
        gravity = Gravity.TOP or Gravity.LEFT   // x and y are plain screen pixels
        windowAnimations = 0
        // Android 12+ blocks touches under an untouchable overlay unless it is slightly see-through.
        if (!touchable && Build.VERSION.SDK_INT >= 31) {
            alpha = context.getSystemService(InputManager::class.java).maximumObscuringOpacityForTouch
        }
        if (Build.VERSION.SDK_INT >= 28) {
            layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }
        if (Build.VERSION.SDK_INT >= 30) fitInsetsTypes = 0
        if (Build.VERSION.SDK_INT >= 34) setCanPlayMoveAnimation(false)
    }

    private fun measure(): BubbleGeometry {
        val area = if (Build.VERSION.SDK_INT >= 30) {
            val metrics = windows.maximumWindowMetrics
            val bars = metrics.windowInsets.getInsetsIgnoringVisibility(
                WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout()
            )
            val b = metrics.bounds
            Area(bars.left.toFloat(), bars.top.toFloat(), (b.width() - bars.right).toFloat(), (b.height() - bars.bottom).toFloat())
        } else {
            val size = android.util.DisplayMetrics()
            @Suppress("DEPRECATION") windows.defaultDisplay.getRealMetrics(size)
            fun bar(name: String): Int {
                val res = context.resources
                @SuppressLint("DiscouragedApi") val id = res.getIdentifier(name, "dimen", "android")
                return if (id > 0) res.getDimensionPixelSize(id) else 0
            }
            Area(0f, bar("status_bar_height").toFloat(), size.widthPixels.toFloat(), (size.heightPixels - bar("navigation_bar_height")).toFloat())
        }
        return BubbleGeometry(area, context.resources.displayMetrics.density)
    }
}
