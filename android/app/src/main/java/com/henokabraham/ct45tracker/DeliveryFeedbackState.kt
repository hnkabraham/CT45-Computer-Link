package com.henokabraham.ct45tracker

/** Only new captures can make feedback; restored history and duplicate acknowledgements cannot. */
internal class DeliveryFeedbackState {
    enum class Signal { RECEIVED, WAITING }
    data class Scan(val id: String, val saved: Boolean, val sent: Boolean, val stopped: Boolean = false)
    private data class Capture(val at: Long, var waitingReported: Boolean = false)
    private val captures = linkedMapOf<String, Capture>()
    private var lastSignalAt = -750L
    val pending get() = captures.isNotEmpty()

    fun capture(id: String, now: Long) {
        captures[id] = Capture(now)
        if (captures.size > 256) captures.remove(captures.keys.first())
    }

    fun clear() { captures.clear(); lastSignalAt = -750L }

    fun poll(scans: List<Scan>, now: Long): Signal? {
        val byId = scans.associateBy { it.id }
        captures.entries.removeAll { (id, capture) ->
            now - capture.at > 60_000 || byId[id] == null || byId[id]?.stopped == true
        }
        val received = captures.keys.filter { byId[it]?.let { s -> s.saved && s.sent } == true }
        val waiting = captures.filter { (id, c) ->
            byId[id]?.let { it.saved && !it.sent } == true && !c.waitingReported && now - c.at >= 1500
        }.keys.toList()
        if (now - lastSignalAt < 750 || (received.isEmpty() && waiting.isEmpty())) return null
        // Keep distinct outcomes separate when a burst contains both; waiting takes priority.
        val signal = if (waiting.isNotEmpty()) Signal.WAITING else Signal.RECEIVED
        if (signal == Signal.WAITING) waiting.forEach { captures[it]?.waitingReported = true }
        else received.forEach { captures.remove(it) }
        lastSignalAt = now
        return signal
    }
}
