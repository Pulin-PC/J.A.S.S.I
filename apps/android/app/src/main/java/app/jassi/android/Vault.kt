package app.jassi.android

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * What the phone remembers: the pairing (server, device id, token) and the locked-app list.
 * The token is encrypted with a key that lives in the Android Keystore and never leaves it.
 */
object Vault {
    data class Pairing(val server: String, val deviceId: String, val token: String)

    private const val KEY_NAME = "jassi_device_token"
    private const val STORE = "AndroidKeyStore"

    fun prefs(context: Context): SharedPreferences =
        context.applicationContext.getSharedPreferences("jassi", Context.MODE_PRIVATE)

    fun save(context: Context, pairing: Pairing) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val sealed = cipher.doFinal(pairing.token.toByteArray())
        val box = Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(sealed, Base64.NO_WRAP)
        prefs(context).edit()
            .putString("server", pairing.server.trimEnd('/'))
            .putString("device_id", pairing.deviceId)
            .putString("token_box", box)
            .apply()
    }

    fun load(context: Context): Pairing? {
        val p = prefs(context)
        val server = p.getString("server", null) ?: return null
        val box = p.getString("token_box", null) ?: return null
        return try {
            val (iv, sealed) = box.split(":").map { Base64.decode(it, Base64.NO_WRAP) }
            val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv)) }
            Pairing(server, p.getString("device_id", "").orEmpty(), String(cipher.doFinal(sealed)))
        } catch (_: Exception) {
            clear(context)
            null
        }
    }

    fun clear(context: Context) {
        prefs(context).edit().remove("server").remove("device_id").remove("token_box").apply()
        try { KeyStore.getInstance(STORE).apply { load(null) }.deleteEntry(KEY_NAME) } catch (_: Exception) { }
    }

    fun blockedApps(context: Context): Set<String> =
        prefs(context).getStringSet("blocked_apps", emptySet()).orEmpty().toSet()

    fun setBlockedApps(context: Context, ids: Collection<String>) {
        prefs(context).edit().putStringSet("blocked_apps", Policy.normalize(ids)).apply()
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance(STORE).apply { load(null) }
        (store.getKey(KEY_NAME, null) as? SecretKey)?.let { return it }
        val spec = KeyGenParameterSpec.Builder(KEY_NAME, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build()
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, STORE).apply { init(spec) }.generateKey()
    }
}
