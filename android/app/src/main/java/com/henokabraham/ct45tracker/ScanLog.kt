package com.henokabraham.ct45tracker

import android.content.SharedPreferences
import android.os.Handler
import android.os.Looper
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * One scan as shown on the device: `sent` once the computer has acknowledged it, `rejected` if
 * the computer or local validation cannot accept it, or `discarded` after a confirmed local
 * stop-retrying action. A late acknowledgement may coexist with the discard marker.
 */
data class LoggedScan(val scan: Protocol.Scan, val sent: Boolean, val rejected: Boolean = false, val discarded: Boolean = false) {
    val done get() = sent || rejected || discarded
}

/**
 * Scans in newest-first order. Unsent ones are the outbox: they're sent (again) on every
 * connect until the computer acknowledges them, so nothing scanned while out of Wi-Fi is lost.
 * Sent/rejected ones are kept as a short history; explicit discard markers remain durable.
 */
data class ScanLogState(val scans: List<LoggedScan> = emptyList()) {
    val unsent: List<Protocol.Scan> get() = scans.filter { !it.done }.map { it.scan }.reversed()

    fun add(scan: Protocol.Scan) = trimmed(listOf(LoggedScan(scan, sent = false)) + scans)

    fun markSent(id: String) = trimmed(scans.map { if (it.scan.id == id) it.copy(sent = true) else it })

    fun markRejected(id: String) = trimmed(scans.map { if (it.scan.id == id && !it.sent) it.copy(rejected = true) else it })

    fun discard(id: String) = copy(scans = scans.map { if (it.scan.id == id && !it.done) it.copy(discarded = true) else it })

    // Never drops an unsent scan, however many pile up.
    private fun trimmed(list: List<LoggedScan>): ScanLogState {
        var doneKept = 0
        return ScanLogState(list.filter { !it.done || it.discarded || ++doneKept <= KEEP_SENT })
    }

    fun toJson(): String = JSONArray(
        scans.map { (s, sent, rejected, discarded) ->
            JSONObject()
                .put("id", s.id)
                .put("data", s.data)
                .put("scannedAt", s.scannedAt)
                .put("aimId", s.aimId)
                .put("codeId", s.codeId)
                .put("sessionId", s.sessionId)
                .put("sessionName", s.sessionName)
                .put("sent", sent)
                .put("rejected", rejected)
                .put("discarded", discarded)
        },
    ).toString()

    companion object {
        const val KEEP_SENT = 100

        fun fromJson(text: String?): ScanLogState {
            if (text.isNullOrEmpty()) return ScanLogState()
            return try {
                val arr = JSONArray(text)
                ScanLogState(
                    (0 until arr.length()).map { i ->
                        val o = arr.getJSONObject(i)
                        LoggedScan(
                            Protocol.Scan(
                                id = o.getString("id"),
                                data = o.getString("data"),
                                scannedAt = o.getLong("scannedAt"),
                                aimId = o.optString("aimId"),
                                codeId = o.optString("codeId"),
                                sessionId = o.optString("sessionId", "default"),
                                sessionName = o.optString("sessionName", "General"),
                            ),
                            sent = o.optBoolean("sent"),
                            rejected = o.optBoolean("rejected"),
                            discarded = o.optBoolean("discarded"),
                        )
                    },
                )
            } catch (e: Exception) {
                ScanLogState()
            }
        }
    }
}

/** ScanLogState saved to disk. Main thread only. */
class ScanLog internal constructor(
    initial: String?,
    private val persist: (String) -> Boolean,
    private val schedule: (Runnable, Long) -> Unit,
    private val cancel: (Runnable) -> Unit,
) {
    constructor(prefs: SharedPreferences) : this(prefs, Handler(Looper.getMainLooper()))

    private constructor(prefs: SharedPreferences, main: Handler) : this(
        prefs.getString(KEY, null),
        { text ->
            // A failed commit may still update SharedPreferences' in-memory value. Change an
            // attempt marker too, so retrying identical JSON always requests a disk write.
            prefs.edit().putString(KEY, text).putString("scanSaveAttempt", UUID.randomUUID().toString()).commit()
        },
        { task, delay -> main.postDelayed(task, delay); Unit },
        { task -> main.removeCallbacks(task) },
    )

    var state = ScanLogState.fromJson(initial)
        private set
    var hasSaveError = false
        private set
    private val unsavedIds = mutableSetOf<String>()
    /** Only durable scans may be sent, including when a reconnect happens during a save error. */
    val outbox: List<Protocol.Scan> get() = state.unsent.filter { isSaved(it.id) }
    fun isSaved(id: String) = id !in unsavedIds

    private val listeners = mutableListOf<() -> Unit>()
    private var savePending = false
    private val saveNow = Runnable {
        savePending = false
        save()
    }

    fun addListener(l: () -> Unit) = listeners.add(l)
    fun removeListener(l: () -> Unit) = listeners.remove(l)

    /** Attempts a synchronous save. On failure the scan stays in memory, visibly not saved. */
    fun add(scan: Protocol.Scan) {
        state = state.add(scan)
        unsavedIds.add(scan.id)
        cancel(saveNow)
        savePending = false
        save()
    }

    // Answers from the computer are saved at most every 100 ms, so sending a backlog of
    // hundreds of scans doesn't rewrite the whole list once per scan. Losing one of these to a
    // crash only means the scan is sent again, and the computer ignores repeats.
    fun markSent(id: String) = updateSoon(state.markSent(id))
    fun markRejected(id: String) = updateSoon(state.markRejected(id))

    /** Persist the local discard marker before changing the queue. A late ack can still
     * mark this record sent: discarding cannot undo delivery on the computer. */
    fun discard(id: String): Boolean {
        if (!isSaved(id) || state.scans.none { it.scan.id == id && !it.done }) return false
        val next = state.discard(id)
        val saved = try { persist(next.toJson()) } catch (_: Exception) { false }
        if (!saved) {
            hasSaveError = true
            scheduleSave(RETRY_MS)
            listeners.toList().forEach { it() }
            return false
        }
        state = next
        hasSaveError = false
        unsavedIds.clear()
        cancel(saveNow)
        savePending = false
        listeners.toList().forEach { it() }
        return true
    }

    private fun updateSoon(next: ScanLogState) {
        if (next == state) return
        state = next
        scheduleSave(if (hasSaveError) RETRY_MS else 100)
    }

    private fun save() {
        hasSaveError = try {
            !persist(state.toJson())
        } catch (e: Exception) {
            true
        }
        if (hasSaveError) scheduleSave(RETRY_MS) else unsavedIds.clear()
        listeners.toList().forEach { it() }
    }

    private fun scheduleSave(delay: Long) {
        if (savePending) return
        savePending = true
        schedule(saveNow, delay)
    }

    private companion object {
        const val KEY = "scans"
        const val RETRY_MS = 5_000L
    }
}
