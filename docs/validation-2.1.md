# Version 2.1 validation

Status on September 30, 2026: **development candidate; full physical-device acceptance remains incomplete**. The stable public download is still version 2.0.0.

## September 30 product and design improvements

The current development build adds local queue actions, guided connection recovery, handheld session selection, exact repeated-barcode markers, visible Copy buttons, and clearer connection labels. It rejects oversized input without truncation and recovers invalid entries saved by older versions. Android status and history scroll together on short screens while manual barcode entry stays accessible. The pairing panel puts Copy pairing link before the Bluetooth controls and keeps token revocation secondary.

| Check | Result |
|---|---|
| Desktop unit/integration tests | 43 passed, including authenticated session control, all-scanner broadcasts, session save failures, and exact repeat counts |
| Android unit tests | 23 passed, including protocol compatibility, input limits, durable discard, failed discard writes, late acknowledgements, and discard retention |
| Android workflow tests | All 14 checks passed on a disposable Android 13 emulator, including exact Copy/paste text, 48dp input/Send controls at 720×1280, and scrolling to queue actions |
| Android debug/release builds and lint | Built successfully; no lint errors, seven existing warnings |
| Packaged Apple silicon Mac app | All 46 end-to-end checks passed, including real helper startup, QR changes, toggling/persistence, repeat markers, Copy buttons, local labels, and handheld session selection |
| Local build artifacts | Both Mac DMGs and the Windows x64 installer built; Android release APK signed with the existing key lineage and signature/alignment verification passed |
| Visual checks | Light/dark Android and desktop screens, session/queue dialogs, guided recovery, a 420px desktop window, and a 720×1280 Android layout inspected |
| Pending-text contrast | Light amber changed from `#B26A00` (4.24:1 on white) to `#8A5300` (6.33:1 on white, 5.85:1 on the page background); dark amber is 9.07:1 on its surface. Ratios calculated from sRGB relative luminance. |

The current Android workflows were exercised on a disposable Android 13 emulator against the production desktop TLS server. A saved 70,000-character entry was rejected locally and the following valid scan delivered. New 8,193-character input was rejected without disconnecting. A 101-character device name connected with a bounded hello name. Session selection changed the desktop session; waiting scans retained their original session. Confirmed local discard survived restart and prevented retry of that record. A pairing without Bluetooth offered a working network switch, and reselecting the active transport preserved the connection.

The emulator's barcode input is synthetic. The current APK has **not** been installed or tested on the physical CT45, and the current Intel package has not been rerun under Rosetta. The historical radio evidence below applies to the earlier Bluetooth build. The overnight automation remains paused. Screenshots and reproducible test commands are in the [gallery](images/v2.1/README.md) and [README](../README.md).

## Earlier Bluetooth build and hardware tests

These results precede the product/design changes above and are retained as historical evidence, not as acceptance of the current APK.

| Check | Result |
|---|---|
| Desktop unit/integration tests | 39 passed, including fragmented TLS-over-carrier traffic, certificate rejection, acknowledgements and sessions |
| Android unit tests | 19 passed |
| Android debug/release builds and lint | Built successfully; no lint errors, seven warnings (six existing and an API-level warning for Bluetooth's `neverForLocation` attribute) |
| Packaged Apple silicon Mac app | All 41 end-to-end checks passed, including the real Bluetooth helper, QR updates, rapid toggling and restart persistence |
| Packaged Intel Mac app under Rosetta | All 41 end-to-end checks passed; this is not Intel hardware radio testing |
| Release artifacts | Both Mac DMGs and Windows x64 installer built; Android release APK signed with the existing release-key lineage and signatures/alignment verified |
| Physical CT45P, Android 13: initial Bluetooth smoke | Encrypted radio connection, named-session scan delivery and delivery acknowledgement passed with synthetic Honeywell scan broadcasts and an unreachable network address |
| Physical CT45P: reconnect fix | Two reconnections passed after restarting the Mac helper, using the already-paired test identity while the CT45 was locked |
| Signed 2.1.0 APK on CT45P | Installed without uninstalling; existing test pairing retained and encrypted Bluetooth reconnected, including a further helper restart |
| Expanded physical CT45P scan/recovery suite | All 16 checks passed on the signed 2.1.0 APK: Wi-Fi-off delivery, exact text, wrong-pin rejection, lost-ack deduplication, save retry, 25 offline scans surviving process restart in order, session attribution, adapter off/on, USB switching, and background delivery/reconnection |
| Connection-only soak | Deliberately stopped after seven healthy minutes and two connections, with no unexpected disconnects, to run the expanded suite |
| Six-hour background scan soak | Incomplete: ADB lost the CT45 at 4:08 AM Pacific after about 5 hours 29 minutes. All 163 injected soak scans were stored, including ten planned Mac helper restart cycles. The six-hour target was not met. |

The hardware recovery test exposed Android retaining an older Mac GATT service table after a test profile changed. The scanner now accepts the known channel characteristic as a candidate endpoint and still requires the exact QR-pinned TLS certificate. Retry spacing was increased to avoid Android's BLE scan-registration limit. Reconnection then passed on the same device without deleting its operating-system pairing.

After the user unlocked the CT45, **Stay awake while charging** was enabled at their request and verified active. The USB connection reports AC charging, so the setting covers all charging sources. PIN protection remains enabled. The expanded physical scan suite then passed all 16 checks, including a deliberately lost acknowledgement that was retransmitted and stored only once. Background tests leave the Home screen visible so they do not relock the device.

The soak sent a synthetic barcode every two minutes through the production app and real Bluetooth radio. Every 15 cycles it restarted the Mac helper and queued a scan while disconnected. The last successful delivery was at 4:06 AM Pacific. At 4:08 AM, the ADB command for cycle 164 failed because the device was no longer available, before that scan could be injected. No Bluetooth delivery timeout was recorded before this test-control failure; the cause of the device disappearing is not established.

Independent inspection of the persisted desktop log found 201 records with 201 unique IDs: 38 functional-test scans and all 163 soak scans in an uninterrupted sequence. The single repeated delivery was the deliberately lost acknowledgement in the functional suite, correctly deduplicated in storage. The runner and its Mac sleep-prevention process exited. Cleanup could not restore the temporary CT45 Wi-Fi/background settings because ADB remained unavailable; reconnecting the device is required to finish cleanup. The requested stay-awake-while-charging preference must remain enabled. Test reports and persisted records remain in a private local directory.

Still required before calling the Bluetooth release fully validated:

- Restore temporary device test settings when ADB returns and complete an uninterrupted soak before claiming the six-hour check passed.
- Manually scan an optical barcode using the Honeywell hardware trigger; synthetic broadcasts do not test the camera/laser or firmware trigger behavior.
- Verify screen-off scanning when the owner can unlock the device again; Home-screen background checks do not establish screen-off behavior.
- Verify the updated queue/session controls and keyboard behavior on the physical CT45, including returning to the app without the soft keyboard covering the scan history.

Windows runtime, Windows Bluetooth, Android 10–12 Bluetooth, real Intel radio hardware, enterprise device policies, and radio range/interference have not been validated. Windows Bluetooth is not implemented. See [Bluetooth setup and testing](bluetooth.md) for reproducible commands and the distinction between the scan suite and connection-only soak.

Private test profiles and raw device logs stay outside the repository. Release assets must contain only the intended installers, signed release APK, and checksums.
