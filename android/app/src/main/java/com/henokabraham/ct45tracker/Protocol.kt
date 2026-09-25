package com.henokabraham.ct45tracker

import org.json.JSONObject
import okhttp3.HttpUrl
import java.net.URLDecoder

/**
 * Messages between this app and CT45 Computer Link on the computer. docs/protocol.md has the full
 * description; desktop/src/protocol.js is the other half and must stay in step with this file.
 */
object Protocol {
    const val PAIR_PREFIX = "ct45tracker://pair"

    // Close codes from the computer that mean retrying is pointless until the user re-pairs.
    const val CLOSE_BAD_TOKEN = 4001
    const val CLOSE_REPAIRED = 4003

    data class Pairing(val hosts: List<String>, val port: Int, val token: String, val name: String, val computerId: String = "", val fingerprint: String = "")

    data class Session(val id: String = "default", val name: String = "General")

    data class Scan(
        val id: String,
        val data: String,
        val scannedAt: Long,
        val aimId: String = "",
        val codeId: String = "",
        val sessionId: String = "default",
        val sessionName: String = "General",
    )

    sealed class ServerMessage {
        data class Welcome(val name: String, val session: Session) : ServerMessage()
        data class SessionChanged(val session: Session) : ServerMessage()
        data class Ack(val id: String) : ServerMessage()
        data class Error(val code: String, val message: String, val id: String?) : ServerMessage()
        data object Unknown : ServerMessage()
    }

    /** The QR code shown by the desktop app, or null for any ordinary barcode. */
    fun parsePairing(text: String): Pairing? = try {
        parsePairingOrThrow(text)
    } catch (e: IllegalArgumentException) {
        null // a malformed %-escape
    }

    private fun parsePairingOrThrow(text: String): Pairing? {
        if (!text.startsWith("$PAIR_PREFIX?")) return null
        val params = text.substring(PAIR_PREFIX.length + 1).split('&').mapNotNull { part ->
            val eq = part.indexOf('=')
            if (eq <= 0) return@mapNotNull null
            decode(part.substring(0, eq)) to decode(part.substring(eq + 1))
        }.toMap()
        val hosts = params["h"].orEmpty().split(',').map { it.trim() }.filter { it.isNotEmpty() }
        val port = params["p"]?.toIntOrNull() ?: return null
        val token = params["t"].orEmpty()
        if (params["v"] != "2") return null
        return validatedPairing(Pairing(hosts, port, token, params["n"].orEmpty(), params["id"].orEmpty(), params["fp"].orEmpty()))
    }

    /** Use the same URL builder for validation and connection, with no DNS lookup. */
    fun serverUrl(host: String, port: Int): HttpUrl = HttpUrl.Builder()
        .scheme("https").host(host).port(port).build()

    fun validatedPairing(p: Pairing): Pairing? {
        if (p.hosts.isEmpty() || p.port !in 1..65535 || p.token.isEmpty() || p.token.length > 128) return null
        if (!p.computerId.matches(Regex("[a-zA-Z0-9-]{1,64}")) || !p.fingerprint.matches(Regex("[a-f0-9]{64}"))) return null
        return try {
            p.copy(hosts = p.hosts.map { serverUrl(it, p.port).host }.distinct())
        } catch (e: IllegalArgumentException) {
            null
        }
    }

    private fun decode(s: String) = URLDecoder.decode(s, "UTF-8")

    fun hello(token: String, device: String, appVersion: String): String =
        JSONObject()
            .put("type", "hello")
            .put("token", token)
            .put("device", device)
            .put("app", appVersion)
            .toString()

    /** [sentAt] lets the computer tell a live scan from one that waited in the outbox. */
    fun scan(scan: Scan, sentAt: Long): String =
        JSONObject()
            .put("type", "scan")
            .put("id", scan.id)
            .put("data", scan.data)
            .put("scannedAt", scan.scannedAt)
            .put("sentAt", sentAt)
            .put("aimId", scan.aimId)
            .put("codeId", scan.codeId)
            .put("sessionId", scan.sessionId)
            .put("sessionName", scan.sessionName)
            .toString()

    private fun session(o: JSONObject): Session {
        val s = o.optJSONObject("session") ?: return Session()
        val id = s.optString("id")
        val name = s.optString("name")
        return if (id.length in 1..64 && name.length in 1..80) Session(id, name) else Session()
    }

    fun parseServer(text: String): ServerMessage {
        val o = try {
            JSONObject(text)
        } catch (e: Exception) {
            return ServerMessage.Unknown
        }
        return when (o.optString("type")) {
            "welcome" -> if (o.optInt("version") == 2) ServerMessage.Welcome(o.optString("name"), session(o)) else ServerMessage.Unknown
            "session" -> ServerMessage.SessionChanged(session(o))
            "ack" -> ServerMessage.Ack(o.optString("id"))
            "error" -> ServerMessage.Error(
                o.optString("code"),
                o.optString("message"),
                if (o.has("id")) o.optString("id") else null,
            )
            else -> ServerMessage.Unknown
        }
    }
}
