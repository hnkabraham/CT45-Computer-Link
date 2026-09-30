package com.henokabraham.ct45tracker

import android.app.Application
import android.content.Intent
import android.content.SharedPreferences
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import android.widget.Toast
import androidx.core.content.ContextCompat
import java.util.UUID

/** Holds the scan log, the connection and the scanner so the screen and the service share them. */
class ScanApp : Application() {
    lateinit var prefs: SharedPreferences
        private set
    lateinit var log: ScanLog
        private set
    lateinit var link: DesktopLink
        private set
    lateinit var scanner: HoneywellScanner
        private set

    // The last scan from the scanner, so a keyboard-wedge copy typed into the text box can be
    // recognised and dropped.
    var lastScannerScan = ""
        private set
    var lastScannerScanAt = 0L
        private set

    /** True while the app's screen is in front. Set by MainActivity. */
    var screenShowing = false

    override fun onCreate() {
        super.onCreate()
        prefs = getSharedPreferences("ct45tracker", MODE_PRIVATE)
        log = ScanLog(prefs)
        var saveFailed = false
        log.addListener {
            if (log.hasSaveError && !saveFailed) Toast.makeText(this, R.string.storage_error_detail, Toast.LENGTH_LONG).show()
            saveFailed = log.hasSaveError
        }
        link = DesktopLink(this, prefs, log, deviceName())
        scanner = HoneywellScanner(this) { data, aimId, codeId ->
            lastScannerScan = data.trimEnd('\r', '\n')
            lastScannerScanAt = SystemClock.elapsedRealtime()
            handleScan(data, aimId, codeId, canPair = screenShowing)
        }
    }

    /**
     * A scan from the scanner or the text box. The computer's QR code pairs instead of logging,
     * but only while the app is on screen: any app on the device can send the scan broadcast,
     * and must not be able to quietly point this device at another computer.
     */
    fun handleScan(raw: String, aimId: String, codeId: String, canPair: Boolean): Boolean {
        val data = raw.trimEnd('\r', '\n')
        if (data.isBlank()) return false
        if (data.startsWith("${Protocol.PAIR_PREFIX}?")) {
            if (!canPair) {
                Toast.makeText(this, R.string.open_app_to_pair, Toast.LENGTH_LONG).show()
                return false
            }
            val pairing = Protocol.parsePairing(data)
            if (pairing == null || !link.pair(pairing)) {
                Toast.makeText(this, R.string.invalid_pairing, Toast.LENGTH_LONG).show()
                return false
            }
            val name = pairing.name.ifEmpty { getString(R.string.your_computer) }
            Toast.makeText(this, getString(R.string.pairing_with, name), Toast.LENGTH_SHORT).show()
            return true
        }
        if (data.length > Protocol.MAX_DATA_LENGTH) {
            Toast.makeText(this, R.string.scan_too_long, Toast.LENGTH_LONG).show()
            return false
        }
        link.start()
        log.add(Protocol.Scan(UUID.randomUUID().toString(), data, System.currentTimeMillis(), aimId, codeId, link.session.id, link.session.name))
        return true
    }

    /** "Keep running in the background": the saved setting is what counts. */
    var background: Boolean
        get() = prefs.getBoolean(KEY_BACKGROUND, false)
        set(on) {
            prefs.edit().putBoolean(KEY_BACKGROUND, on).apply()
            applyBackground()
        }

    /** Starts or stops the background service to match the setting. */
    fun applyBackground() {
        val intent = Intent(this, ScanService::class.java)
        if (background) ContextCompat.startForegroundService(this, intent) else stopService(intent)
    }

    // What the computer lists this scanner as. Honeywell names every unit "CT45", so unless
    // someone renamed it in Settings, add a few characters that differ per device.
    private fun deviceName(): String {
        val named = Settings.Global.getString(contentResolver, Settings.Global.DEVICE_NAME)
        if (!named.isNullOrBlank() && named != Build.MODEL) return named
        val id = Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID).orEmpty()
        return if (id.length >= 4) "${Build.MODEL} ${id.takeLast(4).uppercase()}" else Build.MODEL
    }

    private companion object {
        const val KEY_BACKGROUND = "background"
    }
}
