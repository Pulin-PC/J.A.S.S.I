package app.jassi.android

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.fragment.app.FragmentActivity
import org.json.JSONObject

/** The whole app: one WebView showing the J.A.S.S.I site, plus the "can't reach" screen. */
class MainActivity : FragmentActivity() {
    lateinit var web: WebView
        private set
    lateinit var bridge: Bridge
        private set
    lateinit var voice: Voice
        private set
    private lateinit var errorScreen: View
    private var failed = false
    private var webMicRequest: PermissionRequest? = null

    private val askMic = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        webMicRequest?.let { if (granted) it.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) else it.deny() }
        webMicRequest = null
        answered("mic", Manifest.permission.RECORD_AUDIO, granted)
    }
    private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        answered("notifications", Manifest.permission.POST_NOTIFICATIONS, granted)
    }
    private var asking: String? = null   // one Android prompt at a time
    private var askedAt = 0L

    // While the app is in front, look once a second so setup moves on by itself (contract §2, "permission").
    private val ticker = Handler(Looper.getMainLooper())
    private var lastPermissions: String? = null
    private val tick = object : Runnable {
        override fun run() {
            checkPermissions()
            ticker.postDelayed(this, 1000)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        web = WebView(this)
        errorScreen = buildErrorScreen()
        val root = FrameLayout(this).apply {
            setBackgroundColor(ContextCompat.getColor(context, R.color.bg))
            addView(web, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            addView(errorScreen, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        }
        setContentView(root)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowCompat.getInsetsController(window, root).isAppearanceLightStatusBars = false
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()
            )
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
            setSupportMultipleWindows(false)
            userAgentString = "$userAgentString JassiAndroid/${BuildConfig.VERSION_NAME}"
        }
        CookieManager.getInstance().setAcceptCookie(true)
        web.setBackgroundColor(ContextCompat.getColor(this, R.color.bg))

        voice = Voice(this)
        bridge = Bridge(this, web)
        bridge.install()
        Shell.bridge = bridge
        Shell.activity = this
        web.webViewClient = Pages()
        web.webChromeClient = Chrome()

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (web.canGoBack()) web.goBack() else moveTaskToBack(true)
            }
        })

        if (savedInstanceState == null) {
            handleIntent(intent)
            web.loadUrl(BuildConfig.JASSI_URL)
        } else {
            web.restoreState(savedInstanceState)
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        ticker.removeCallbacks(tick)
        tick.run()
    }

    override fun onPause() {
        ticker.removeCallbacks(tick)
        super.onPause()
    }

    private fun checkPermissions() {
        val now = Perms.snapshot(this)
        val text = now.toString()
        if (lastPermissions != null && lastPermissions != text) {
            bridge.event(JSONObject().put("type", "permission").put("permissions", now))
        }
        lastPermissions = text
    }

    /** Shows the system prompt, or the settings page when Android will not prompt any more. */
    fun openPermission(kind: String): JSONObject {
        when (kind) {
            "screen" -> if (!Perms.openScreenSettings(this)) return fail("failed")
            "mic", "speech" -> {
                if (kind == "speech" && Perms.snapshot(this).optString("speech") == "unsupported") return fail("unsupported")
                requestMic()
            }
            "notifications" -> if (Build.VERSION.SDK_INT < 33) Perms.openNotificationSettings(this) else ask("notifications")
            else -> return fail("unsupported")
        }
        return ok()
    }

    private fun requestMic() = ask("mic")

    private fun ask(kind: String) {
        if (asking != null) return   // Android can only show one prompt at a time
        asking = kind
        askedAt = SystemClock.elapsedRealtime()
        if (kind == "mic") askMic.launch(Manifest.permission.RECORD_AUDIO) else askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    /** A "no" that comes back at once, with no prompt shown, means Android will not ask any more: open Settings instead. */
    private fun answered(kind: String, permission: String, granted: Boolean) {
        val instant = SystemClock.elapsedRealtime() - askedAt < 700
        asking = null
        val blocked = !granted && instant && !shouldShowRequestPermissionRationale(permission)
        Perms.setBlocked(this, kind, blocked)
        if (blocked) {
            if (kind == "mic") Perms.openAppSettings(this) else Perms.openNotificationSettings(this)
        }
        checkPermissions()
    }

    override fun onDestroy() {
        if (Shell.bridge === bridge) Shell.bridge = null
        if (Shell.activity === this) Shell.activity = null
        voice.shutDown()
        web.destroy()
        super.onDestroy()
    }

    /** jassi://auth… → the "auth" event; words shared from another app → the "ask" event. */
    private fun handleIntent(intent: Intent?) {
        intent ?: return
        val link = intent.dataString
        if (intent.action == Intent.ACTION_VIEW && link != null && link.startsWith("jassi://auth")) {
            bridge.event(JSONObject().put("type", "auth").put("url", link))
        } else if (intent.action == Intent.ACTION_SEND && intent.type == "text/plain") {
            val text = intent.getStringExtra(Intent.EXTRA_TEXT)?.trim().orEmpty()
            if (text.isNotEmpty()) bridge.event(JSONObject().put("type", "ask").put("text", text.take(2000)))
        }
    }

    fun hasMic() = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    private fun isJassi(url: String?) = Origins.same(url, BuildConfig.JASSI_URL)

    private fun showError() {
        failed = true
        errorScreen.visibility = View.VISIBLE
        web.visibility = View.INVISIBLE
    }

    private fun retry() {
        failed = false
        web.loadUrl(web.url?.takeIf { isJassi(it) } ?: BuildConfig.JASSI_URL)
    }

    private fun buildErrorScreen(): View {
        fun dp(v: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            visibility = View.GONE
            setBackgroundColor(ContextCompat.getColor(context, R.color.bg))
            setPadding(dp(32), dp(32), dp(32), dp(32))
            addView(TextView(context).apply {
                setText(R.string.cant_reach)
                setTextColor(ContextCompat.getColor(context, R.color.text))
                textSize = 18f
                gravity = Gravity.CENTER
            }, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT))
            addView(Button(context).apply {
                setText(R.string.try_again)
                isAllCaps = false
                textSize = 16f
                setOnClickListener { retry() }
            }, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { topMargin = dp(20) })
        }
    }

    private inner class Pages : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            if (!request.isForMainFrame) return false
            val url = request.url.toString()
            if (isJassi(url)) return false
            External.open(this@MainActivity, url)   // every other link leaves the WebView
            return true
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame) showError()
        }

        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
            if (request.isForMainFrame && response.statusCode >= 500) showError()
        }

        override fun onPageFinished(view: WebView, url: String?) {
            if (!failed) {
                errorScreen.visibility = View.GONE
                web.visibility = View.VISIBLE
            }
        }
    }

    private inner class Chrome : WebChromeClient() {
        /** The page may use the microphone only if it is the J.A.S.S.I site and Android has allowed it. */
        override fun onPermissionRequest(request: PermissionRequest) {
            val mic = PermissionRequest.RESOURCE_AUDIO_CAPTURE
            if (!isJassi(request.origin?.toString()) || !request.resources.contains(mic)) {
                request.deny()
            } else if (hasMic()) {
                request.grant(arrayOf(mic))
            } else if (asking != null) {
                request.deny()   // another Android prompt is already open
            } else {
                webMicRequest?.deny()
                webMicRequest = request
                requestMic()
            }
        }

        override fun onPermissionRequestCanceled(request: PermissionRequest) {
            if (webMicRequest == request) webMicRequest = null
        }
    }
}
