package com.henokabraham.ct45tracker

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Handler
import android.os.Looper

/** mDNS finds possible addresses, never credentials. DesktopLink still authenticates TLS. */
@Suppress("DEPRECATION") // Legacy resolve API also supports the CT45's Android 8–13 versions.
class ComputerDiscovery(context: Context, private val found: (Endpoint) -> Unit) {
    data class Endpoint(val host: String, val port: Int)
    private val manager = context.getSystemService(NsdManager::class.java)
    private val main = Handler(Looper.getMainLooper())
    private var listener: NsdManager.DiscoveryListener? = null
    private var target: String? = null
    private var generation = 0
    private var resolving = false
    private val queue = ArrayDeque<NsdServiceInfo>()
    private val retry = Runnable { val id = target; stop(); if (id != null) start(id) }

    fun start(id: String) {
        if (target == id) return
        stop()
        target = id
        val gen = generation
        val l = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(type: String) {}
            override fun onDiscoveryStopped(type: String) {}
            override fun onStopDiscoveryFailed(type: String, code: Int) {}
            override fun onStartDiscoveryFailed(type: String, code: Int) = onMain(gen) {
                main.postDelayed(retry, 15_000)
            }
            override fun onServiceLost(info: NsdServiceInfo) {}
            override fun onServiceFound(info: NsdServiceInfo) = onMain(gen) {
                if (info.serviceName == "ct45-$id" && queue.size < 8) {
                    queue.addLast(info)
                    resolveNext(gen, id)
                }
            }
        }
        main.postDelayed(retry, 30_000)
        listener = l
        try { manager.discoverServices("_ct45link._tcp.", NsdManager.PROTOCOL_DNS_SD, l) }
        catch (_: RuntimeException) { main.postDelayed(retry, 15_000) }
    }

    private fun resolveNext(gen: Int, id: String) {
        if (resolving || queue.isEmpty()) return
        resolving = true
        val info = queue.removeFirst()
        try {
            manager.resolveService(info, object : NsdManager.ResolveListener {
                override fun onResolveFailed(service: NsdServiceInfo, code: Int) = onMain(gen) {
                    resolving = false
                    resolveNext(gen, id)
                }
                override fun onServiceResolved(service: NsdServiceInfo) = onMain(gen) {
                    resolving = false
                    val advertisedId = service.attributes["id"]?.toString(Charsets.UTF_8)
                    val host = service.host?.hostAddress
                    if (advertisedId == id && host != null && service.port in 1..65535) found(Endpoint(host, service.port))
                    resolveNext(gen, id)
                }
            })
        } catch (_: RuntimeException) { resolving = false }
    }

    fun stop() {
        generation++
        main.removeCallbacks(retry)
        listener?.let { try { manager.stopServiceDiscovery(it) } catch (_: RuntimeException) {} }
        listener = null
        target = null
        resolving = false
        queue.clear()
    }
    private fun onMain(gen: Int, block: () -> Unit) { main.post { if (generation == gen) block() } }
}
