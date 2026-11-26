package app.jassi.android

import org.json.JSONArray
import org.json.JSONObject

/** One thing on the screen, as Android reports it. Plain data so the rules below can be unit tested. */
data class RawNode(
    val className: String? = null,
    val text: String? = null,
    val description: String? = null,
    val hint: String? = null,
    val viewId: String? = null,
    val visible: Boolean = true,
    val editable: Boolean = false,
    val clickable: Boolean = false,
    val focused: Boolean = false,
    val password: Boolean = false,
    val scrollable: Boolean = false,
    val checkable: Boolean = false,
    val checked: Boolean = false,
    val x: Int = 0,
    val y: Int = 0,
    val w: Int = 1,
    val h: Int = 1,
)

/**
 * Turns the screen into the short text list of contract §4 (`screen_read`), and decides what
 * must never leave the phone (safety rule 2). Pure logic.
 */
object Nodes {
    const val MAX_NODES = 300
    const val MAX_TEXT = 200
    private const val MASK = "•••"

    private val SECRET_FIELD = Regex(
        """pass\s?word|passcode|\b(m|t|upi\s)?pin\b(?!\s*code)|\botp\b|one[- ]time|\bcvv\b|\bcvc\b|card\s?(number|no\b)|security code|secret""",
        RegexOption.IGNORE_CASE,
    )
    private val LONG_NUMBER = Regex("""(?<![+\d])\d(?:[ -]?\d){11,18}(?!\d)""")   // card and ID numbers (not +91… phone numbers)
    private val CODE_TALK = Regex("""\b(otp|one[- ]time|verification|passcode|password|pin|cvv|security code)\b""", RegexOption.IGNORE_CASE)
    private val SHORT_CODE = Regex("""(?<!\d)\d{4,8}(?!\d)""")

    /** Password boxes, and boxes that ask for a PIN, OTP or card number even if the app forgot to mark them. */
    fun isSecure(node: RawNode): Boolean {
        if (node.password) return true
        if (!node.editable) return false
        val label = listOf(node.hint, node.description, node.viewId?.substringAfterLast('/')?.replace('_', ' '))
            .joinToString(" ") { it.orEmpty() }
        return SECRET_FIELD.containsMatchIn(label)
    }

    /** Worth sending: on screen, and either says something or can be used. */
    fun keep(node: RawNode): Boolean {
        if (!node.visible || node.w <= 0 || node.h <= 0) return false
        val says = !node.text.isNullOrBlank() || !node.description.isNullOrBlank() || !node.hint.isNullOrBlank()
        return says || node.clickable || node.editable || node.scrollable || node.checkable
    }

    fun role(node: RawNode): String {
        val type = node.className.orEmpty().substringAfterLast('.')
        return when {
            node.editable -> "input"
            "CheckBox" in type -> "checkbox"
            "Switch" in type || "Toggle" in type -> "switch"
            "RadioButton" in type -> "radio"
            "Button" in type -> "button"
            node.scrollable -> "scroll"
            "Image" in type -> "image"
            "Text" in type -> "text"
            node.clickable -> "item"
            node.text.isNullOrBlank() && node.description.isNullOrBlank() -> "group"
            else -> "text"
        }
    }

    /** Hides card / ID numbers, and short codes in text that talks about an OTP, PIN or password. */
    fun redact(text: String): String {
        var out = LONG_NUMBER.replace(text, MASK)
        if (CODE_TALK.containsMatchIn(out)) out = SHORT_CODE.replace(out, MASK)
        return out
    }

    fun toJson(n: Int, node: RawNode): JSONObject {
        val secure = isSecure(node)
        val shown = node.text?.takeIf { it.isNotBlank() } ?: node.description.orEmpty()
        val o = JSONObject()
            .put("n", n)
            .put("role", role(node))
            .put("text", if (secure) "" else redact(shown).take(MAX_TEXT))
        if (!node.hint.isNullOrBlank()) o.put("hint", node.hint.take(MAX_TEXT))
        if (node.editable) o.put("editable", true)
        if (node.clickable) o.put("clickable", true)
        if (node.focused) o.put("focused", true)
        if (secure) o.put("secure", true)
        if (node.checkable) o.put("checked", node.checked)
        return o.put("bounds", JSONArray(listOf(node.x, node.y, node.w, node.h)))
    }
}
