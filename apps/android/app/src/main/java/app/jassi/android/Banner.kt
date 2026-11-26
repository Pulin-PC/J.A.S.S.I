package app.jassi.android

import android.accessibilityservice.AccessibilityService
import android.annotation.SuppressLint
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.ContextCompat

/**
 * "J.A.S.S.I is working · Stop", drawn over every app while a screen action runs (safety rule 4).
 * Touching the banner is Stop. A touch anywhere else on the screen is reported too.
 */
class Banner(
    private val service: AccessibilityService,
    private val onStop: () -> Unit,
    private val onScreenTouched: () -> Unit,
) {
    private val windows = service.getSystemService(WindowManager::class.java)
    private var view: View? = null

    fun show(): Boolean {
        if (view != null) return true
        val params = WindowManager.LayoutParams(
            WRAP_CONTENT, WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL
            y = dp(10)
        }
        return try {
            val built = build()
            windows.addView(built, params)
            view = built
            true
        } catch (_: Exception) {
            false
        }
    }

    fun hide() {
        view?.let { try { windows.removeView(it) } catch (_: Exception) { } }
        view = null
    }

    private fun dp(v: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), service.resources.displayMetrics).toInt()

    @SuppressLint("ClickableViewAccessibility")
    private fun build(): View {
        val accent = ContextCompat.getColor(service, R.color.accent)
        fun label(text: String, color: Int, bold: Boolean) = TextView(service).apply {
            this.text = text
            textSize = 15f
            setTextColor(color)
            if (bold) setTypeface(typeface, Typeface.BOLD)
        }
        return LinearLayout(service).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(18), dp(11), dp(18), dp(11))
            background = GradientDrawable().apply {
                cornerRadius = dp(24).toFloat()
                setColor(0xF2020B14.toInt())
                setStroke(dp(1), accent)
            }
            contentDescription = service.getString(R.string.working) + ". " + service.getString(R.string.stop)
            addView(label(service.getString(R.string.working), ContextCompat.getColor(service, R.color.text), false))
            addView(label("  ·  ", ContextCompat.getColor(service, R.color.text), false))
            addView(label(service.getString(R.string.stop), accent, true))
            setOnTouchListener { _, event ->
                when (event.actionMasked) {
                    MotionEvent.ACTION_OUTSIDE -> onScreenTouched()
                    MotionEvent.ACTION_DOWN -> onStop()
                }
                true
            }
        }
    }
}
