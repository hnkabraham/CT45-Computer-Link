# Version 2.1 Bluetooth validation

Status on September 30, 2026: **development candidate; full physical-device acceptance remains incomplete**. The stable public download is still version 2.0.0.

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

Windows runtime, Windows Bluetooth, Android 10–12 Bluetooth, real Intel radio hardware, enterprise device policies, and radio range/interference have not been validated. Windows Bluetooth is not implemented. See [Bluetooth setup and testing](bluetooth.md) for reproducible commands and the distinction between the scan suite and connection-only soak.

Private test profiles and raw device logs stay outside the repository. Release assets must contain only the intended installers, signed release APK, and checksums.
