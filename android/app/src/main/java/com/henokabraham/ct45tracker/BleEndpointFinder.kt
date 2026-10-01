package com.henokabraham.ct45tracker

import android.annotation.SuppressLint
import android.bluetooth.*
import android.bluetooth.le.*
import android.content.Context
import android.os.ParcelUuid
import java.io.Closeable
import java.io.IOException
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

/** Resolves a public advertised identity to an L2CAP channel. This is discovery, never trust:
 * the caller must verify the QR-pinned TLS certificate before sending any app credentials.
 * BluetoothTunnel checks runtime permissions before entry and handles later revocation.
 */
@SuppressLint("MissingPermission")
class BleEndpointFinder(private val context: Context, private val service: UUID) : Closeable {
    data class Endpoint(val device: BluetoothDevice, val psm: Int)
    private val found = CompletableFuture<BluetoothDevice>()
    private val psm = CompletableFuture<Int>()
    private val lock = Any()
    private var closed = false
    private var scanner: BluetoothLeScanner? = null
    private var gatt: BluetoothGatt? = null
    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) { found.complete(result.device) }
        override fun onScanFailed(errorCode: Int) { found.completeExceptionally(IOException("Bluetooth discovery failed ($errorCode)")) }
    }
    private val callback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
            if (status != BluetoothGatt.GATT_SUCCESS || newState == BluetoothProfile.STATE_DISCONNECTED) {
                psm.completeExceptionally(IOException("Bluetooth connection was interrupted"))
            } else if (newState == BluetoothProfile.STATE_CONNECTED) {
                try { if (!g.discoverServices()) psm.completeExceptionally(IOException("Could not read Bluetooth services")) }
                catch (e: SecurityException) { psm.completeExceptionally(e) }
            }
        }
        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
            try {
                // Android may retain the Mac's GATT table from an earlier app profile. A
                // cached channel characteristic is only another endpoint candidate: the
                // scanned identity's TLS pin still decides whether it can be trusted.
                val characteristic = g.getService(service)?.getCharacteristic(CHANNEL_CHARACTERISTIC)
                    ?: g.services.firstNotNullOfOrNull { it.getCharacteristic(CHANNEL_CHARACTERISTIC) }
                if (status != BluetoothGatt.GATT_SUCCESS || characteristic == null || !g.readCharacteristic(characteristic)) {
                    psm.completeExceptionally(IOException("Computer Bluetooth service is unavailable"))
                }
            } catch (e: SecurityException) { psm.completeExceptionally(e) }
        }
        override fun onServiceChanged(g: BluetoothGatt) {
            try { g.discoverServices() } catch (e: SecurityException) { psm.completeExceptionally(e) }
        }
        @Suppress("DEPRECATION")
        override fun onCharacteristicRead(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
            readChannel(characteristic.value, status)
        }
        override fun onCharacteristicRead(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray, status: Int) {
            readChannel(value, status)
        }
    }
    private fun readChannel(value: ByteArray?, status: Int) {
        if (status != BluetoothGatt.GATT_SUCCESS || value?.size != 2) {
            psm.completeExceptionally(IOException("Invalid Bluetooth channel")); return
        }
        val channel = (value[0].toInt() and 255) or ((value[1].toInt() and 255) shl 8)
        if (channel !in 1..255) psm.completeExceptionally(IOException("Invalid Bluetooth channel")) else psm.complete(channel)
    }

    fun find(adapter: BluetoothAdapter): Endpoint {
        val le = adapter.bluetoothLeScanner ?: throw IOException("Turn on Bluetooth on the CT45")
        synchronized(lock) {
            if (closed) throw IOException("Bluetooth connection cancelled")
            scanner = le
            le.startScan(listOf(ScanFilter.Builder().setServiceUuid(ParcelUuid(service)).build()),
                ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(), scanCallback)
        }
        val device = try { found.get(12, TimeUnit.SECONDS) }
        finally { le.stopScan(scanCallback) }
        synchronized(lock) {
            if (closed) throw IOException("Bluetooth connection cancelled")
            gatt = device.connectGatt(context, false, callback, BluetoothDevice.TRANSPORT_LE)
        }
        return Endpoint(device, psm.get(12, TimeUnit.SECONDS))
    }

    override fun close() {
        synchronized(lock) {
            if (closed) return
            closed = true
            found.cancel(true); psm.cancel(true)
            try { scanner?.stopScan(scanCallback) } catch (_: RuntimeException) {}
            try { gatt?.close() } catch (_: RuntimeException) {}
            scanner = null; gatt = null
        }
    }
    companion object {
        val CHANNEL_CHARACTERISTIC: UUID = UUID.fromString("e89c1e7a-0450-4d82-9b4c-b5c3f155cf45")
    }
}
