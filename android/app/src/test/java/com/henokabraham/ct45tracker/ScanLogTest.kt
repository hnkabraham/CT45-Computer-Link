package com.henokabraham.ct45tracker

import org.junit.Assert.*
import org.junit.Test

class ScanLogTest {
    private class Storage(initial: String? = null) {
        var disk = initial
        var writable = true
        var throwOnWrite = false
        var attempts = 0
        val scheduled = linkedMapOf<Runnable, Long>()
        val log = ScanLog(
            initial,
            { text ->
                attempts++
                if (throwOnWrite) throw java.io.IOException("disk unavailable")
                if (writable) disk = text
                writable
            },
            { task, delay -> scheduled[task] = delay },
            { task -> scheduled.remove(task); Unit },
        )

        fun runNext() {
            val task = scheduled.keys.first()
            scheduled.remove(task)
            task.run()
        }
    }

    private fun scan(id: String) = Protocol.Scan(id, "Barcode $id", 1L)

    @Test
    fun `failed writes stay visibly unsaved and are withheld until a retry succeeds`() {
        val storage = Storage()
        val log = storage.log
        var updates = 0
        log.addListener { updates++ }
        storage.writable = false
        log.add(scan("one"))
        assertTrue(log.hasSaveError)
        assertFalse(log.isSaved("one"))
        assertEquals(listOf("one"), log.state.unsent.map { it.id })
        assertTrue(log.outbox.isEmpty())
        assertNull(storage.disk)
        assertEquals(1, updates)
        assertEquals(listOf(5_000L), storage.scheduled.values.toList())

        storage.runNext() // Still full: keep exactly one retry and retain the scan.
        assertTrue(log.hasSaveError)
        assertEquals(1, storage.scheduled.size)
        storage.writable = true
        storage.runNext()
        assertFalse(log.hasSaveError)
        assertTrue(log.isSaved("one"))
        assertEquals(listOf(scan("one")), log.outbox)
        assertEquals(log.state, ScanLogState.fromJson(storage.disk))
        assertTrue(storage.scheduled.isEmpty())
        assertEquals(3, updates)
    }

    @Test
    fun `a later successful save includes every scan that previously failed`() {
        val storage = Storage()
        storage.writable = false
        storage.log.add(scan("one"))
        storage.log.add(scan("two"))
        storage.writable = true
        storage.log.add(scan("three"))
        assertFalse(storage.log.hasSaveError)
        assertEquals(listOf("one", "two", "three"), storage.log.outbox.map { it.id })
        assertEquals(storage.log.state, ScanLogState.fromJson(storage.disk))
        assertTrue(storage.scheduled.isEmpty())
    }

    @Test
    fun `storage exceptions are retried without losing a scan`() {
        val storage = Storage()
        storage.throwOnWrite = true
        storage.log.add(scan("one"))
        assertTrue(storage.log.hasSaveError)
        storage.throwOnWrite = false
        storage.runNext()
        assertFalse(storage.log.hasSaveError)
        assertEquals(listOf(scan("one")), ScanLogState.fromJson(storage.disk).unsent)
    }

    @Test
    fun `failed acknowledgment saves preserve durable scans and batch retry updates`() {
        val storage = Storage()
        storage.log.add(scan("one"))
        storage.log.add(scan("two"))
        storage.writable = false
        storage.log.markSent("one")
        assertEquals(listOf(100L), storage.scheduled.values.toList())
        storage.runNext()
        assertTrue(storage.log.hasSaveError)
        assertTrue(storage.log.isSaved("two"))
        assertEquals(listOf(scan("two")), storage.log.outbox)
        assertEquals(2, ScanLogState.fromJson(storage.disk).unsent.size)
        storage.log.markSent("two")
        assertEquals(listOf(5_000L), storage.scheduled.values.toList())
        storage.writable = true
        storage.runNext()
        assertFalse(storage.log.hasSaveError)
        assertTrue(ScanLogState.fromJson(storage.disk).unsent.isEmpty())
    }

    @Test
    fun `draining a backlog trims completed history without dropping unsent scans`() {
        var state = ScanLogState()
        repeat(250) { state = state.add(scan("$it")) }
        repeat(200) { state = state.markSent("$it") }
        assertEquals(50, state.unsent.size)
        assertEquals(100, state.scans.count { it.done })
        (200 until 250).forEach { state = state.markRejected("$it") }
        assertEquals(100, state.scans.size)
        assertTrue(state.unsent.isEmpty())
    }

    @Test
    fun `discard is durable retains its audit record and tolerates a late acknowledgement`() {
        val storage = Storage()
        storage.log.add(scan("one"))
        storage.log.add(scan("two"))
        assertTrue(storage.log.discard("one"))
        val rebooted = Storage(storage.disk)
        assertEquals(listOf("two"), rebooted.log.outbox.map { it.id })
        assertTrue(rebooted.log.state.scans.first { it.scan.id == "one" }.discarded)
        rebooted.log.markSent("one") // Already delivered, but its ack arrived after discard.
        rebooted.runNext()
        val record = ScanLogState.fromJson(rebooted.disk).scans.first { it.scan.id == "one" }
        assertTrue(record.sent)
        assertTrue(record.discarded)
        var state = rebooted.log.state
        repeat(150) { state = state.add(scan("new-$it")).markSent("new-$it") }
        assertTrue(state.scans.any { it.scan.id == "one" && it.discarded })
    }

    @Test
    fun `failed or ineligible discards leave saved scans in their original state`() {
        val storage = Storage()
        storage.log.add(scan("one"))
        storage.writable = false
        assertFalse(storage.log.discard("one"))
        assertEquals(listOf("one"), storage.log.outbox.map { it.id })
        assertFalse(ScanLogState.fromJson(storage.disk).scans.single().discarded)
        storage.log.add(scan("unsaved"))
        assertFalse(storage.log.discard("unsaved"))
        storage.writable = true
        storage.runNext()
        storage.log.markSent("one")
        assertFalse(storage.log.discard("one"))
        assertFalse(storage.log.discard("unknown"))
    }
}
