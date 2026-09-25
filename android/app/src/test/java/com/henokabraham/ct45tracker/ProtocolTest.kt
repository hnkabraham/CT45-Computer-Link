package com.henokabraham.ct45tracker

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ProtocolTest {
    @Test
    fun `reads a pairing code made by the desktop app`() {
        // Output of desktop/src/protocol.js pairingUrl() for these values.
        val url = "ct45tracker://pair?h=192.168.1.5%2C10.0.0.2&p=8765&t=abc_-123&n=Henok%27s+Mac+%2B+PC"
        assertEquals(
            Protocol.Pairing(listOf("192.168.1.5", "10.0.0.2"), 8765, "abc_-123", "Henok's Mac + PC"),
            Protocol.parsePairing(url),
        )
    }

    @Test
    fun `ordinary barcodes are not pairing codes`() {
        assertNull(Protocol.parsePairing("0123456789012"))
        assertNull(Protocol.parsePairing("https://example.com/?h=1&p=2&t=3"))
        assertNull(Protocol.parsePairing("ct45tracker://pair?h=1.2.3.4&p=70000&t=x"))
        assertNull(Protocol.parsePairing("ct45tracker://pair?h=1.2.3.4&p=8765"))
        assertNull(Protocol.parsePairing("ct45tracker://pair?h=&p=8765&t=x"))
        assertNull(Protocol.parsePairing("ct45tracker://pair?h=1.2.3.4&p=8765&t=%zz"))
    }

    @Test
    fun `a missing name is allowed`() {
        assertEquals("", Protocol.parsePairing("ct45tracker://pair?h=10.0.2.2&p=8765&t=tok")?.name)
    }

    @Test
    fun `invalid hosts and oversized tokens cannot become saved pairings`() {
        val hosts = listOf("bad host", "host/path", "host?query", "user@host", "host#fragment", "host\\path", "[broken", "http://host")
        for (host in hosts) {
            val encoded = java.net.URLEncoder.encode(host, "UTF-8")
            assertNull(host, Protocol.parsePairing("ct45tracker://pair?h=$encoded&p=8765&t=tok"))
            assertNull(host, Protocol.validatedPairing(Protocol.Pairing(listOf(host), 8765, "tok", "Mac")))
        }
        assertNull(Protocol.parsePairing("ct45tracker://pair?h=127.0.0.1&p=8765&t=${"x".repeat(129)}"))
        assertNull(Protocol.validatedPairing(Protocol.Pairing(emptyList(), 8765, "tok", "")))
        assertNull(Protocol.validatedPairing(Protocol.Pairing(listOf("localhost"), 0, "tok", "")))
    }

    @Test
    fun `valid IPv4 IPv6 and hostname pairings build usable connection URLs`() {
        val pairing = Protocol.parsePairing("ct45tracker://pair?h=192.168.1.5,127.0.0.1,::1,[::1],Scanner.local&p=8765&t=tok")!!
        assertEquals(listOf("192.168.1.5", "127.0.0.1", "::1", "scanner.local"), pairing.hosts)
        assertEquals("http://[::1]:8765/", Protocol.serverUrl(pairing.hosts[2], pairing.port).toString())
        pairing.hosts.forEach { host -> assertEquals(8765, Protocol.serverUrl(host, pairing.port).port) }
    }

    @Test
    fun `builds hello and scan messages`() {
        val hello = JSONObject(Protocol.hello("tok", "CT45 1A2B", "1.0"))
        assertEquals("hello", hello.getString("type"))
        assertEquals("tok", hello.getString("token"))
        assertEquals("CT45 1A2B", hello.getString("device"))

        val scan = JSONObject(Protocol.scan(Protocol.Scan("id-1", "\u001d01\"x", 1234L, "]C1", "I"), 5678L))
        assertEquals("scan", scan.getString("type"))
        assertEquals("id-1", scan.getString("id"))
        assertEquals("\u001d01\"x", scan.getString("data"))
        assertEquals(1234L, scan.getLong("scannedAt"))
        assertEquals(5678L, scan.getLong("sentAt"))
        assertEquals("]C1", scan.getString("aimId"))
        assertEquals("I", scan.getString("codeId"))
    }

    @Test
    fun `reads server messages`() {
        assertEquals(Protocol.ServerMessage.Welcome("Mac"), Protocol.parseServer("""{"type":"welcome","name":"Mac","version":1}"""))
        assertEquals(Protocol.ServerMessage.Ack("a"), Protocol.parseServer("""{"type":"ack","id":"a"}"""))
        assertEquals(
            Protocol.ServerMessage.Error("save-failed", "disk full", "z"),
            Protocol.parseServer("""{"type":"error","code":"save-failed","message":"disk full","id":"z"}"""),
        )
        assertEquals(Protocol.ServerMessage.Error("bad-token", "old", null), Protocol.parseServer("""{"type":"error","code":"bad-token","message":"old"}"""))
        assertEquals(Protocol.ServerMessage.Unknown, Protocol.parseServer("not json"))
        assertEquals(Protocol.ServerMessage.Unknown, Protocol.parseServer("""{"type":"future-thing"}"""))
    }

    @Test
    fun `unsent scans go out oldest first and leave once acknowledged`() {
        val a = Protocol.Scan("a", "A", 1)
        val b = Protocol.Scan("b", "B", 2)
        var log = ScanLogState().add(a).add(b)
        assertEquals(listOf("b", "a"), log.scans.map { it.scan.id })
        assertEquals(listOf("a", "b"), log.unsent.map { it.id })
        log = log.markSent("a")
        assertEquals(listOf("b"), log.unsent.map { it.id })
        assertTrue(log.scans.last().sent)
        assertFalse(log.scans.first().sent)
        assertEquals(log, log.markSent("unknown"))
    }

    @Test
    fun `a rejected scan leaves the outbox but a sent one can't become rejected`() {
        var log = ScanLogState().add(Protocol.Scan("a", "A", 1)).add(Protocol.Scan("b", "B", 2))
        log = log.markRejected("a")
        assertEquals(listOf("b"), log.unsent.map { it.id })
        assertTrue(log.scans.last().rejected)
        log = log.markSent("b").markRejected("b")
        assertTrue(log.scans.first().sent)
        assertFalse(log.scans.first().rejected)
    }

    @Test
    fun `history is trimmed but unsent scans are never dropped`() {
        var log = ScanLogState()
        repeat(150) { i -> log = log.add(Protocol.Scan("s$i", "S$i", i.toLong())).markSent("s$i") }
        repeat(150) { i -> log = log.add(Protocol.Scan("u$i", "U$i", 1000L + i)) }
        log = log.add(Protocol.Scan("last", "L", 5000))
        assertEquals(151, log.unsent.size)
        assertEquals(ScanLogState.KEEP_SENT, log.scans.count { it.sent })
        assertEquals("s149", log.scans.first { it.sent }.scan.id)
    }

    @Test
    fun `log survives a round trip through JSON, and bad JSON starts empty`() {
        val log = ScanLogState()
            .add(Protocol.Scan("a", "\u001dA,\"b\"", 1, "]C1", "I"))
            .add(Protocol.Scan("b", "B", 2))
            .add(Protocol.Scan("c", "C", 3))
            .markSent("a")
            .markRejected("c")
        assertEquals(log, ScanLogState.fromJson(log.toJson()))
        assertEquals(ScanLogState(), ScanLogState.fromJson("{oops"))
        assertEquals(ScanLogState(), ScanLogState.fromJson(null))
    }
}
