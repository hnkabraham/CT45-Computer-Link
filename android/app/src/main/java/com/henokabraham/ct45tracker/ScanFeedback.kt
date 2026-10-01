package com.henokabraham.ct45tracker

import android.app.NotificationManager
import android.content.Context
import android.content.SharedPreferences
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager

/** Optional delivery feedback, shared by foreground and background scanning. Off by default. */
class ScanFeedback(private val context: Context, private val prefs: SharedPreferences, private val log: ScanLog) {
    enum class Mode { OFF, VIBRATION, SOUND, BOTH }
    private val main = Handler(Looper.getMainLooper())
    private val state = DeliveryFeedbackState()
    private var tone: ToneGenerator? = null
    private val check = Runnable { changed() }
    private val releaseTone = Runnable { tone?.release(); tone = null }
    var mode: Mode
        get() = Mode.entries.getOrElse(prefs.getInt("deliveryFeedback", 0)) { Mode.OFF }
        set(value) {
            prefs.edit().putInt("deliveryFeedback", value.ordinal).apply()
            state.clear()
            main.removeCallbacks(check)
            main.removeCallbacks(releaseTone)
            releaseTone.run()
            runCatching { vibrator()?.cancel() }
        }

    init { log.addListener { changed() } }

    fun capture(id: String) {
        if (mode != Mode.OFF) state.capture(id, SystemClock.elapsedRealtime())
    }

    private fun changed() {
        main.removeCallbacks(check)
        if (mode == Mode.OFF) { state.clear(); return }
        val signal = state.poll(log.state.scans.map {
            DeliveryFeedbackState.Scan(it.scan.id, log.isSaved(it.scan.id), it.sent, it.discarded || it.rejected)
        }, SystemClock.elapsedRealtime())
        if (signal != null) play(signal)
        if (state.pending) main.postDelayed(check, 1000)
    }

    @Suppress("DEPRECATION")
    private fun vibrator(): Vibrator? = if (Build.VERSION.SDK_INT >= 31)
        context.getSystemService(VibratorManager::class.java)?.defaultVibrator
    else context.getSystemService(Vibrator::class.java)

    private fun play(signal: DeliveryFeedbackState.Signal) {
        // Feedback must never interrupt scan persistence/delivery or override quiet settings.
        runCatching {
            val notifications = context.getSystemService(NotificationManager::class.java)
            if (notifications.currentInterruptionFilter != NotificationManager.INTERRUPTION_FILTER_ALL) return
            val audio = context.getSystemService(AudioManager::class.java)
            if (audio.ringerMode == AudioManager.RINGER_MODE_SILENT) return
            val received = signal == DeliveryFeedbackState.Signal.RECEIVED
            if (mode == Mode.VIBRATION || mode == Mode.BOTH) {
                val effect = if (received) VibrationEffect.createOneShot(45, VibrationEffect.DEFAULT_AMPLITUDE)
                    else VibrationEffect.createWaveform(longArrayOf(0, 70, 90, 70), -1)
                vibrator()?.vibrate(effect, AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION).build())
            }
            if ((mode == Mode.SOUND || mode == Mode.BOTH) && audio.ringerMode == AudioManager.RINGER_MODE_NORMAL
                && audio.getStreamVolume(AudioManager.STREAM_NOTIFICATION) > 0) {
                main.removeCallbacks(releaseTone)
                releaseTone.run()
                tone = ToneGenerator(AudioManager.STREAM_NOTIFICATION, 65).also {
                    it.startTone(if (received) ToneGenerator.TONE_PROP_ACK else ToneGenerator.TONE_PROP_BEEP2, 180)
                }
                main.postDelayed(releaseTone, 300)
            }
        }
    }
}
