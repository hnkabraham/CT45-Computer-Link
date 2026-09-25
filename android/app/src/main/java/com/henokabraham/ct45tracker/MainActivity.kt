package com.henokabraham.ct45tracker

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.text.format.DateFormat
import android.view.KeyEvent
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.BaseAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.ListView
import android.widget.Switch
import android.widget.TextView
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class MainActivity : Activity() {
    private val app get() = application as ScanApp

    private lateinit var statusDot: View
    private lateinit var statusTitle: TextView
    private lateinit var statusDetail: TextView
    private lateinit var unpair: Button
    private lateinit var scannerMissing: TextView
    private lateinit var storageWarning: TextView
    private lateinit var lastScan: TextView
    private lateinit var lastScanMeta: TextView
    private lateinit var manual: EditText
    private lateinit var background: Switch
    private val adapter = ScanAdapter()

    private val renderListener = { render() }
    // "Turn off" in the notification changes the setting while this screen may be showing.
    private val prefsListener = SharedPreferences.OnSharedPreferenceChangeListener { _, _ ->
        background.isChecked = app.background
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        statusDot = findViewById(R.id.status_dot)
        statusTitle = findViewById(R.id.status_title)
        statusDetail = findViewById(R.id.status_detail)
        unpair = findViewById(R.id.unpair)
        scannerMissing = findViewById(R.id.scanner_missing)
        storageWarning = findViewById(R.id.storage_warning)
        lastScan = findViewById(R.id.last_scan)
        lastScanMeta = findViewById(R.id.last_scan_meta)
        manual = findViewById(R.id.manual)
        background = findViewById(R.id.background)
        findViewById<ListView>(R.id.recent).adapter = adapter

        findViewById<Button>(R.id.send).setOnClickListener { submitManual() }
        manual.setOnEditorActionListener { _, actionId, event ->
            val enter = event?.keyCode == KeyEvent.KEYCODE_ENTER
            if (actionId == EditorInfo.IME_ACTION_SEND || actionId == EditorInfo.IME_ACTION_DONE || enter) {
                if (event == null || event.action == KeyEvent.ACTION_DOWN) submitManual()
                true
            } else {
                false
            }
        }
        unpair.setOnClickListener { confirmUnpair() }
        background.setOnCheckedChangeListener { _, on -> setBackground(on) }

        app.link.start()
    }

    override fun onStart() {
        super.onStart()
        // The service may have been stopped behind the setting's back (force-stop, update).
        app.applyBackground()
        background.isChecked = app.background
        app.log.addListener(renderListener)
        app.link.addListener(renderListener)
        app.prefs.registerOnSharedPreferenceChangeListener(prefsListener)
        app.link.nudge()
        render()
    }

    override fun onStop() {
        app.log.removeListener(renderListener)
        app.link.removeListener(renderListener)
        app.prefs.unregisterOnSharedPreferenceChangeListener(prefsListener)
        super.onStop()
    }

    // Without background mode, the scanner is claimed only while this screen is in front, so
    // other apps get it back normally.
    override fun onResume() {
        super.onResume()
        app.screenShowing = true
        app.scanner.want(HoneywellScanner.User.SCREEN)
        // If the scanner falls back to typing (claim failed, or no Honeywell service), the
        // keystrokes land here; Enter sends them.
        manual.requestFocus()
        scannerMissing.visibility = if (app.scanner.available) View.GONE else View.VISIBLE
    }

    override fun onPause() {
        app.screenShowing = false
        app.scanner.unwant(HoneywellScanner.User.SCREEN)
        super.onPause()
    }

    private fun submitManual() {
        val text = manual.text.toString()
        manual.text.clear()
        // If the scanner ever types into the text box as well as sending the broadcast, drop
        // the typed copy.
        val echo = text.trim() == app.lastScannerScan && SystemClock.elapsedRealtime() - app.lastScannerScanAt < 1500
        if (!echo) app.handleScan(text, "", "", canPair = true)
    }

    private fun setBackground(on: Boolean) {
        if (on == app.background) return
        // Android 13 asks before showing notifications. Background mode runs either way; a
        // "Don't allow" only hides its notification.
        if (on && Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 0)
        }
        app.background = on
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        app.applyBackground() // lets the service post its notification now that it may
    }

    private fun confirmUnpair() {
        val name = app.link.pairing?.name?.ifEmpty { null } ?: getString(R.string.your_computer)
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.unpair_title, name))
            .setMessage(R.string.unpair_message)
            .setPositiveButton(R.string.unpair) { _, _ -> app.link.unpair() }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun render() {
        val link = app.link
        val computer = link.pairing?.name?.ifEmpty { null } ?: getString(R.string.your_computer)
        val waiting = app.log.state.unsent.size
        val waitingText = if (waiting > 0) resources.getQuantityString(R.plurals.waiting_count, waiting, waiting) else ""

        val (color, title, detail) = when (val s = link.status) {
            DesktopLink.Status.NotPaired -> Triple(R.color.idle, getString(R.string.status_not_paired), getString(R.string.status_not_paired_detail))
            is DesktopLink.Status.Connecting -> Triple(R.color.pending, getString(R.string.status_connecting, computer), s.host)
            is DesktopLink.Status.Connected -> Triple(
                R.color.ok,
                getString(R.string.status_connected, s.computer.ifEmpty { computer }),
                waitingText.ifEmpty { getString(R.string.status_connected_detail) },
            )
            is DesktopLink.Status.Retrying -> Triple(R.color.pending, getString(R.string.status_retrying, computer), getString(R.string.status_retrying_detail))
            DesktopLink.Status.PairingExpired -> Triple(R.color.bad, getString(R.string.status_expired), getString(R.string.status_expired_detail))
        }
        statusDot.backgroundTintList = ColorStateList.valueOf(getColor(color))
        statusTitle.text = title
        statusDetail.text = if (link.status is DesktopLink.Status.Connected || waitingText.isEmpty()) detail else "$detail $waitingText"
        unpair.visibility = if (link.pairing != null) View.VISIBLE else View.GONE
        storageWarning.visibility = if (app.log.hasSaveError) View.VISIBLE else View.GONE

        val latest = app.log.state.scans.firstOrNull()
        if (latest == null) {
            lastScan.text = getString(R.string.nothing_scanned)
            lastScan.setTextColor(getColor(R.color.muted))
            lastScan.textSize = 18f
            lastScanMeta.text = ""
        } else {
            lastScan.text = visible(latest.scan.data)
            lastScan.setTextColor(getColor(R.color.text))
            lastScan.textSize = 26f
            lastScanMeta.text = getString(R.string.scan_meta, time(latest.scan.scannedAt), getString(stateText(latest)))
        }
        adapter.notifyDataSetChanged()
    }

    private val timeFormat by lazy {
        SimpleDateFormat(DateFormat.getBestDateTimePattern(Locale.getDefault(), "jms"), Locale.getDefault())
    }

    private fun time(ms: Long) = timeFormat.format(Date(ms))

    private fun stateText(item: LoggedScan) = when {
        !app.log.isSaved(item.scan.id) -> R.string.not_saved
        item.sent -> R.string.sent
        item.rejected -> R.string.rejected
        else -> R.string.waiting
    }

    inner class ScanAdapter : BaseAdapter() {
        override fun getCount() = app.log.state.scans.size
        override fun getItem(position: Int) = app.log.state.scans[position]
        override fun getItemId(position: Int) = position.toLong()

        override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
            val view = convertView ?: LayoutInflater.from(parent.context).inflate(R.layout.item_scan, parent, false)
            val item = getItem(position)
            view.findViewById<TextView>(R.id.data).text = visible(item.scan.data)
            view.findViewById<TextView>(R.id.time).text = time(item.scan.scannedAt)
            view.findViewById<TextView>(R.id.state).apply {
                text = getString(stateText(item))
                setTextColor(getColor(if (!app.log.isSaved(item.scan.id) || item.rejected) R.color.bad else if (item.sent) R.color.ok else R.color.pending))
            }
            return view
        }
    }

    private companion object {
        // Control characters (GS separators in GS1 codes) shown as visible symbols.
        fun visible(s: String) = buildString {
            for (c in s) append(if (c < ' ') (0x2400 + c.code).toChar() else if (c == '\u007f') '␡' else c)
        }
    }
}
