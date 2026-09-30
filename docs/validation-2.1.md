# Version 2.1 Bluetooth validation

Status on September 29, 2026: **development candidate; full physical-device acceptance remains incomplete**. The stable public download is still version 2.0.0.

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
| Six-hour connection soak | Started September 29 at 10:29 PM Pacific; outcome pending |

The hardware recovery test exposed Android retaining an older Mac GATT service table after a test profile changed. The scanner now accepts the known channel characteristic as a candidate endpoint and still requires the exact QR-pinned TLS certificate. Retry spacing was increased to avoid Android's BLE scan-registration limit. Reconnection then passed on the same device without deleting its operating-system pairing.

The CT45 reached its PIN lock screen before the expanded physical scan suite could run. The user was asked to unlock it; its lock was not removed. The ongoing connection-only soak exchanges real Bluetooth/TLS heartbeats and restarts the Mac helper every 30 minutes. It does not test scan capture, scan replay, or the background service.

Still required before calling the Bluetooth release fully validated:

- Run the expanded physical scan suite: wrong-pin rejection, exact barcode text, dropped acknowledgements, save failures, offline replay after process restart, session changes, CT45 adapter off/on, USB switching, and background/screen-off delivery.
- Inspect the completed soak report and resolve any failures.
- Manually scan an optical barcode using the Honeywell hardware trigger; synthetic broadcasts do not test the camera/laser or firmware trigger behavior.

Windows runtime, Windows Bluetooth, Android 10–12 Bluetooth, real Intel radio hardware, enterprise device policies, and radio range/interference have not been validated. Windows Bluetooth is not implemented. See [Bluetooth setup and testing](bluetooth.md) for reproducible commands and the distinction between the scan suite and connection-only soak.

Private test profiles and raw device logs stay outside the repository. Release assets must contain only the intended installers, signed release APK, and checksums.
