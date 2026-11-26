package app.jassi.android

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
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
    private lateinit var errorScreen: View
    private var failed = false
    private var webMicRequest: PermissionRequest? = null

    private val askMic = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        webMicRequest?.let { if (granted) it.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) else it.deny() }
        webMicRequest = null
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

        bridge = Bridge(this, web)
        bridge.install()
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

    override fun onDestroy() {
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
            } else {
                webMicRequest?.deny()
                webMicRequest = request
                askMic.launch(Manifest.permission.RECORD_AUDIO)
            }
        }

        override fun onPermissionRequestCanceled(request: PermissionRequest) {
            if (webMicRequest == request) webMicRequest = null
        }
    }
}
