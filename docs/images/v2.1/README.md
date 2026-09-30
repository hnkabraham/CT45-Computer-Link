# v2.1 UI screenshots

Captured September 30, 2026 from the 2.1.0 development builds. These screens show the upcoming interface; the published stable download remains v2.0.0. See [Bluetooth setup and validation](../../bluetooth.md) for current hardware test results.

All barcodes and scanner names shown here are synthetic examples. The desktop screenshots use a disposable test profile; the pictured pairing code no longer works.

## Desktop

Captured from the packaged Apple silicon macOS app. The scan list uses a simulated scanner. The pairing screen shows Bluetooth ready on the Mac; it does not show a connected Bluetooth scanner.

### Pairing and Bluetooth setup

![Desktop waiting for a scanner, with QR pairing and Bluetooth setup instructions](ct45-desktop-empty.png)

### Named scanning session and export controls

![Warehouse count session with sample barcodes and Excel export controls](ct45-desktop-sessions.png)

### Light and dark appearance

| Light | Dark |
|---|---|
| ![Desktop scan list in light appearance](ct45-desktop-light.png) | ![Desktop scan list in dark appearance](ct45-desktop-dark.png) |

### Narrow window

<img src="ct45-desktop-narrow.png" alt="Desktop interface in a narrow window, with stacked controls and a scrollable scan list" width="420">

## Android

Captured from the signed 2.1.0 APK on an Android 13 emulator, not the physical CT45. The emulator has no Honeywell scanner, so its scanner warning is visible. The connected views use a real pinned TLS connection to a temporary local server; barcode input is simulated. The connection menu illustrates the Bluetooth option, not a Bluetooth connection from the emulator.

| Connected, light appearance | Connected, dark appearance |
|---|---|
| <img src="ct45-android-connected.png" alt="Android emulator connected to Demo Computer, showing the Warehouse count session and sent barcodes" width="300"> | <img src="ct45-android-dark.png" alt="Android emulator showing the same connected session in dark appearance" width="300"> |

| Connection choices | Saved scan waiting to send |
|---|---|
| <img src="ct45-android-connection-options.png" alt="Android connection method dialog offering Wi-Fi or USB and Bluetooth" width="300"> | <img src="ct45-android-waiting.png" alt="Android emulator with one saved scan waiting after the demo computer disconnects" width="300"> |

The original PNG files in this folder are available at full resolution. These screenshots document the interface; they do not verify optical scanning or screen-off scanning on Honeywell hardware.
