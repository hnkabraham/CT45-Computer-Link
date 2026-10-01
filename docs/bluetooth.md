# Bluetooth connection

Bluetooth is being prepared for version 2.1.0. The published 2.0.0 installers do not include it.

## Requirements and setup

- A Mac with Bluetooth Low Energy, running macOS 13 or later (the packaged desktop app's minimum).
- A CT45 running Android 10 or later. Bluetooth was initially exercised on a CT45P with Android 13.
- Install the matching desktop and Android builds. Wi-Fi and USB remain available on Android 8+ and Windows; Windows Bluetooth is not implemented.

1. Open the desktop app and select **Enable Bluetooth** under **Connect a scanner**. Allow its Bluetooth access if macOS asks.
2. Open CT45 Computer Link on the unlocked CT45 and scan the updated pairing QR code.
3. Tap **Change connection → Bluetooth** in the Android status card. On Android 12+, allow **Nearby devices**. Android 10–11 uses the system's location permission for Bluetooth discovery and may require Location to be on.
4. Wait for **Connected**. The Android app reports an encrypted Bluetooth connection and the desktop labels the scanner **Bluetooth**.
5. For use with the screen off or another app visible, enable **Keep running in the background** before locking the CT45. Allow notifications so connection status remains visible.

There is no need to pair the two devices in their operating-system Bluetooth settings. Ignoring an earlier operating-system pairing prompt does not prevent this connection. The apps discover a BLE channel and authenticate it using the certificate in the scanned QR code. Pairing credentials and barcode traffic use the same pinned TLS encryption as Wi-Fi and USB.

Bluetooth works without a shared network. Keep the computer awake, nearby, and the desktop app open. Distance, radio interference, a disabled adapter, or device-management policy can still interrupt it. This feature does not override enterprise restrictions. Saved scans wait and replay when the link returns, retaining the session they were captured in.

## Troubleshooting

| Symptom | Action |
|---|---|
| No Bluetooth choice on the computer | The desktop Bluetooth implementation is macOS-only. Use Wi-Fi or USB on Windows. |
| Desktop says permission is missing | Allow CT45 Computer Link in **System Settings → Privacy & Security → Bluetooth**, then enable it again in the app. |
| CT45 says Choose a connection | The QR has no Bluetooth endpoint. Tap **Use Wi-Fi / USB**, or enable Bluetooth on the Mac and rescan its updated QR. |
| CT45 cannot find the Mac | Keep the Mac awake and Bluetooth enabled on both devices. Check Nearby devices permission (Android 12+) or Location permission/settings (Android 10–11). |
| A brief outage takes time to recover | Discovery initially retries with a 7–15 second delay, then every 60 seconds after five consecutive failures. Returning to the app prompts an earlier attempt while keeping registrations at least seven seconds apart. |
| Bluetooth is blocked by device policy | Use an IT-approved Wi-Fi or USB route. Choose **Change connection → Wi-Fi / USB** on the CT45. |
| Scans stop when the screen locks | Enable background mode before locking. Hardware scan-button behavior also depends on Honeywell firmware and scanner configuration. |

## Developer tests

Build the Mac helper with `npm run build:bluetooth` in `desktop/`. `npm run dist:mac` includes this step automatically. Xcode command-line tools are required; the helper is compiled for Apple silicon and Intel, then included in each Mac app.

`npm test` exercises the opaque carrier with fragmented TLS traffic, acknowledgement/session delivery, pin rejection, malformed helper output, and process failures. Run the packaged app checks with:

```sh
CT45_BLUETOOTH_E2E=1 \
  CT45_APP='dist/mac-arm64/CT45 Computer Link.app/Contents/MacOS/CT45 Computer Link' \
  npm run e2e
```

That opt-in test enables the actual Mac helper, verifies QR updates and rapid toggles, and restarts the desktop to verify the saved setting. Ordinary `npm run e2e` does not enable Bluetooth.

The physical-device suite needs an explicitly selected, **unlocked CT45 with the app installed**:

```sh
ANDROID_SERIAL=YOUR_DEVICE_SERIAL CT45_HARDWARE_TEST=1 \
  CT45_TEST_DIR=/absolute/path/to/new-private-test-directory \
  npm run bluetooth-hardware
```

It uses synthetic Honeywell intent broadcasts through the production app. It does not operate the optical scan trigger. It preserves app data, changes the app's pairing and connection mode, temporarily disables CT45 Wi-Fi, tests CT45 Bluetooth off/on, and creates an isolated USB reverse for its own port. It never toggles the Mac adapter or clears another device's pairing. Test scans remain in Android history. Keep the test profile private: it contains a disposable TLS key and pairing link.

To reuse an existing disposable Bluetooth-only test pairing, set `CT45_EXISTING_TEST_PROFILE` to its private directory containing `identity.json` and `pairing.txt`. Use a different, fresh `CT45_TEST_DIR` for the results. The runner verifies the profile's identity and restores that pairing and the original connection mode during cleanup. Without an existing profile, the new test pairing remains installed.

The suite covers incorrect certificate pins, delivery acknowledgements, save failures, lost-ack replay, offline queues across an app restart, handheld session selection, confirmed local discard, offline connection help/retry, USB switching, and background delivery. Wi-Fi is restored immediately after proving Bluetooth-only delivery, so normal network and device-management communication can continue. It does not disable management controls or dismiss a screen lock.

`CT45_SOAK_HOURS=6` adds a six-hour scan test with periodic desktop service restarts; `CT45_SOAK_HOURS=0.25` adds a 15-minute scan test. By default, background tests leave the Home screen visible and keep the CT45 awake while charging. Some USB docks report AC power, so the stay-awake setting covers all charging sources and is restored after testing. Cleanup independently attempts to restore each setting, waits for the helper to exit, and returns to Home. A cleanup failure is recorded separately and prevents the overall report from claiming a complete pass.

Use `CT45_SCREEN_OFF_TEST=1` to explicitly test with the screen off; this may require the owner's PIN again. The test does not remove a screen lock. If Android requires a PIN at cleanup, the report records that background mode needs restoring manually. If it was originally off, the test stops its Android app to release the scanner; turn the background switch off after unlocking. The report records which checks actually passed; the existence of a test case is not evidence that it ran.

A separate connection-only soak can continue an already-established test pairing while the CT45 is locked:

```sh
CT45_HARDWARE_TEST=1 CT45_SOAK_HOURS=6 \
  CT45_EXISTING_TEST_PROFILE=/absolute/path/to/previous-test-profile \
  CT45_TEST_DIR=/absolute/path/to/new-results-directory \
  node scripts/bluetooth-connection-soak.mjs
```

It exchanges WebSocket heartbeats over real Bluetooth/TLS and restarts the Mac helper every 30 minutes. It does **not** validate barcode capture, offline scan replay, optical scanning, or background-service behavior. `report.json` includes its precise scope, timestamps, reconnection times, and failures. Keep the Mac awake for the chosen test duration and stop any earlier hardware test before launching another.
