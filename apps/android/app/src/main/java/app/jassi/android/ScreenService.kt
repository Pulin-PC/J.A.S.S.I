package app.jassi.android

import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityNodeInfo.AccessibilityAction
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CancellationException
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/**
 * Reads the screen as text and taps / types / scrolls in other apps (contract §4), only when the
 * server asks through the device channel. Every safety rule of §4 is enforced here, on the phone:
 *  1. locked apps are never read or acted on        2. passwords never leave the phone
 *  3. settings, permission and install screens are off limits
 *  4. a "J.A.S.S.I is working · Stop" banner is always up, and a touch stops it at once
 *  5. one action at a time, 15 seconds each         7. nothing read from the screen is stored or logged
 */
class ScreenService : AccessibilityService() {
    companion object {
        @Volatile
        var instance: ScreenService? = null
            private set

        private const val OP_LIMIT_SECONDS = 15L

        /** The banner stays up this long after a step so it bridges the steps of one job; a touch in that time still counts. */
        private const val LINGER_MS = 8_000L
    }

    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private lateinit var banner: Banner
    private var lastNodes: List<AccessibilityNodeInfo> = emptyList()   // worker thread only; in memory until the next read, never written anywhere

    @Volatile private var lastChange = 0L
    @Volatile private var running: Future<JSONObject>? = null
    @Volatile private var tookOverAt = -LINGER_MS   // when the user last stopped us or touched the screen
    @Volatile private var webKnows = true

    private val hideBanner = Runnable { banner.hide() }

    /** Debug builds only, and only op names and result codes: never anything read from the screen. */
    private fun trace(what: String) {
        if (BuildConfig.DEBUG) Log.d("jassi", what)
    }

    override fun onServiceConnected() {
        banner = Banner(this, onStop = { stoppedByUser(pressedStop = true) }, onScreenTouched = { stoppedByUser(pressedStop = false) })
        instance = this
        DeviceChannel.refresh(this)
    }

    override fun onUnbind(intent: Intent?): Boolean {
        shutDown()
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        shutDown()
        super.onDestroy()
    }

    private fun shutDown() {
        if (instance === this) instance = null
        DeviceChannel.stop()
        running?.cancel(true)
        worker.execute { lastNodes = emptyList() }
        main.post { if (::banner.isInitialized) banner.hide() }
    }

