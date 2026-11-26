package app.jassi.android

/**
 * Which apps and screens J.A.S.S.I must leave alone (contract §4, safety rules 1 and 3).
 * Pure logic, no Android classes, so it is unit tested.
 */
object Policy {
    /**
     * A safety net that holds even if the web app never sends a list: well-known money, ID,
     * password and health-record apps. The full list comes from the web app through setPolicy.
     */
    val ALWAYS_LOCKED: Set<String> = setOf(
        // UPI and wallets
        "com.google.android.apps.nbu.paisa.user", "com.google.android.apps.walletnfcrel", "com.phonepe.app",
        "net.one97.paytm", "in.org.npci.upiapp", "com.dreamplug.androidapp", "com.mobikwik_new",
        "com.freecharge.android", "com.paypal.android.p2pmobile",
        // Banks
        "com.sbi.lotusintouch", "com.sbi.sbifreedomplus", "com.snapwork.hdfc", "com.csam.icici.bank.imobile",
        "com.axis.mobile", "com.msf.kbank.mobile",
        // Government ID
        "in.gov.uidai.maadhaarplus", "com.digilocker.android", "in.gov.umang.negd.g2c",
        // Brokerage and crypto
        "com.zerodha.kite3", "com.nextbillion.groww", "in.upstox.app", "com.msf.angelmobile", "com.fivepaisa.trade",
        "com.coinbase.android", "com.binance.dev", "com.wazirx", "com.coindcx.btc", "io.metamask",
        "com.wallet.crypto.trustapp",
        // Password managers and authenticators
        "com.google.android.apps.authenticator2", "com.azure.authenticator", "com.authy.authy",
        "com.x8bit.bitwarden", "com.lastpass.lpandroid", "com.agilebits.onepassword", "com.onepassword.android",
        "com.dashlane", "keepass2android.keepass2android", "proton.android.pass",
        // Health records
        "in.ndhm.phr", "nic.goi.aarogyasetu", "com.google.android.apps.healthdata",
    )

    private val LOCKED_WORDS = listOf("bank", "wallet", "authenticator", "aadhaar", "digilocker")

    /** System screens we never read or act on: settings, permission and install prompts, the lock screen. */
    private val PROTECTED: Set<String> = setOf(
        "com.android.settings", "com.android.systemui", "com.google.android.gms", "com.android.credentialmanager",
        "com.android.vpndialogs", "com.miui.securitycenter", "com.coloros.safecenter", "com.oplus.safecenter",
    )
    private val PROTECTED_PARTS = setOf("permissioncontroller", "packageinstaller", "settings")

    fun normalize(ids: Collection<String>): Set<String> =
        ids.map { it.trim().lowercase() }.filter { it.isNotEmpty() }.toSet()

    /** A locked app: on the user's list, on the built-in list, or named like a money / ID app. */
    fun isLocked(appId: String?, blockedApps: Set<String>): Boolean {
        val id = appId?.trim()?.lowercase().orEmpty()
        if (id.isEmpty()) return false
        if (id in blockedApps || id in ALWAYS_LOCKED) return true
        return id.split('.', '_').any { part -> part.startsWith("upi") || LOCKED_WORDS.any { it in part } }
    }

    /** A protected screen. J.A.S.S.I's own app counts, so it can never press its own "Allow" or "Pay" buttons. */
    fun isProtected(appId: String?, ownId: String): Boolean {
        val id = appId?.trim()?.lowercase().orEmpty()
        if (id.isEmpty()) return true   // we can't tell what is in front, so we don't touch it
        if (id == ownId.lowercase() || id in PROTECTED) return true
        return id.split('.').any { it in PROTECTED_PARTS }
    }

    /** Why an action on the app in front must be refused, or null when it may go ahead. */
    fun refusal(frontAppId: String?, blockedApps: Set<String>, ownId: String): String? = when {
        isLocked(frontAppId, blockedApps) -> "blocked_app"
        isProtected(frontAppId, ownId) -> "protected_screen"
        else -> null
    }
}
