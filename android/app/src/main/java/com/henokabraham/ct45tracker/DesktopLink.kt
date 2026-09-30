package com.henokabraham.ct45tracker

import android.content.SharedPreferences
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import com.henokabraham.ct45tracker.ComputerDiscovery.Endpoint
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit
import java.util.UUID

/**
 * Keeps a WebSocket open to the paired computer, sends every unsent scan in [log], and marks
 * scans sent when the computer acknowledges them. Reconnects on its own, trying each address
 * from the pairing QR code in turn. All state lives on the main thread; OkHttp callbacks are
 * posted there.
 */
class DesktopLink(
    private val context: Context,
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
        data object NeedsNetwork : Status()
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
    private var secureClient: OkHttpClient? = null
    var bluetoothMode: Boolean = prefs.getBoolean("bluetoothMode", false)
        private set
    private var tunnel: BluetoothTunnel? = null
    fun useBluetooth(enabled: Boolean) {
        if (bluetoothMode == enabled) return
        bluetoothMode = enabled
        prefs.edit().putBoolean("bluetoothMode", enabled).apply()
        discovery.stop()
        failures = 0
        hostIndex = 0
        connect()
    }
    var session = Protocol.Session(prefs.getString("sessionId", "default")!!, prefs.getString("sessionName", "General")!!)
        private set
    var availableSessions: List<Protocol.Session> = emptyList()
        private set
    var supportsSessionSelection = false
        private set
    var sessionSelectionError: String? = null
        private set
    private var sessionRequest: String? = null
    val canSelectSession get() = status is Status.Connected && supportsSessionSelection && sessionRequest == null
    private val sessionOverdue = Runnable {
        sessionRequest = null
        sessionSelectionError = "No reply about the session. Check the current session, then try again."
        setStatus(status)
    }
    private var lastBluetoothAttempt = -7000L

    fun selectSession(id: String): Boolean {
        if (!canSelectSession || availableSessions.none { it.id == id }) return false
        if (id == session.id) return true
        val requestId = UUID.randomUUID().toString()
        sessionRequest = requestId
        sessionSelectionError = null
        if (socket?.send(Protocol.selectSession(id, requestId)) != true) {
            sessionRequest = null
            sessionSelectionError = "Could not request a session change. Reconnect and try again."
            setStatus(status)
            return false
        }
        main.postDelayed(sessionOverdue, 8000)
        setStatus(status)
        return true
    }

    fun discardScan(id: String): Boolean {
        if (!log.discard(id)) return false
        answered(id)
        return true
    }
    private var discovered: Endpoint? = null
    private var preferred: Endpoint? = pairing?.let { p ->
        prefs.getString(KEY_LAST_HOST, null)?.let { host ->
            val port = prefs.getInt("lastPort", p.port)
            try { Protocol.serverUrl(host, port); Endpoint(host, port) } catch (_: IllegalArgumentException) { null }
        }
    }
    private val discovery = ComputerDiscovery(context) { endpoint ->
        if (!bluetoothMode && status !is Status.Connected && status !is Status.PairingExpired && endpoint != discovered) {
            discovered = endpoint
            hostIndex = 0
            connect()
        }
    }
    private val connectivity = context.getSystemService(ConnectivityManager::class.java)
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) { main.post {
            if (!bluetoothMode && status is Status.Retrying) { discovery.stop(); pairing?.let { discovery.start(it.computerId) }; nudge() }
        } }
    }
    private val listeners = mutableListOf<() -> Unit>()

    private var socket: WebSocket? = null
    private var generation = 0 // callbacks from a replaced socket are ignored
    private var hostIndex = 0
    private var failures = 0
    private var welcomed = false
    private var started = false
    private val retry = Runnable { connect() }
    private val welcomeOverdue = Runnable { disconnect(); lost("No pairing reply from the computer") }
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
        try { connectivity.registerDefaultNetworkCallback(networkCallback) } catch (_: RuntimeException) {}
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
        discovery.stop()
        discovered = null
        preferred = null
        secureClient = null
        availableSessions = emptyList()
        supportsSessionSelection = false
        sessionSelectionError = null
        if (pairing?.computerId != p.computerId) updateSession(Protocol.Session())
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
        discovery.stop()
        discovered = null
        preferred = null
        secureClient = null
        availableSessions = emptyList()
        supportsSessionSelection = false
        updateSession(Protocol.Session())
        prefs.edit().remove(KEY_PAIRING).remove(KEY_LAST_HOST).apply()
        disconnect()
        setStatus(Status.NotPaired)
    }

    private fun connect() {
        disconnect()
        val p = pairing ?: return setStatus(Status.NotPaired)
        if (bluetoothMode) {
            discovery.stop()
            if (p.bluetoothService.isEmpty()) {
                setStatus(Status.NeedsNetwork)
                return
            }
            val wait = lastBluetoothAttempt + 7000L - SystemClock.elapsedRealtime()
            if (wait > 0) {
                setStatus(Status.Connecting("Bluetooth"))
                main.postDelayed(retry, wait)
                return
            }
            lastBluetoothAttempt = SystemClock.elapsedRealtime()
            val gen = ++generation
            welcomed = false
            setStatus(Status.Connecting("Bluetooth"))
            main.postDelayed(welcomeOverdue, 60000)
            tunnel = BluetoothTunnel(context).also { bridge ->
                bridge.start(p.bluetoothService,
                    ready = { port -> onMain(gen) { openSocket(p, Endpoint("127.0.0.1", port), gen) } },
                    failed = { reason -> onMain(gen) { lost(reason) } })
            }
            return
        }
        discovery.start(p.computerId)
        val endpoints = endpoints(p)
        val endpoint = endpoints[hostIndex % endpoints.size]
        val host = endpoint.host
        val gen = ++generation
        welcomed = false
        inFlight.clear()
        setStatus(Status.Connecting(host))
        main.postDelayed(welcomeOverdue, 8_000)
        openSocket(p, endpoint, gen)
    }

    private fun openSocket(p: Protocol.Pairing, endpoint: Endpoint, gen: Int) {
        val request = try {
            Request.Builder().url(Protocol.serverUrl(endpoint.host, endpoint.port))
                .header("X-CT45-Transport", if (bluetoothMode) "bluetooth" else "network").build()
        } catch (e: IllegalArgumentException) {
            // Also recover from a bad saved address without trapping the app in a crash loop.
            unpair()
            return
        }
        val tls = secureClient ?: PinnedTls.client(client, p.fingerprint).also { secureClient = it }
        socket = tls.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) = onMain(gen) {
                webSocket.send(Protocol.hello(p.token, deviceName, BuildConfig.VERSION_NAME))
            }

            override fun onMessage(webSocket: WebSocket, text: String) = onMain(gen) { handle(Protocol.parseServer(text), endpoint) }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = onMain(gen) {
                if (code == Protocol.CLOSE_BAD_TOKEN || code == Protocol.CLOSE_REPAIRED) {
                    // Nothing will retry until the user scans the new code, including the
                    // no-reply timer for scans that were on their way.
                    disconnect()
                    discovery.stop()
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

    private fun handle(msg: Protocol.ServerMessage, endpoint: Endpoint) {
        when (msg) {
            is Protocol.ServerMessage.Welcome -> {
                main.removeCallbacks(welcomeOverdue)
                welcomed = true
                failures = 0
                if (!bluetoothMode) preferred = endpoint
                discovery.stop()
                if (!bluetoothMode) prefs.edit().putString(KEY_LAST_HOST, endpoint.host).putInt("lastPort", endpoint.port).apply()
                updateSession(msg.session)
                availableSessions = msg.sessions
                supportsSessionSelection = msg.sessionControl
                sessionSelectionError = null
                setStatus(Status.Connected(msg.name.ifEmpty { pairing?.name.orEmpty() }))
                flush()
            }
            is Protocol.ServerMessage.SessionChanged -> {
                updateSession(msg.session)
                availableSessions = msg.sessions
                setStatus(status)
            }
            is Protocol.ServerMessage.SessionSelected -> {
                if (msg.requestId == sessionRequest) {
                    main.removeCallbacks(sessionOverdue)
                    sessionRequest = null
                    sessionSelectionError = null
                    setStatus(status)
                }
            }
            is Protocol.ServerMessage.Ack -> {
                answered(msg.id)
                log.markSent(msg.id)
            }
            is Protocol.ServerMessage.Error -> {
                if (msg.requestId != null && msg.requestId == sessionRequest) {
                    main.removeCallbacks(sessionOverdue)
                    sessionRequest = null
                    sessionSelectionError = msg.message
                    setStatus(status)
                    return
                }
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
            // Recover already-saved invalid entries without ever putting a frame large enough
            // to close the connection on the wire. Keep their contents as rejected history.
            if (!Protocol.canSend(scan)) { log.markRejected(scan.id); continue }
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
        disconnect()
        if (pairing == null) return setStatus(Status.NotPaired)
        // An address that never answered: try the next one from the QR code right away.
        val neverConnected = !welcomed
        failures++
        if (neverConnected) hostIndex++
        val tried = if (bluetoothMode) 1 else endpoints(pairing!!).size
        if (!bluetoothMode) discovery.start(pairing!!.computerId)
        // Android limits repeated BLE scan registrations. Keep retries below that limit even
        // when discovery succeeds immediately but a cached GATT endpoint cannot be opened.
        val delay = if (bluetoothMode) if (failures >= 5) 60_000L else backoff(failures).coerceAtLeast(7000L)
            else if (neverConnected && failures % tried != 0) 0L else backoff(failures / tried)
        setStatus(Status.Retrying(reason))
        main.postDelayed(retry, delay)
    }

    private fun backoff(round: Int) = (1000L shl round.coerceIn(0, 4)).coerceAtMost(15_000L)

    private fun disconnect() {
        main.removeCallbacks(sessionOverdue)
        if (sessionRequest != null) sessionSelectionError = "Connection interrupted. Check the current session after reconnecting."
        sessionRequest = null
        main.removeCallbacks(retry)
        main.removeCallbacks(welcomeOverdue)
        main.removeCallbacks(resend)
        stopAckTimer()
        inFlight.clear()
        generation++
        socket?.cancel()
        socket = null
        tunnel?.close()
        tunnel = null
    }

    private fun onMain(gen: Int, block: () -> Unit) {
        main.post { if (gen == generation) block() }
    }

    private fun setStatus(s: Status) {
        status = s
        listeners.toList().forEach { it() }
    }

    private fun endpoints(p: Protocol.Pairing) = (listOfNotNull(discovered, preferred) + p.hosts.map { Endpoint(it, p.port) }).distinct()

    private fun updateSession(next: Protocol.Session) {
        session = next
        prefs.edit().putString("sessionId", next.id).putString("sessionName", next.name).apply()
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
            return "${Protocol.PAIR_PREFIX}?v=2&id=${enc(p.computerId)}&fp=${p.fingerprint}&h=${enc(p.hosts.joinToString(","))}&p=${p.port}&t=${enc(p.token)}&n=${enc(p.name)}" + if (p.bluetoothService.isEmpty()) "" else "&bt=${enc(p.bluetoothService)}"
        }
    }
}
