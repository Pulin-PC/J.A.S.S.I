package app.jassi.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NodesTest {
    // ── what gets sent ──────────────────────────────────────────────────────────────────────

    @Test fun `things that are off screen or have no size are dropped`() {
        assertFalse(Nodes.keep(RawNode(text = "Hello", visible = false)))
        assertFalse(Nodes.keep(RawNode(text = "Hello", w = 0)))
        assertFalse(Nodes.keep(RawNode(text = "Hello", h = 0)))
    }

    @Test fun `things that say something or can be used are kept`() {
        assertTrue(Nodes.keep(RawNode(text = "Hello")))
        assertTrue(Nodes.keep(RawNode(description = "Close")))
        assertTrue(Nodes.keep(RawNode(hint = "Search")))
        assertTrue(Nodes.keep(RawNode(clickable = true)))
        assertTrue(Nodes.keep(RawNode(editable = true)))
        assertTrue(Nodes.keep(RawNode(scrollable = true)))
    }

    @Test fun `empty layout boxes are dropped`() {
        assertFalse(Nodes.keep(RawNode(className = "android.widget.FrameLayout")))
        assertFalse(Nodes.keep(RawNode(text = "   ")))
    }

    @Test fun `roles are plain words`() {
        assertEquals("field", Nodes.role(RawNode(className = "android.widget.EditText", editable = true)))
        assertEquals("button", Nodes.role(RawNode(className = "android.widget.Button")))
        assertEquals("button", Nodes.role(RawNode(className = "android.widget.ImageButton")))
        assertEquals("radio", Nodes.role(RawNode(className = "android.widget.RadioButton")))
        assertEquals("checkbox", Nodes.role(RawNode(className = "android.widget.CheckBox")))
        assertEquals("switch", Nodes.role(RawNode(className = "android.widget.Switch")))
        assertEquals("scroll", Nodes.role(RawNode(className = "androidx.recyclerview.widget.RecyclerView", scrollable = true)))
        assertEquals("image", Nodes.role(RawNode(className = "android.widget.ImageView", description = "Photo")))
        assertEquals("text", Nodes.role(RawNode(className = "android.widget.TextView", text = "Hi")))
        assertEquals("item", Nodes.role(RawNode(className = "android.view.ViewGroup", clickable = true)))
    }

    @Test fun `a node is written the way the contract says`() {
        val o = Nodes.toJson(7, RawNode(className = "android.widget.EditText", text = "Asha", hint = "Name",
            editable = true, clickable = true, focused = true, x = 10, y = 20, w = 300, h = 40))
        assertEquals(7, o.getInt("n"))
        assertEquals("field", o.getString("role"))
        assertEquals("Asha", o.getString("text"))
        assertEquals("Name", o.getString("hint"))
        assertTrue(o.getBoolean("editable") && o.getBoolean("clickable") && o.getBoolean("focused"))
        assertFalse(o.has("secure"))
        assertEquals("[10,20,300,40]", o.getJSONArray("bounds").toString())
    }

    @Test fun `flags that are false are left out, and a picture uses its description`() {
        val o = Nodes.toJson(0, RawNode(className = "android.widget.ImageView", description = "Profile photo"))
        assertEquals("Profile photo", o.getString("text"))
        for (flag in listOf("editable", "clickable", "focused", "secure", "hint")) assertFalse(flag, o.has(flag))
    }

    @Test fun `text is cut at 200 characters`() {
        assertEquals(200, Nodes.toJson(0, RawNode(text = "a".repeat(500))).getString("text").length)
    }

    @Test fun `a tick box says on or off in its hint`() {
        assertEquals("on", Nodes.toJson(0, RawNode(className = "android.widget.CheckBox", checkable = true, checked = true)).getString("hint"))
        assertEquals("off", Nodes.toJson(0, RawNode(className = "android.widget.CheckBox", checkable = true)).getString("hint"))
    }

    // ── secrets never leave the phone ───────────────────────────────────────────────────────

    @Test fun `a password box is secure and its text is never sent`() {
        val box = RawNode(className = "android.widget.EditText", text = "hunter2", hint = "Password", editable = true, password = true)
        val o = Nodes.toJson(3, box)
        assertTrue(Nodes.isSecure(box))
        assertTrue(o.getBoolean("secure"))
        assertEquals("", o.getString("text"))
        assertFalse(o.toString().contains("hunter2"))
    }

    @Test fun `boxes that ask for a PIN, OTP or card number are secure even if the app did not mark them`() {
        for (hint in listOf("Enter UPI PIN", "MPIN", "OTP", "One-time code", "CVV", "Card number", "Security code", "Passcode", "Confirm password")) {
            assertTrue(hint, Nodes.isSecure(RawNode(hint = hint, editable = true)))
        }
        assertTrue(Nodes.isSecure(RawNode(viewId = "com.shop.app:id/otp_input", editable = true)))
        assertTrue(Nodes.isSecure(RawNode(viewId = "com.shop.app:id/etPassword", editable = true)))
        assertEquals("", Nodes.toJson(0, RawNode(text = "482913", hint = "OTP", editable = true)).getString("text"))
    }

    @Test fun `ordinary boxes are not secure`() {
        for (hint in listOf("Search contacts", "Pincode", "PIN code", "Name", "Message", "Spinach recipe")) {
            assertFalse(hint, Nodes.isSecure(RawNode(hint = hint, editable = true)))
        }
        assertFalse("a label is not a box", Nodes.isSecure(RawNode(text = "Password", editable = false)))
    }

    @Test fun `card and ID numbers are hidden wherever they show up`() {
        assertEquals("Card •••", Nodes.redact("Card 4111 1111 1111 1111"))
        assertEquals("Card •••", Nodes.redact("Card 4111-1111-1111-1111"))
        assertEquals("Aadhaar ••• linked", Nodes.redact("Aadhaar 1234 5678 9012 linked"))
    }

    @Test fun `codes are hidden in text that talks about an OTP`() {
        assertEquals("Your OTP is •••. Do not share it.", Nodes.redact("Your OTP is 482913. Do not share it."))
        assertEquals("••• is your verification code", Nodes.redact("482913 is your verification code"))
    }

    @Test fun `phone numbers, prices, years and postal codes stay readable`() {
        for (text in listOf("Call +91 98765 43210", "Call 9876543210", "Total ₹1,24,999", "Order 482913 shipped", "PIN code 560001", "Since 2019")) {
            assertEquals(text, Nodes.redact(text))
        }
    }
}
