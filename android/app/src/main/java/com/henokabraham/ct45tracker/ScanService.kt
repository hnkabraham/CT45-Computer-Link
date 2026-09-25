package com.henokabraham.ct45tracker

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.content.ContextCompat

/**
 * Background mode: keeps the scanner listener and the connection to the computer alive while
 * the screen is locked or another app is in front. Android requires the notification.
 */
class ScanService : Service() {
    private val app get() = application as ScanApp
    private val main = Handler(Looper.getMainLooper())
    private val refresh = Runnable { updateNotification() }
    // Coalesced: sending a backlog changes the log hundreds of times a second.
    private val update: () -> Unit = {
        main.removeCallbacks(refresh)
        main.postDelayed(refresh, 300)
    }

    // Some other app may have claimed the scanner while the screen was off; take it back.
    private val screenOn = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) = app.scanner.reclaim()
    }

    override fun onCreate() {
        super.onCreate()
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, getString(R.string.channel_name), NotificationManager.IMPORTANCE_LOW).apply {
                description = getString(R.string.channel_description)
                setShowBadge(false)
            },
        )
        // Must come before anything that could update the notification.
        startForeground(NOTIFICATION_ID, buildNotification())

        app.scanner.want(HoneywellScanner.User.BACKGROUND)
        app.link.start()
        app.link.addListener(update)
        app.log.addListener(update)
        ContextCompat.registerReceiver(this, screenOn, IntentFilter(Intent.ACTION_SCREEN_ON), ContextCompat.RECEIVER_NOT_EXPORTED)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_TURN_OFF) {
            app.background = false // stops this service
            return START_NOT_STICKY
        }
        // Android restarting us after killing the process, but the setting was turned off since.
        if (!app.background) {
            stopSelf()
            return START_NOT_STICKY
        }
        // Also reached when notifications were just allowed: show it now, not at the next scan.
        updateNotification()
        return START_STICKY
    }

    override fun onDestroy() {
        main.removeCallbacks(refresh)
        unregisterReceiver(screenOn)
        app.link.removeListener(update)
        app.log.removeListener(update)
        app.scanner.unwant(HoneywellScanner.User.BACKGROUND)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun updateNotification() {
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, buildNotification())
    }

    private fun buildNotification(): Notification {
        val computer = app.link.pairing?.name?.ifEmpty { null } ?: getString(R.string.your_computer)
        val waiting = app.log.state.unsent.size
        val waitingText = if (waiting > 0) resources.getQuantityString(R.plurals.waiting_count, waiting, waiting) else null
        val (title, text) = if (app.log.hasSaveError) {
            getString(R.string.storage_error_title) to getString(R.string.storage_error_detail)
        } else when (app.link.status) {
            DesktopLink.Status.NotPaired -> getString(R.string.status_not_paired) to getString(R.string.status_not_paired_detail)
            is DesktopLink.Status.Connecting -> getString(R.string.status_connecting, computer) to waitingText
            is DesktopLink.Status.Connected -> getString(R.string.notification_connected, computer) to (waitingText ?: getString(R.string.notification_ready))
            is DesktopLink.Status.Retrying -> getString(R.string.status_retrying, computer) to (waitingText ?: getString(R.string.notification_retrying))
            DesktopLink.Status.PairingExpired -> getString(R.string.status_expired) to getString(R.string.status_expired_detail)
        }
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val turnOff = PendingIntent.getService(
            this, 1,
            Intent(this, ScanService::class.java).setAction(ACTION_TURN_OFF),
            PendingIntent.FLAG_IMMUTABLE,
        )
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_scan)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .addAction(Notification.Action.Builder(null, getString(R.string.turn_off), turnOff).build())
            .build()
    }

    private companion object {
        const val CHANNEL = "background"
        const val NOTIFICATION_ID = 1
        const val ACTION_TURN_OFF = "com.henokabraham.ct45tracker.TURN_OFF"
    }
}

/** Brings background mode back after a restart. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) (context.applicationContext as ScanApp).applyBackground()
    }
}