    /** Only used as a "the screen just changed" tick. What the event says is never read. */
    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        lastChange = SystemClock.uptimeMillis()
    }

    override fun onInterrupt() {}

    // ── one op at a time, with the banner up ────────────────────────────────────────────────

    /** Runs one op from the device channel and returns `{ ok, data? , error? }`. Blocks the channel thread. */
    fun run(op: String, args: JSONObject): JSONObject {
        if (SystemClock.uptimeMillis() - tookOverAt < LINGER_MS) {
            trace("$op refused: the user took over")
            tellWebStopped()
            return failure("stopped")
        }
        trace("$op start")
        main.removeCallbacks(hideBanner)
        val shown = FutureTask { banner.show() }.also { main.post(it) }
        if (!try { shown.get(2, TimeUnit.SECONDS) } catch (_: Exception) { false }) return failure("no_banner")

        val job = worker.submit<JSONObject> {
            Thread.interrupted()   // a Stop that landed just as the last op finished must not stop this one
            execute(op, args)
        }
        running = job
        val result = try {
            job.get(OP_LIMIT_SECONDS, TimeUnit.SECONDS)
        } catch (_: TimeoutException) {
            job.cancel(true)
            failure("timeout")
        } catch (_: CancellationException) {
            failure("stopped")
        } catch (e: ExecutionException) {
            failure(if (e.cause is InterruptedException) "stopped" else "failed")
        } catch (_: InterruptedException) {
            job.cancel(true)
            failure("stopped")
        }
        running = null
        trace("$op end: ${if (result.optBoolean("ok")) "ok" else result.optString("error")}")
        if (SystemClock.uptimeMillis() - tookOverAt >= LINGER_MS) main.postDelayed(hideBanner, LINGER_MS)
        return result
    }

    /** The user pressed Stop on the banner, or touched the screen while the banner was up. */
    private fun stoppedByUser(pressedStop: Boolean) {
        val job = running
        trace(if (pressedStop) "Stop pressed" else "screen touched")
        tookOverAt = SystemClock.uptimeMillis()
        webKnows = false
        job?.cancel(true)
        main.removeCallbacks(hideBanner)
        hideBanner.run()
        if (pressedStop || job != null) tellWebStopped()
    }

    /** stop() from the web app: same effect, but the web app already knows. */
    fun stopFromWeb() {
        tookOverAt = SystemClock.uptimeMillis()
        webKnows = true
        running?.cancel(true)
        main.removeCallbacks(hideBanner)
        main.post(hideBanner)
    }

    private fun tellWebStopped() {
        if (webKnows) return
        webKnows = true
        Shell.bridge?.event(JSONObject().put("type", "stopped").put("by", "user"))
    }

    // ── the ops ─────────────────────────────────────────────────────────────────────────────

    private fun success(data: JSONObject): JSONObject = JSONObject().put("ok", true).put("data", data)
    private fun failure(error: String): JSONObject = JSONObject().put("ok", false).put("error", error)
    private fun done(): JSONObject = success(JSONObject().put("done", true))

    private fun execute(op: String, args: JSONObject): JSONObject = when (op) {
        "screen_read" -> read()
        "screen_act" -> act(args)
        "open_app" -> openApp(args.optString("id"))
        "list_apps" -> success(Apps.json(this))
        else -> failure("unsupported")
    }

    private class Front(val root: AccessibilityNodeInfo, val packageName: String) {
        val id = packageName.lowercase()
    }

    private fun front(): Front? {
        val root = rootInActiveWindow ?: return null
        return Front(root, root.packageName?.toString() ?: return null)
    }

    /** "blocked_app", "protected_screen", or null when the app in front may be read and used. */
    private fun refusal(appId: String): String? {
        Policy.refusal(appId, Vault.blockedApps(this), packageName)?.let { return it }
        val keyboard = Settings.Secure.getString(contentResolver, Settings.Secure.DEFAULT_INPUT_METHOD)?.substringBefore('/')?.lowercase()
        return if (appId == keyboard) "protected_screen" else null   // never press keyboard keys
    }

    private fun read(): JSONObject {
        lastNodes = emptyList()
        val front = front() ?: return failure("no_screen")
        val data = JSONObject().put("app", JSONObject().put("id", front.id).put("name", Apps.name(this, front.packageName)))
        when (refusal(front.id)) {
            null -> {}
            "blocked_app" -> return success(data.put("nodes", JSONArray()).put("blocked", true))
            else -> return success(data.put("nodes", JSONArray()).put("protected", true))
        }
        val kept = ArrayList<AccessibilityNodeInfo>()
        val nodes = JSONArray()
        val todo = ArrayDeque<AccessibilityNodeInfo>().apply { add(front.root) }
        var visited = 0
        while (todo.isNotEmpty() && kept.size < Nodes.MAX_NODES && visited++ < 4000) {
            val node = todo.removeLast()
            val raw = raw(node)
            if (!raw.visible) continue
            if (Nodes.keep(raw)) {
                nodes.put(Nodes.toJson(kept.size, raw))
                kept.add(node)
            }
            for (i in node.childCount - 1 downTo 0) node.getChild(i)?.let { todo.add(it) }
        }
        lastNodes = kept
        return success(data.put("nodes", nodes))
    }

    private fun raw(node: AccessibilityNodeInfo): RawNode {
        val box = Rect().also { node.getBoundsInScreen(it) }
        return RawNode(
            className = node.className?.toString(),
            text = if (node.isShowingHintText) null else node.text?.toString(),
            description = node.contentDescription?.toString(),
            hint = node.hintText?.toString(),
            viewId = node.viewIdResourceName,
            visible = node.isVisibleToUser,
            editable = node.isEditable,
            clickable = node.isClickable,
            focused = node.isFocused,
            password = node.isPassword,
            scrollable = node.isScrollable,
            checkable = node.isCheckable,
            checked = node.isChecked,
            x = box.left, y = box.top, w = box.width(), h = box.height(),
        )
    }

    private fun act(args: JSONObject): JSONObject {
        val front = front() ?: return failure("no_screen")
        refusal(front.id)?.let { return failure(it) }
        val error = when (args.optString("action")) {
            "tap" -> tap(args, front)
            "type" -> type(args, front)
            "scroll" -> scroll(args, front)
            "back" -> global(GLOBAL_ACTION_BACK)
            "home" -> global(GLOBAL_ACTION_HOME)
            "key" -> when (args.optString("key").lowercase()) {
                "enter" -> enter(front)
                "back" -> global(GLOBAL_ACTION_BACK)
                "home" -> global(GLOBAL_ACTION_HOME)
                else -> "unsupported"
            }
            else -> "unsupported"
        }
        if (error != null) return failure(error)
        settle()
        return done()
    }

    /** Node `n` from the last read, if it is still on screen and still belongs to the app in front. */
    private fun node(args: JSONObject, front: Front): AccessibilityNodeInfo? {
        val node = lastNodes.getOrNull(args.optInt("n", -1)) ?: return null
        return node.takeIf { it.refresh() && it.packageName?.toString() == front.packageName }
    }

    private fun tap(args: JSONObject, front: Front): String? {
        var target: AccessibilityNodeInfo? = node(args, front) ?: return "stale_node"
        repeat(8) {
            val t = target ?: return "not_clickable"
            if (t.isClickable) return if (t.performAction(AccessibilityNodeInfo.ACTION_CLICK)) null else "failed"
            target = t.parent
        }
        return "not_clickable"
    }

    private fun type(args: JSONObject, front: Front): String? {
        val field = (if (args.has("n")) node(args, front) ?: return "stale_node" else front.root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT))
            ?: return "no_field"
        if (!field.isEditable) return "not_editable"
        if (Nodes.isSecure(raw(field))) return "secure_field"
        val text = Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, args.optString("text")) }
        return if (field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, text)) null else "failed"
    }

    private fun enter(front: Front): String? {
        val field = front.root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: return "no_field"
        if (Nodes.isSecure(raw(field))) return "secure_field"
        if (Build.VERSION.SDK_INT < 30) return "unsupported"
        return if (field.performAction(AccessibilityAction.ACTION_IME_ENTER.id)) null else "failed"
    }

    private fun scroll(args: JSONObject, front: Front): String? {
        val dir = args.optString("dir", "down")
        val exact = when (dir) {
            "down" -> AccessibilityAction.ACTION_SCROLL_DOWN
            "up" -> AccessibilityAction.ACTION_SCROLL_UP
            "left" -> AccessibilityAction.ACTION_SCROLL_LEFT
            "right" -> AccessibilityAction.ACTION_SCROLL_RIGHT
            else -> return "bad_dir"
        }
        var list: AccessibilityNodeInfo? = if (args.has("n")) node(args, front) ?: return "stale_node" else firstScrollable(front.root)
        while (list != null && !list.isScrollable) list = list.parent
        val target = list ?: return "not_scrollable"
        val forward = dir == "down" || dir == "right"
        val action = if (exact in target.actionList) exact.id
        else if (forward) AccessibilityNodeInfo.ACTION_SCROLL_FORWARD else AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
        return if (target.performAction(action)) null else "cant_scroll"
    }

    private fun firstScrollable(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        val todo = ArrayDeque<AccessibilityNodeInfo>().apply { add(root) }
        var visited = 0
        while (todo.isNotEmpty() && visited++ < 4000) {
            val node = todo.removeFirst()
            if (node.isScrollable && node.isVisibleToUser) return node
            for (i in 0 until node.childCount) node.getChild(i)?.let { todo.add(it) }
        }
        return null
    }

    private fun global(action: Int): String? = if (performGlobalAction(action)) null else "failed"

    private fun openApp(id: String): JSONObject {
        val target = id.trim().lowercase()
        if (target.isEmpty()) return failure("bad_request")
        Policy.refusal(target, Vault.blockedApps(this), packageName)?.let { return failure(it) }
        if (!Apps.open(this, target)) return failure("not_found")
        val start = SystemClock.uptimeMillis()
        while (SystemClock.uptimeMillis() - start < 5_000) {
            Thread.sleep(100)   // Stop interrupts this
            if (front()?.id == target) {
                settle()
                return done()
            }
        }
        return failure("not_opened")
    }

    /** Give the screen a moment to finish changing, so the next read sees the result. */
    private fun settle() {
        val start = SystemClock.uptimeMillis()
        while (true) {
            Thread.sleep(60)   // Stop interrupts this
            val now = SystemClock.uptimeMillis()
            if (now - start > 1_500 || now - maxOf(lastChange, start) >= 300) return
        }
    }
}
