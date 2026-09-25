package com.henokabraham.ct45tracker

import android.content.SharedPreferences
import android.os.Handler
import android.os.Looper
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit

/**
 * Keeps a WebSocket open to the paired computer, sends every unsent scan in [log], and marks
 * scans sent when the computer acknowledges them. Reconnects on its own, trying each address
 * from the pairing QR code in turn. All state lives on the main thread; OkHttp callbacks are
 * posted there.
 */
class DesktopLink(
    private val prefs: SharedPreferences,
    private val log: ScanLog,
    private val deviceName: String,
) {
    sealed class Status {
        data object NotPaired : Status()
        data class Connecting(val host: String) : Status()
        data class Connected(val computer: String) : Status()
        data class Retrying(val reason: String) : Status()
        /** The computer made a new pairing code; only scanning it again helps. */
        data object PairingExpired : Status()
    }

    var status: Status = Status.NotPaired
        private set
    var pairing: Protocol.Pairing? = loadPairing()
        private set

    private val main = Handler(Looper.getMainLooper())
    private val client = OkHttpClient.Builder()
        // Short, so a stale address in the pairing code doesn't hold up the next one.
        .connectTimeout(4, TimeUnit.SECONDS)
        // Only notices a computer that vanished without closing the connection. Kept slow to
        // spare the battery in background mode; unanswered scans are caught sooner below.
        .pingInterval(60, TimeUnit.SECONDS)
        .build()
    private val listeners = mutableListOf<() -> Unit>()

    private var socket: WebSocket? = null
    private var generation = 0 // callbacks from a replaced socket are ignored
    private var hostIndex = preferredHostIndex()
    private var failures = 0
    private var welcomed = false
    private var started = false
    private val retry = Runnable { connect() }
    // No reply to a scan in time means the connection is dead even if nothing has noticed yet:
    // reconnect, and the outbox sends it again. The clock starts at the oldest unanswered scan
    // and restarts only when the computer answers, so steady scanning can't keep pushing it
    // back.
    private val ackOverdue = Runnable {
        ackTimerRunning = false
        if (inFlight.isNotEmpty()) {
            disconnect()
            lost("No reply from the computer")
        }
    }
    private var ackTimerRunning = false
    // The computer couldn't save a scan; offer it again shortly rather than waiting for a
    // reconnect that may never come.
    private val resend = Runnable { flush() }
    private val inFlight = mutableSetOf<String>()

    fun addListener(l: () -> Unit) = listeners.add(l)
    fun removeListener(l: () -> Unit) = listeners.remove(l)

    fun start() {
        if (started) return
        started = true
        log.addListener { flush() }
        connect()
    }

    /** Reconnect now instead of waiting out the backoff, e.g. when the app comes to the front. */
    fun nudge() {
        if (status is Status.Retrying) {
            main.removeCallbacks(retry)
            connect()
        }
    }

    fun pair(candidate: Protocol.Pairing): Boolean {
        val p = Protocol.validatedPairing(candidate) ?: return false
        pairing = p
        prefs.edit()
            .putString(KEY_PAIRING, pairingToText(p))
            .remove(KEY_LAST_HOST)
            .apply()
        hostIndex = 0
        failures = 0
        connect()
        return true
    }

    fun unpair() {
        pairing = null
        prefs.edit().remove(KEY_PAIRING).remove(KEY_LAST_HOST).apply()
        disconnect()
        setStatus(Status.NotPaired)
    }

    private fun connect() {
        disconnect()
        val p = pairing ?: return setStatus(Status.NotPaired)
        val host = p.hosts[hostIndex % p.hosts.size]
        val gen = ++generation
        welcomed = false
        inFlight.clear()
        setStatus(Status.Connecting(host))
        val request = try {
            Request.Builder().url(Protocol.serverUrl(host, p.port)).build()
        } catch (e: IllegalArgumentException) {
            // Also recover from a bad saved address without trapping the app in a crash loop.
            unpair()
            return
        }
        socket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) = onMain(gen) {
                webSocket.send(Protocol.hello(p.token, deviceName, BuildConfig.VERSION_NAME))
            }

            override fun onMessage(webSocket: WebSocket, text: String) = onMain(gen) { handle(Protocol.parseServer(text), host) }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = onMain(gen) {
                if (code == Protocol.CLOSE_BAD_TOKEN || code == Protocol.CLOSE_REPAIRED) {
                    // Nothing will retry until the user scans the new code, including the
                    // no-reply timer for scans that were on their way.
                    disconnect()
                    setStatus(Status.PairingExpired)
                } else {
                    lost("Connection closed")
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = onMain(gen) {
                lost(t.message ?: t.javaClass.simpleName)
            }
        })
    }

    private fun handle(msg: Protocol.ServerMessage, host: String) {
        when (msg) {
            is Protocol.ServerMessage.Welcome -> {
                welcomed = true
                failures = 0
                prefs.edit().putString(KEY_LAST_HOST, host).apply()
                setStatus(Status.Connected(msg.name.ifEmpty { pairing?.name.orEmpty() }))
                flush()
            }
            is Protocol.ServerMessage.Ack -> {
                answered(msg.id)
                log.markSent(msg.id)
            }
            is Protocol.ServerMessage.Error -> {
                // bad-token is followed by a close with CLOSE_BAD_TOKEN and needs nothing here.
                val id = msg.id ?: return
                answered(id)
                when (msg.code) {
                    // The computer will never take this scan; sending it again would loop.
                    "bad-message" -> log.markRejected(id)
                    "save-failed" -> {
                        main.removeCallbacks(resend)
                        main.postDelayed(resend, RESEND_AFTER_SAVE_FAILED_MS)
                    }
                }
            }
            Protocol.ServerMessage.Unknown -> {}
        }
    }

    /** Sends every unsent scan not already on its way. */
    private fun flush() {
        val ws = socket ?: return
        if (!welcomed) return
        for (scan in log.outbox) {
            if (inFlight.add(scan.id)) {
                ws.send(Protocol.scan(scan, System.currentTimeMillis()))
                if (!ackTimerRunning) startAckTimer()
            }
        }
    }

    /** The computer replied about scan [id]: the connection is alive. */
    private fun answered(id: String) {
        inFlight.remove(id)
        stopAckTimer()
        if (inFlight.isNotEmpty()) startAckTimer()
    }

    private fun startAckTimer() {
        ackTimerRunning = true
        main.postDelayed(ackOverdue, ACK_TIMEOUT_MS)
    }

    private fun stopAckTimer() {
        ackTimerRunning = false
        main.removeCallbacks(ackOverdue)
    }

    private fun lost(reason: String) {
        socket = null
        if (pairing == null) return setStatus(Status.NotPaired)
        // An address that never answered: try the next one from the QR code right away.
        val neverConnected = !welcomed
        failures++
        if (neverConnected) hostIndex++
        val tried = pairing!!.hosts.size
        val delay = if (neverConnected && failures % tried != 0) 0L else backoff(failures / tried)
        setStatus(Status.Retrying(reason))
        main.postDelayed(retry, delay)
    }

    private fun backoff(round: Int) = (1000L shl round.coerceIn(0, 4)).coerceAtMost(15_000L)

    private fun disconnect() {
        main.removeCallbacks(retry)
        main.removeCallbacks(resend)
        stopAckTimer()
        inFlight.clear()
        generation++
        socket?.cancel()
        socket = null
    }

    private fun onMain(gen: Int, block: () -> Unit) {
        main.post { if (gen == generation) block() }
    }

    private fun setStatus(s: Status) {
        status = s
        listeners.toList().forEach { it() }
    }

    private fun preferredHostIndex(): Int {
        val last = prefs.getString(KEY_LAST_HOST, null) ?: return 0
        return pairing?.hosts?.indexOf(last)?.coerceAtLeast(0) ?: 0
    }

    private fun loadPairing(): Protocol.Pairing? {
        val saved = prefs.getString(KEY_PAIRING, null) ?: return null
        val parsed = Protocol.parsePairing(saved)
        if (parsed == null) prefs.edit().remove(KEY_PAIRING).remove(KEY_LAST_HOST).apply()
        return parsed
    }

    private companion object {
        const val KEY_PAIRING = "pairing"
        const val KEY_LAST_HOST = "lastHost"
        const val ACK_TIMEOUT_MS = 10_000L
        const val RESEND_AFTER_SAVE_FAILED_MS = 5_000L

        // Stored in the same form as the QR code so there's one parser.
        fun pairingToText(p: Protocol.Pairing): String {
            fun enc(s: String) = java.net.URLEncoder.encode(s, "UTF-8")
            return "${Protocol.PAIR_PREFIX}?h=${enc(p.hosts.joinToString(","))}&p=${p.port}&t=${enc(p.token)}&n=${enc(p.name)}"
        }
    }
}
