package com.henokabraham.ct45tracker

import android.annotation.SuppressLint
import okhttp3.OkHttpClient
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

/** The QR code is the trust anchor. IP addresses may change without changing this identity. */
object PinnedTls {
    fun matches(cert: X509Certificate, pin: String): Boolean {
        if (!pin.matches(Regex("[a-f0-9]{64}"))) return false
        val expected = pin.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
        return MessageDigest.isEqual(expected, MessageDigest.getInstance("SHA-256").digest(cert.encoded))
    }

    // The user-scanned certificate digest is the trust anchor; public CAs cannot authenticate
    // a self-signed computer at a changing IP. Mismatches and expired certificates are rejected.
    @SuppressLint("CustomX509TrustManager")
    fun client(base: OkHttpClient, pin: String): OkHttpClient {
        val trust = object : X509TrustManager {
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
            override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) = throw CertificateException("Client certificates are not used")
            override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
                val cert = chain.firstOrNull() ?: throw CertificateException("Missing computer certificate")
                cert.checkValidity()
                if (!matches(cert, pin)) throw CertificateException("This is not the paired computer")
            }
        }
        val context = SSLContext.getInstance("TLS")
        context.init(null, arrayOf(trust), null)
        return base.newBuilder().sslSocketFactory(context.socketFactory, trust)
            .hostnameVerifier { _, session ->
                // Hostname-based verification cannot work for changing DHCP addresses. Check
                // the same exact QR-pinned leaf here as in the handshake, never trust all.
                try { matches(session.peerCertificates[0] as X509Certificate, pin) } catch (_: Exception) { false }
            }.build()
    }
}
