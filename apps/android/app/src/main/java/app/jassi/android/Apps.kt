package app.jassi.android

import android.content.Context
import android.content.Intent
import org.json.JSONArray
import org.json.JSONObject

/** Apps the user can open: the ones with a launcher icon (no QUERY_ALL_PACKAGES). */
object Apps {
    data class App(val id: String, val packageName: String, val name: String)

    fun list(context: Context): List<App> {
        val pm = context.packageManager
        val launcher = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        return pm.queryIntentActivities(launcher, 0)
            .map { it.activityInfo.packageName to it.loadLabel(pm).toString() }
            .filter { it.first != context.packageName }
            .distinctBy { it.first }
            .map { App(it.first.lowercase(), it.first, it.second) }
            .sortedBy { it.name.lowercase() }
    }

    /** Same shape for listApps() and the list_apps op. `locked` marks apps this phone will never read or control. */
    fun json(context: Context): JSONObject {
        val blocked = Vault.blockedApps(context)
        val apps = JSONArray()
        for (app in list(context)) {
            val o = JSONObject().put("id", app.id).put("name", app.name)
            if (Policy.isLocked(app.id, blocked)) o.put("locked", true)
            apps.put(o)
        }
        return ok().put("apps", apps).put("partial", false)
    }

    fun name(context: Context, packageName: String): String = try {
        val pm = context.packageManager
        pm.getApplicationLabel(pm.getApplicationInfo(packageName, 0)).toString()
    } catch (_: Exception) {
        packageName
    }

    fun open(context: Context, id: String): Boolean {
        val app = list(context).firstOrNull { it.id == id.trim().lowercase() } ?: return false
        val intent = context.packageManager.getLaunchIntentForPackage(app.packageName) ?: return false
        return try {
            context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            true
        } catch (_: Exception) {
            false
        }
    }
}
