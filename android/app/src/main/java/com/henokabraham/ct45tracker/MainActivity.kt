package com.henokabraham.ct45tracker

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.SharedPreferences
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.net.Uri
import android.provider.Settings
import android.text.format.DateFormat
import android.view.KeyEvent
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.BaseAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.ListView
import android.widget.Switch
import android.widget.TextView
import android.widget.PopupMenu
import android.widget.Toast
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class MainActivity : Activity() {
    private val app get() = application as ScanApp

    private lateinit var statusDot: View
    private lateinit var statusTitle: TextView
    private lateinit var statusDetail: TextView
    private lateinit var connectionMore: Button
    private lateinit var waitingStatus: TextView
    private lateinit var sessionMode: Button
    private lateinit var sessionError: TextView
    private lateinit var sessionHint: TextView
    private lateinit var sessionLabel: TextView
    private lateinit var retryNow: Button
    private lateinit var connectionActions: View
    private lateinit var settingsToggle: Button
    private lateinit var settingsPanel: View
    private lateinit var feedbackMode: Button
    private var page = "scan"
    private var manualExpanded = false
    private lateinit var header: View
    private lateinit var recent: ListView
    private lateinit var useNetwork: Button
    private lateinit var scannerMissing: TextView
    private lateinit var storageWarning: TextView
    private lateinit var lastScan: TextView
    private lateinit var lastScanMeta: TextView
    private lateinit var manual: EditText
    private lateinit var background: Switch
    private lateinit var connectionMode: Button
    private val adapter = ScanAdapter()

    private val renderListener = { render() }
    // "Turn off" in the notification changes the setting while this screen may be showing.
    private val prefsListener = SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
        if (key in setOf("background", "deliveryFeedback")) render()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        // The XML attribute requires API 31; the View property also works on Android 8–11.
        findViewById<View>(R.id.app_logo).clipToOutline = true
        page = savedInstanceState?.getString("page")?.takeIf { it in setOf("scan", "history", "settings") } ?: "scan"
        manualExpanded = savedInstanceState?.getBoolean("manualExpanded") ?: false
        recent = findViewById(R.id.recent)
        header = layoutInflater.inflate(R.layout.scan_header, recent, false)
        recent.addHeaderView(header, null, false)
        statusDot = header.findViewById(R.id.status_dot)
        statusTitle = header.findViewById(R.id.status_title)
        statusDetail = header.findViewById(R.id.status_detail)
        connectionMore = findViewById(R.id.connection_more)
        waitingStatus = header.findViewById(R.id.waiting_status)
        sessionMode = header.findViewById(R.id.session_mode)
        sessionError = header.findViewById(R.id.session_error)
        sessionHint = header.findViewById(R.id.session_hint)
        sessionLabel = header.findViewById(R.id.session_label)
        retryNow = header.findViewById(R.id.retry_now)
        connectionActions = header.findViewById(R.id.connection_actions)
        retryNow.setOnClickListener { app.link.retryNow() }
        header.findViewById<Button>(R.id.connection_help).setOnClickListener { showConnectionHelp() }
        settingsToggle = findViewById(R.id.settings_toggle)
        settingsPanel = header.findViewById(R.id.settings_panel)
        settingsToggle.setOnClickListener { showPage("settings") }
        findViewById<Button>(R.id.nav_scan).setOnClickListener { showPage("scan") }
        findViewById<Button>(R.id.nav_history).setOnClickListener { showPage("history") }
        header.findViewById<Button>(R.id.see_history).setOnClickListener { showPage("history") }
        feedbackMode = header.findViewById(R.id.feedback_mode)
        feedbackMode.setOnClickListener { chooseFeedback() }
        useNetwork = header.findViewById(R.id.use_network)
        useNetwork.setOnClickListener { app.link.useBluetooth(false) }
        sessionMode.setOnClickListener { chooseSession() }
        scannerMissing = header.findViewById(R.id.scanner_missing)
        storageWarning = header.findViewById(R.id.storage_warning)
        lastScan = header.findViewById(R.id.last_scan)
        lastScanMeta = header.findViewById(R.id.last_scan_meta)
        manual = findViewById(R.id.manual)
        background = header.findViewById(R.id.background)
        connectionMode = header.findViewById(R.id.connection_mode)
        connectionMode.setOnClickListener {
            AlertDialog.Builder(this).setTitle(R.string.connection_mode)
                .setSingleChoiceItems(arrayOf(getString(R.string.connection_network), getString(R.string.connection_bluetooth)), if (app.link.bluetoothMode) 1 else 0) { dialog, which ->
                    dialog.dismiss()
                    if (which == 1 && Build.VERSION.SDK_INT < 29) {
                        AlertDialog.Builder(this).setMessage(R.string.bluetooth_requires_android_10)
                            .setPositiveButton(android.R.string.ok, null).show()
                    } else if (which == 1 && !BluetoothTunnel.permitted(this)) {
                        requestPermissions(BluetoothTunnel.permissions(), 1)
                    } else app.link.useBluetooth(which == 1)
                }.setNegativeButton(R.string.cancel, null).show()
        }
        recent.apply {
            adapter = this@MainActivity.adapter
            setOnItemClickListener { _, _, position, _ -> (getItemAtPosition(position) as? LoggedScan)?.let { showScan(it) } }
            setOnItemLongClickListener { _, _, position, _ ->
                (getItemAtPosition(position) as? LoggedScan)?.let { showScan(it); true } ?: false
            }
        }

        findViewById<Button>(R.id.manual_toggle).setOnClickListener { showManual(true) }
        findViewById<Button>(R.id.manual_close).setOnClickListener { showManual(false) }
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
        connectionMore.setOnClickListener {
            PopupMenu(this, connectionMore).apply {
                menu.add(R.string.connection_help).setOnMenuItemClickListener { showConnectionHelp(); true }
                menu.add(R.string.delivery_feedback).setOnMenuItemClickListener { chooseFeedback(); true }
                if (app.link.pairing != null) menu.add(R.string.unpair).setOnMenuItemClickListener { confirmUnpair(); true }
                show()
            }
        }
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

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString("page", page)
        outState.putBoolean("manualExpanded", manualExpanded)
        super.onSaveInstanceState(outState)
    }

    private fun showPage(destination: String) {
        page = destination
        hideKeyboard()
        render()
        recent.setSelection(0)
    }

    private fun hideKeyboard() {
        getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(manual.windowToken, 0)
    }

    private fun showManual(open: Boolean) {
        manualExpanded = open
        if (open) page = "scan"
        render()
        if (open) {
            manual.requestFocus()
            getSystemService(InputMethodManager::class.java).showSoftInput(manual, InputMethodManager.SHOW_IMPLICIT)
        } else hideKeyboard()
    }

    // Preserve keyboard-wedge fallback without leaving the input field open during scanning.
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        // ListView consumes Tab as row navigation. Keep Tab for moving between controls,
        // even when a connection update refreshes the list; arrow keys still navigate rows.
        if (::recent.isInitialized && currentFocus === recent && event.action == KeyEvent.ACTION_DOWN &&
            event.keyCode == KeyEvent.KEYCODE_TAB && !event.isCtrlPressed && !event.isAltPressed) {
            val target = when {
                event.isShiftPressed -> connectionMore
                page == "scan" && manualExpanded -> manual
                page == "scan" -> findViewById<View>(R.id.manual_toggle)
                else -> findViewById<View>(R.id.nav_scan)
            }
            if (target.requestFocus()) return true
        }
        if (::manual.isInitialized && event.action == KeyEvent.ACTION_DOWN && event.unicodeChar >= 32 &&
            !(event.keyCode == KeyEvent.KEYCODE_SPACE && currentFocus is Button) &&
            !event.isCtrlPressed && !event.isAltPressed) {
            if (page != "scan" || !manualExpanded) {
                page = "scan"
                manualExpanded = true
                render()
            }
            manual.requestFocus()
            // The newly visible editor may not receive focus until its first layout.
            // Deliver each character directly so a fast scanner cannot lose its prefix.
            return manual.dispatchKeyEvent(event)
        }
        return super.dispatchKeyEvent(event)
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        when {
            page != "scan" -> showPage("scan")
            manualExpanded -> showManual(false)
            else -> super.onBackPressed()
        }
    }

    private fun openSettings(action: String, appDetails: Boolean = false) {
        try { startActivity(Intent(action).apply { if (appDetails) data = Uri.parse("package:$packageName") }) }
        catch (_: RuntimeException) { Toast.makeText(this, R.string.settings_unavailable, Toast.LENGTH_LONG).show() }
    }

    private fun showConnectionHelp() {
        val bluetooth = app.link.bluetoothMode
        val introduction = when (app.link.status) {
            DesktopLink.Status.NotPaired -> getString(R.string.status_not_paired_detail)
            DesktopLink.Status.PairingExpired -> getString(R.string.status_expired_detail)
            DesktopLink.Status.NeedsNetwork -> getString(R.string.connection_action_detail)
            else -> ""
        }
        val detail = getString(if (bluetooth) R.string.help_bluetooth else R.string.help_network)
        AlertDialog.Builder(this).setTitle(R.string.connection_help)
            .setMessage(listOf(introduction, detail).filter { it.isNotEmpty() }.joinToString("\n\n"))
            .setPositiveButton(android.R.string.ok, null)
            .setNegativeButton(R.string.app_settings) { _, _ -> openSettings(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, true) }
            .setNeutralButton(if (bluetooth) R.string.bluetooth_settings else R.string.wifi_settings) { _, _ ->
                openSettings(if (bluetooth) Settings.ACTION_BLUETOOTH_SETTINGS else Settings.ACTION_WIFI_SETTINGS)
            }.show()
    }

    private val feedbackLabels get() = arrayOf(R.string.feedback_off, R.string.feedback_vibrate, R.string.feedback_sound, R.string.feedback_both)

    private fun chooseFeedback() {
        AlertDialog.Builder(this)
            .setCustomTitle(TextView(this).apply {
                text = getString(R.string.feedback_title)
                setTextColor(getColor(R.color.text))
                val padding = (16 * resources.displayMetrics.density).toInt()
                setPadding(padding, padding, padding, padding / 2)
                textSize = 14f
            })
            .setSingleChoiceItems(feedbackLabels.map { getString(it) }.toTypedArray(), app.feedback.mode.ordinal) { dialog, which ->
                app.feedback.mode = ScanFeedback.Mode.entries[which]
                render()
                dialog.dismiss()
            }.setNegativeButton(R.string.cancel, null).show()
    }

    // Without background mode, the scanner is claimed only while this screen is in front, so
    // other apps get it back normally.
    override fun onResume() {
        super.onResume()
        app.screenShowing = true
        app.scanner.want(HoneywellScanner.User.SCREEN)
        // Resume quietly; the entry button opens the keyboard explicitly when needed.
        hideKeyboard()
        render()
    }

    override fun onPause() {
        app.screenShowing = false
        app.scanner.unwant(HoneywellScanner.User.SCREEN)
        super.onPause()
    }

    private fun submitManual() {
        val text = manual.text.toString()
        if (!text.startsWith("${Protocol.PAIR_PREFIX}?") && text.trimEnd('\r', '\n').length > Protocol.MAX_DATA_LENGTH) {
            manual.error = getString(R.string.scan_too_long)
            return
        }
        // If the scanner ever types into the text box as well as sending the broadcast, drop
        // the typed copy.
        val echo = text.trim() == app.lastScannerScan && SystemClock.elapsedRealtime() - app.lastScannerScanAt < 1500
        if (echo || app.handleScan(text, "", "", canPair = true)) manual.text.clear()
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
        if (requestCode == 1) {
            if (BluetoothTunnel.permitted(this)) app.link.useBluetooth(true)
            else Toast.makeText(this, R.string.bluetooth_denied, Toast.LENGTH_LONG).show()
        }
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

    private fun chooseSession() {
        val link = app.link
        if (!link.canSelectSession) return
        val choices = link.availableSessions.toList()
        var selected = choices.indexOfFirst { it.id == link.session.id }
        val dialog = AlertDialog.Builder(this).setTitle(R.string.choose_session)
            .setSingleChoiceItems(choices.map { it.name }.toTypedArray(), selected) { _, which -> selected = which }
            .setPositiveButton(R.string.change_session) { _, _ ->
                if (selected in choices.indices && !link.selectSession(choices[selected].id))
                    Toast.makeText(this, R.string.session_switch_failed, Toast.LENGTH_LONG).show()
            }.setNegativeButton(R.string.cancel, null).create()
        // A custom title keeps the shared-session notice visible above the choice list.
        dialog.setCustomTitle(TextView(this).apply {
            text = getString(R.string.session_picker_title)
            val padding = (16 * resources.displayMetrics.density).toInt()
            setPadding(padding, padding, padding, padding / 2)
            textSize = 15f
        })
        dialog.show()
    }

    private fun showScan(item: LoggedScan) {
        val actions = AlertDialog.Builder(this)
            .setTitle(getString(stateText(item)) + " · " + item.scan.sessionName)
            .setMessage(visible(item.scan.data))
            .setPositiveButton(R.string.copy_scan) { _, _ ->
                getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("Barcode", item.scan.data))
                Toast.makeText(this, R.string.copied_scan, Toast.LENGTH_SHORT).show()
            }.setNegativeButton(R.string.cancel, null)
        if (!item.done && app.log.isSaved(item.scan.id)) actions.setNeutralButton(R.string.discard_scan) { _, _ ->
            AlertDialog.Builder(this).setTitle(R.string.discard_title).setMessage(R.string.discard_detail)
                .setNegativeButton(R.string.cancel, null)
                .setPositiveButton(R.string.discard_scan) { _, _ ->
                    if (!app.link.discardScan(item.scan.id)) Toast.makeText(this, R.string.discard_failed, Toast.LENGTH_LONG).show()
                }.show()
        }
        actions.show()
    }

    private fun render() {
        val link = app.link
        background.isChecked = app.background
        settingsPanel.visibility = if (page == "settings") View.VISIBLE else View.GONE
        header.findViewById<View>(R.id.session_panel).visibility = if (page == "settings") View.GONE else View.VISIBLE
        header.findViewById<View>(R.id.scan_overview).visibility = if (page == "scan") View.VISIBLE else View.GONE
        header.findViewById<View>(R.id.history_heading).visibility = if (page == "settings") View.GONE else View.VISIBLE
        header.findViewById<TextView>(R.id.history_title).setText(if (page == "history") R.string.nav_history else R.string.recent)
        header.findViewById<View>(R.id.see_history).visibility = if (page == "scan") View.VISIBLE else View.GONE
        header.findViewById<View>(R.id.history_empty).visibility = if (page != "settings" && app.log.state.scans.isEmpty()) View.VISIBLE else View.GONE
        header.findViewById<TextView>(R.id.scan_summary).apply {
            text = getString(R.string.scan_summary, app.log.state.scans.size, app.log.state.unsent.size)
            visibility = if (page == "settings") View.GONE else View.VISIBLE
        }
        for ((id, name) in listOf(R.id.nav_scan to "scan", R.id.nav_history to "history", R.id.settings_toggle to "settings")) {
            findViewById<Button>(id).apply {
                isSelected = page == name
                setTextColor(getColor(if (isSelected) R.color.accent else R.color.muted))
                compoundDrawableTintList = ColorStateList.valueOf(currentTextColor)
            }
        }
        val entryOpen = page == "scan" && manualExpanded
        findViewById<View>(R.id.manual_panel).visibility = if (entryOpen) View.VISIBLE else View.GONE
        findViewById<View>(R.id.manual_toggle).visibility = if (page == "scan" && !entryOpen) View.VISIBLE else View.GONE
        scannerMissing.visibility = if (page == "scan" && !app.scanner.available) View.VISIBLE else View.GONE
        feedbackMode.text = getString(R.string.feedback_setting, getString(feedbackLabels[app.feedback.mode.ordinal]))
        connectionMode.contentDescription = getString(R.string.change_connection) + ": " + getString(if (link.bluetoothMode) R.string.connection_bluetooth else R.string.connection_network)
        sessionMode.isEnabled = link.canSelectSession
        val sessionHintText = when {
            link.status !is DesktopLink.Status.Connected -> R.string.session_offline
            !link.supportsSessionSelection -> R.string.session_unsupported
            link.sessionSelectionPending -> R.string.session_changing
            link.availableSessions.isEmpty() -> R.string.session_empty
            else -> null
        }
        sessionHint.text = sessionHintText?.let { getString(it) }.orEmpty()
        sessionHint.visibility = if (sessionHintText == null) View.GONE else View.VISIBLE
        sessionMode.text = getString(R.string.session_choice, link.session.name)
        sessionMode.contentDescription = getString(R.string.change_session) + ": " + link.session.name
        sessionLabel.setText(R.string.scanning_into)
        connectionActions.visibility = if (link.status is DesktopLink.Status.Connected) View.GONE else View.VISIBLE
        retryNow.visibility = if (link.status is DesktopLink.Status.Retrying || link.status is DesktopLink.Status.Connecting) View.VISIBLE else View.GONE
        retryNow.isEnabled = link.status is DesktopLink.Status.Retrying
        retryNow.text = getString(if (link.status is DesktopLink.Status.Connecting) R.string.retry_connecting else R.string.retry_now)
        sessionError.text = link.sessionSelectionError.orEmpty()
        sessionError.visibility = if (link.sessionSelectionError == null) View.GONE else View.VISIBLE
        useNetwork.visibility = if (link.status is DesktopLink.Status.NeedsNetwork) View.VISIBLE else View.GONE
        val computer = link.pairing?.name?.ifEmpty { null } ?: getString(R.string.your_computer)
        val waiting = app.log.state.unsent.size
        val waitingText = if (waiting > 0) resources.getQuantityString(R.plurals.waiting_count, waiting, waiting) else ""

        val (color, title, detail) = when (val s = link.status) {
            DesktopLink.Status.NotPaired -> Triple(R.color.idle, getString(R.string.status_not_paired), getString(R.string.status_not_paired_detail))
            is DesktopLink.Status.Connecting -> Triple(R.color.pending, getString(R.string.status_connecting, computer), s.host)
            is DesktopLink.Status.Connected -> Triple(
                R.color.ok,
                getString(R.string.status_connected, s.computer.ifEmpty { computer }),
                getString(if (link.bluetoothMode) R.string.bluetooth_connected_detail else R.string.status_connected_detail),
            )
            is DesktopLink.Status.Retrying -> Triple(R.color.pending, getString(R.string.status_retrying, computer), if (link.bluetoothMode) getString(R.string.bluetooth_retrying_detail, s.reason) else getString(R.string.status_retrying_detail))
            DesktopLink.Status.PairingExpired -> Triple(R.color.bad, getString(R.string.status_expired), getString(R.string.status_expired_detail))
            DesktopLink.Status.NeedsNetwork -> Triple(R.color.pending, getString(R.string.connection_action_title), getString(R.string.connection_action_detail))
        }
        statusDot.backgroundTintList = ColorStateList.valueOf(getColor(color))
        statusTitle.text = title
        statusDetail.text = if (link.status is DesktopLink.Status.Connected)
            getString(R.string.connection_compact, getString(if (link.bluetoothMode) R.string.connection_bluetooth else R.string.connection_network))
            else detail
        waitingStatus.text = waitingText
        waitingStatus.visibility = if (waitingText.isEmpty()) View.GONE else View.VISIBLE
        storageWarning.visibility = if (app.log.hasSaveError) View.VISIBLE else View.GONE

        val latest = app.log.state.scans.firstOrNull()
        if (latest == null) {
            lastScan.text = getString(R.string.nothing_scanned)
            lastScan.setTextColor(getColor(R.color.muted))
            lastScan.textSize = 18f
            lastScanMeta.text = ""
        } else {
            lastScan.text = preview(latest.scan.data)
            lastScan.setTextColor(getColor(R.color.text))
            lastScan.textSize = 23f
            lastScanMeta.text = getString(R.string.scan_meta, time(latest.scan.scannedAt), getString(stateText(latest)), latest.scan.sessionName)
            lastScanMeta.setTextColor(getColor(if (!app.log.isSaved(latest.scan.id) || latest.rejected) R.color.bad else if (latest.sent) R.color.ok else R.color.pending))
        }
        adapter.notifyDataSetChanged()
    }

    private val timeFormat by lazy {
        SimpleDateFormat(DateFormat.getBestDateTimePattern(Locale.getDefault(), "jms"), Locale.getDefault())
    }

    private fun time(ms: Long) = timeFormat.format(Date(ms))

    private fun stateText(item: LoggedScan) = when {
        !app.log.isSaved(item.scan.id) -> R.string.not_saved
        item.discarded && item.sent -> R.string.discarded_received
        item.discarded -> R.string.discarded
        item.sent -> R.string.sent
        item.rejected -> R.string.rejected
        else -> R.string.waiting
    }

    inner class ScanAdapter : BaseAdapter() {
        override fun getCount() = when (page) { "settings" -> 0; "scan" -> minOf(3, app.log.state.scans.size); else -> app.log.state.scans.size }
        override fun getItem(position: Int) = app.log.state.scans[position]
        override fun getItemId(position: Int) = position.toLong()

        override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
            val view = convertView ?: LayoutInflater.from(parent.context).inflate(R.layout.item_scan, parent, false)
            val item = getItem(position)
            view.findViewById<TextView>(R.id.data).text = preview(item.scan.data)
            view.findViewById<TextView>(R.id.time).text = time(item.scan.scannedAt)
            view.findViewById<TextView>(R.id.state).apply {
                text = getString(stateText(item))
                setTextColor(getColor(if (!app.log.isSaved(item.scan.id) || item.rejected) R.color.bad else if (item.sent) R.color.ok else R.color.pending))
            }
            return view
        }
    }

    private companion object {
        // Keep list/accessibility nodes small even for rejected entries from older versions.
        // Opening a row or copying it still uses the complete, unmodified barcode.
        fun preview(s: String): String {
            val end = s.offsetByCodePoints(0, minOf(160, s.codePointCount(0, s.length)))
            return visible(s.substring(0, end)) + if (end < s.length) "…" else ""
        }

        // Control characters (GS separators in GS1 codes) shown as visible symbols.
        fun visible(s: String) = buildString {
            for (c in s) append(if (c < ' ') (0x2400 + c.code).toChar() else if (c == '\u007f') '␡' else c)
        }
    }
}
