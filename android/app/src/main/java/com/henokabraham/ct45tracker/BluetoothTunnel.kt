package com.henokabraham.ct45tracker

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import java.io.Closeable
import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.UUID
import kotlin.concurrent.thread

/** A one-connection loopback bridge so OkHttp keeps its TLS pinning and WebSocket behavior.
 * Bluetooth LE carries an opaque TLS stream. TLS authenticates the computer
 * from the scanned QR before the app sends its pairing token or any barcode data.
 */
class BluetoothTunnel(private val context: Context) : Closeable {
    private val lock = Any()
    private var closed = false
    private var bluetooth: BluetoothSocket? = null
    private var listener: ServerSocket? = null
    private var local: Socket? = null
    private var finder: BleEndpointFinder? = null
    private var powerReceiver: BroadcastReceiver? = null

    fun start(serviceId: String, ready: (Int) -> Unit, failed: (String) -> Unit) {
        thread(name = "ct45-bluetooth-connect", isDaemon = true) {
            try {
                if (Build.VERSION.SDK_INT < 29) throw IOException("Bluetooth requires Android 10 or newer. Use Wi-Fi or USB on this device")
                if (Build.VERSION.SDK_INT >= 31 && context.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) throw IOException("Allow Nearby devices to use Bluetooth")
                if (!permitted(context)) throw IOException("Allow Bluetooth discovery in app permissions")
                val adapter = context.getSystemService(BluetoothManager::class.java)?.adapter
                    ?: throw IOException("This device has no Bluetooth adapter")
                val receiver = object : BroadcastReceiver() {
                    override fun onReceive(context: Context, intent: Intent) {
                        // Some CT45 firmware keeps existing LE channels alive in BLE_ON even
                        // after the user turns Bluetooth off. Honor the public adapter switch.
                        if (intent.action != BluetoothAdapter.ACTION_STATE_CHANGED) return
                        val enabled = try { adapter.isEnabled } catch (_: SecurityException) { false }
                        if (!enabled) {
                            val active = synchronized(lock) { !closed }
                            close()
                            if (active) failed("Turn on Bluetooth on the CT45")
                        }
                    }
                }
                synchronized(lock) {
                    if (closed) return@thread
                    // Bluetooth broadcasts originate from a privileged app UID. This action
                    // is system-protected; also check the real adapter state, not intent extras.
                    ContextCompat.registerReceiver(context, receiver,
                        IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED), ContextCompat.RECEIVER_EXPORTED)
                    powerReceiver = receiver
                }
                // Register before checking to cover an off transition during connection setup.
                if (!adapter.isEnabled) throw IOException("Turn on Bluetooth on the CT45")
                val discovery = BleEndpointFinder(context, UUID.fromString(serviceId))
                synchronized(lock) {
                    if (closed) return@thread
                    finder = discovery
                }
                val endpoint = discovery.find(adapter)
                // The discovery channel is unauthenticated. Pinned TLS must succeed before
                // hello, tokens or barcodes can cross it, exactly as on an untrusted Wi-Fi LAN.
                val socket = endpoint.device.createInsecureL2capChannel(endpoint.psm)
                synchronized(lock) {
                    if (closed) { socket.close(); return@thread }
                    bluetooth = socket
                }
                socket.connect()
                val server = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
                server.soTimeout = 10000
                synchronized(lock) {
                    if (closed) { server.close(); return@thread }
                    listener = server
                }
                ready(server.localPort)
                val tcp = server.accept()
                synchronized(lock) {
                    if (closed) { tcp.close(); return@thread }
                    local = tcp
                }
                server.close() // Exactly one local client is allowed per connection attempt.
                tcp.tcpNoDelay = true
                thread(name = "ct45-bluetooth-send", isDaemon = true) {
                    try { tcp.getInputStream().copyTo(socket.outputStream, 8192) }
                    catch (_: IOException) {} finally { close() }
                }
                socket.inputStream.copyTo(tcp.getOutputStream(), 8192)
            } catch (e: Exception) {
                val wasClosed = synchronized(lock) { closed }
                if (!wasClosed) failed(when (e) {
                    is SecurityException -> "Allow Nearby devices to use Bluetooth"
                    is java.util.concurrent.TimeoutException -> "Could not find the computer over Bluetooth"
                    else -> e.cause?.message ?: e.message ?: "Bluetooth connection failed"
                })
            } finally { close() }
        }
    }

    override fun close() {
        val (resources, receiver) = synchronized(lock) {
            if (closed) return
            closed = true
            val receiver = powerReceiver
            powerReceiver = null
            listOfNotNull(local, listener, bluetooth, finder) to receiver
        }
        if (receiver != null) try { context.unregisterReceiver(receiver) } catch (_: IllegalArgumentException) {}
        for (resource in resources) try { resource.close() } catch (_: IOException) {}
    }

    companion object {
        fun permissions(): Array<String> = if (Build.VERSION.SDK_INT >= 31)
            arrayOf(Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_SCAN)
            else arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
        fun permitted(context: Context): Boolean = permissions().all { context.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }
    }
}
