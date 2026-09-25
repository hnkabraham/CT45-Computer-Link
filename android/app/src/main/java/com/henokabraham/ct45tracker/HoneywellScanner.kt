package com.henokabraham.ct45tracker

import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.core.content.ContextCompat

/**
 * The CT45's built-in scanner, through Honeywell's Data Collection Intent API: while claimed,
 * each scan arrives as a broadcast instead of being typed as keystrokes. No Honeywell SDK
 * needed. On anything that isn't a Honeywell device, [available] is false and the app falls
 * back to typed or pasted input.
 *
 * The app screen and the background service can each want the scanner; it's claimed while
 * either does. There's one receiver for both, so a scan is never handled twice.
 */
class HoneywellScanner(
    private val context: Context,
    private val onScan: (data: String, aimId: String, codeId: String) -> Unit,
) {
    enum class User { SCREEN, BACKGROUND }

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, intent: Intent) {
            val data = intent.getStringExtra("data") ?: return
            onScan(data, intent.getStringExtra("aimId").orEmpty(), intent.getStringExtra("codeId").orEmpty())
        }
    }
    private val users = mutableSetOf<User>()

    /** True when Honeywell's scanner service is on this device. */
    val available: Boolean
        get() = claimTargets().isNotEmpty() || try {
            context.packageManager.getPackageInfo(HONEYWELL_SERVICE_PACKAGE, 0)
            true
        } catch (e: PackageManager.NameNotFoundException) {
            false
        }

    /** Main thread only. Claims again even if already held, in case another app took it. */
    fun want(user: User) {
        if (users.isEmpty()) {
            // Exported: the scans come from Honeywell's service, which is another app.
            ContextCompat.registerReceiver(context, receiver, IntentFilter(ACTION_SCAN), ContextCompat.RECEIVER_EXPORTED)
        }
        users += user
        claim()
    }

    /** Main thread only. Releases the scanner once nobody wants it. */
    fun unwant(user: User) {
        if (!users.remove(user) || users.isNotEmpty()) return
        sendToService(Intent(ACTION_RELEASE_SCANNER))
        context.unregisterReceiver(receiver)
    }

    /** Claims the scanner again, e.g. when the screen turns on, if anyone wants it. */
    fun reclaim() {
        if (users.isNotEmpty()) claim()
    }

    private fun claim() {
        val properties = Bundle().apply {
            putBoolean("DPR_DATA_INTENT", true)
            putString("DPR_DATA_INTENT_ACTION", ACTION_SCAN)
            // Don't also type the scan into whatever field has focus.
            putBoolean("DPR_WEDGE", false)
        }
        sendToService(
            Intent(ACTION_CLAIM_SCANNER)
                .putExtra(EXTRA_SCANNER, "dcs.scanner.imager")
                .putExtra(EXTRA_PROFILE, "DEFAULT")
                .putExtra(EXTRA_PROPERTIES, properties),
        )
    }

    // Android 8+ doesn't deliver implicit broadcasts to other apps' manifest receivers, so send
    // to each of Honeywell's receivers by name (visible thanks to <queries> in the manifest).
    private fun sendToService(intent: Intent) {
        val targets = claimTargets()
        if (targets.isEmpty()) {
            context.sendBroadcast(Intent(intent).setPackage(HONEYWELL_SERVICE_PACKAGE))
            return
        }
        for (component in targets) context.sendBroadcast(Intent(intent).setComponent(component))
    }

    @Suppress("DEPRECATION")
    private fun claimTargets(): List<ComponentName> =
        context.packageManager.queryBroadcastReceivers(Intent(ACTION_CLAIM_SCANNER), 0)
            .map { ComponentName(it.activityInfo.packageName, it.activityInfo.name) }

    companion object {
        /** Our own action for scan broadcasts. desktop/scripts/android-e2e.mjs sends it too. */
        const val ACTION_SCAN = "com.henokabraham.ct45tracker.SCAN"

        private const val ACTION_CLAIM_SCANNER = "com.honeywell.aidc.action.ACTION_CLAIM_SCANNER"
        private const val ACTION_RELEASE_SCANNER = "com.honeywell.aidc.action.ACTION_RELEASE_SCANNER"
        private const val EXTRA_SCANNER = "com.honeywell.aidc.extra.EXTRA_SCANNER"
        private const val EXTRA_PROFILE = "com.honeywell.aidc.extra.EXTRA_PROFILE"
        private const val EXTRA_PROPERTIES = "com.honeywell.aidc.extra.EXTRA_PROPERTIES"
        private const val HONEYWELL_SERVICE_PACKAGE = "com.intermec.datacollectionservice"
    }
}
