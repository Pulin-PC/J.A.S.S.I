package app.jassi.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PolicyTest {
    private val own = "app.jassi.android"
    private val userList = Policy.normalize(listOf(" COM.Example.Shop ", "", "com.google.android.deskclock"))

    @Test fun `the user's list is trimmed and lower case`() {
        assertEquals(setOf("com.example.shop", "com.google.android.deskclock"), userList)
    }

    @Test fun `apps on the user's list are locked, whatever the letter case`() {
        assertTrue(Policy.isLocked("com.example.shop", userList))
        assertTrue(Policy.isLocked("Com.Example.Shop", userList))
        assertFalse(Policy.isLocked("com.example.shop", emptySet()))
    }

    @Test fun `well known money, ID and password apps are locked even with an empty list`() {
        for (id in listOf("com.phonepe.app", "net.one97.paytm", "com.google.android.apps.nbu.paisa.user",
            "in.gov.uidai.maadhaarplus", "com.zerodha.kite3", "com.google.android.apps.authenticator2", "com.x8bit.bitwarden")) {
            assertTrue(id, Policy.isLocked(id, emptySet()))
        }
    }

    @Test fun `apps named like a bank, wallet or UPI app are locked`() {
        for (id in listOf("com.somebank.mobile", "com.csam.icici.bank.imobile", "in.org.npci.upiapp", "com.acme.wallet", "org.aadhaar.reader")) {
            assertTrue(id, Policy.isLocked(id, emptySet()))
        }
    }

    @Test fun `ordinary apps are not locked`() {
        for (id in listOf("com.google.android.deskclock", "com.whatsapp", "com.cupid.dating", "com.android.chrome", "", null)) {
            assertFalse("$id", Policy.isLocked(id, emptySet()))
        }
    }

    @Test fun `settings, permission prompts, installers, the lock screen and our own app are protected`() {
        for (id in listOf("com.android.settings", "com.android.systemui", "com.google.android.permissioncontroller",
            "com.android.permissioncontroller", "com.google.android.packageinstaller", "com.samsung.android.packageinstaller",
            "com.android.settings.intelligence", "com.google.android.gms", own, "App.Jassi.Android")) {
            assertTrue(id, Policy.isProtected(id, own))
        }
    }

    @Test fun `when we cannot tell what is in front, we treat it as protected`() {
        assertTrue(Policy.isProtected(null, own))
        assertTrue(Policy.isProtected("  ", own))
    }

    @Test fun `ordinary apps are not protected`() {
        assertFalse(Policy.isProtected("com.google.android.deskclock", own))
        assertFalse(Policy.isProtected("com.google.android.contacts", own))
    }

    @Test fun `refusal gives the contract's error codes`() {
        assertEquals("blocked_app", Policy.refusal("com.phonepe.app", emptySet(), own))
        assertEquals("blocked_app", Policy.refusal("com.google.android.deskclock", userList, own))
        assertEquals("protected_screen", Policy.refusal("com.android.settings", emptySet(), own))
        assertEquals("protected_screen", Policy.refusal(null, emptySet(), own))
        assertNull(Policy.refusal("com.google.android.deskclock", emptySet(), own))
    }
}
