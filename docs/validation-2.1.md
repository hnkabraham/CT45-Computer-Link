# Version 2.1 validation

Status on September 30, 2026: **development candidate; full physical-device acceptance remains incomplete**. The stable public download is still version 2.0.0.

## September 30 Clear interface

The selected Clear concept is implemented in both apps, with teal accents, readable spacing, and separate workspaces. Android has Scan, History, and Settings navigation, an explicit manual-entry action, and keyboard-wedge fallback. Desktop has Scans, Sessions, and Settings navigation; viewing a session and resuming it remain distinct actions. Pairing and typing controls live in Settings, with connection state always visible. Dark appearance and narrow layouts remain supported. The [Clear gallery](images/clear/README.md) contains captures of the running apps and identifies simulated data.

The new list layout exposed an accessibility failure when an older rejected 70,000-character barcode became visible. List and latest-scan previews now show at most 160 Unicode code points with an ellipsis. The stored scan, row detail, Copy action, and delivery payload keep the full text. The oversized-entry recovery test passed after this fix.

Desktop unit/integration tests passed all 43 checks. Android unit tests passed all 27 checks. Android debug/release builds and lint succeeded with zero errors and the same seven existing warnings; the release APK passed signing and alignment verification.

The source desktop app passed all 51 end-to-end checks. The packaged Apple silicon Mac app passed all 56, including actual packaged Bluetooth helper startup/restart and navigation through the new Sessions and Settings views. Both Apple silicon and Intel DMGs were rebuilt; this turn did not rerun the Intel package under Rosetta or test Windows runtime.

All 29 Android polish assertions passed on the disposable Android 13 emulator, including oversized-entry recovery, session selection, offline discard, Copy/paste, feedback persistence, the three navigation views, 48dp manual controls at 720×1280, keyboard-wedge entry, and navigation with 130% text size. The larger-text screenshots were inspected and clipped controls corrected. The selected light navigation treatment uses `#007C83` text on `#EEF7F7` (4.58:1 contrast); dark uses `#70D4D6` on `#23434B` (6.11:1), calculated from sRGB relative luminance.

The signed Clear APK was installed as an update on the plugged-in CT45P. All 19 functional physical Bluetooth checks passed, followed by the persisted-log reload check: 39 records with 39 unique IDs, one intentionally lost acknowledgement correctly deduplicated, and no replay of the discarded scan. This covered shared session selection, exact barcode text, certificate rejection, adapter off/on, save retry, offline queues across process restart, USB switching, and Home-screen background delivery/reconnection. No additional soak was run. An initial runner attempt stopped before any scan checks because Quick Settings covered the app; the runner now collapses that panel before launching without dismissing a screen lock.

Cleanup completed successfully: Wi-Fi and Bluetooth are on, background scanning is off, the prior test pairing and connection mode are restored, and the requested charging stay-awake setting remains `7` with `mStayOn=true`. PIN protection and management policies were unchanged. The overnight automation remains paused. Private test profiles and raw logs remain outside the repository.

The final large-text adjustment lets the More, connection-help, retry, and session controls grow vertically instead of clipping. These layout changes, the selected-tab contrast adjustment, and keyboard-input fixes followed the radio suite. Tab moves out of the refreshing scan list, while Space still activates a focused button. Printable keys go directly to the editor so fast keyboard-wedge input cannot lose its prefix while the newly opened field gains focus. All four focused emulator checks passed: Tab/Space navigation, exact entry text, Enter submission, and a rapid barcode plus Enter from Settings. The final signed update was installed on the CT45 and startup/navigation controls verified; the device was returned to Home. Transport, queue, and storage code were unchanged by these final adjustments.

Reproduce the focused keyboard checks after the Android polish suite with `ANDROID_SERIAL=emulator-5580 node scripts/android-navigation-e2e.mjs` from `desktop`, substituting the disposable emulator's serial. The script refuses physical devices.

## September 30 Bluetooth-switch regression

Further plugged-in CT45P testing exposed an active LE channel surviving the main Bluetooth switch being turned off. Android reported `enabled: false` with its radio in `BLE_ON`, and a diagnostic scan still reached the computer. This was reproduced with the existing test identity and was not caused by Hub re-enabling the switch.

The Android tunnel now observes the protected adapter-state broadcast, checks the real public adapter state, and closes its discovery/socket resources when Bluetooth is disabled. The receiver is unregistered when the tunnel closes. The normal reconnection queue then resumes delivery when Bluetooth is enabled again. This respects the device's switch without changing system scanning or management policies. The dynamic receiver accepts privileged Bluetooth system broadcasts as described in the [Android broadcast documentation](https://developer.android.com/develop/background-work/background-tasks/broadcasts).

The rebuilt signed APK was installed as an update. Its physical regression check passed: the app left Connected while the switch was off, a new scan remained queued, and enabling Bluetooth delivered it with acknowledgement. All 27 Android unit tests passed; debug/release builds and lint passed with zero errors and seven existing warnings. Release signature and alignment verification passed.

All 19 functional hardware checks then passed on that build, covering pinned TLS, Bluetooth off/on, handheld session selection, Wi-Fi-off delivery, exact barcode text, wrong-pin rejection, lost-ack deduplication, save retry, offline help/retry controls, 25 queued scans across process restart, local discard, capture-time session retention, USB switching, and Home-screen background delivery/reconnection. The earlier runner stops were retained in private reports: two involved UI navigation in the harness, and the third exposed the Bluetooth-switch bug above.

The follow-on 15-minute scan soak completed at 10:52 PM Pacific with all eight injected scans delivered over the real Bluetooth link. Reloading the desktop log and an independent inspection confirmed 48 records with 48 unique IDs: 39 functional scans, eight soak scans, and one previously queued feedback-test scan that survived the APK update. The deliberately lost acknowledgement caused one replay, correctly deduplicated. The discarded record was absent. The short soak had no planned helper restart because it ended before the runner's 15-cycle restart interval; helper restart recovery was exercised in the functional suite. This passes the short run, not the incomplete six-hour target.

Cleanup completed without errors. Wi-Fi and Bluetooth are on, background scanning is off, the existing test pairing and connection mode were restored, and Home is visible. The requested stay-awake-while-charging setting remains `7`, with `mStayOn=true`; PIN protection was unchanged. The runner and its Mac sleep-prevention process exited, and the overnight automation remains paused. Private identities and raw logs remain outside the repository.

The feedback controls were also exercised on the CT45: Sound and vibration was selectable and survived process restart after the UI confirmed the choice. With the device's existing Silent mode preserved, a waiting-feedback test produced no vibration request from this app. The feedback preference was restored to Off. This does not verify perceived sound/vibration patterns or independently establish Do Not Disturb behavior.

## September 30 main-branch hardware follow-up

PR #1 was merged into `main` at the owner's request. The latest signed 2.1.0 APK was installed as an update on the reconnected physical CT45P, retaining the existing test pairing and prior scan history. It established the pinned TLS Bluetooth connection in about four seconds and reconnected after a planned Mac helper restart in about ten seconds. Three synthetic barcode records were received exactly once through Bluetooth, and the handheld showed the latest acknowledgement. The compact view and settings opened on the physical device; delivery feedback remained off by default.

The subsequent two-minute connection check completed with 24 connected samples and zero unexpected disconnects. The temporary server and helper exited normally; the CT45 was returned to its Home screen with background scanning off.

The pending overnight settings cleanup is complete: Wi-Fi is on and background scanning is off, with no scanning service left running. The requested stay-awake-while-charging preference had reset to off; it was restored to `7` and verified with `mStayOn=true`. PIN protection was preserved and the screen was not deliberately put to sleep. The overnight automation remains paused.

This short follow-up does not complete the six-hour acceptance target or verify optical trigger scanning, screen-off behavior, sound/vibration, or silent/Do Not Disturb behavior. No stable release was published.

## September 30 final UX refinements

The newest build adds an actionable empty search view, explanations for disabled session selection, route-specific connection help with settings shortcuts, a manual retry that preserves pairing and Bluetooth registration limits, a compact scanning view, and optional delivery feedback. The background notification no longer promises screen-lock behavior.

- All 43 desktop unit/integration tests and 27 Android unit tests passed. The feedback tests cover acknowledgement-only receipt signals, durable waiting scans, later receipt, duplicate/restored history, discarded/rejected entries, expiry, and grouped outcomes.
- All 44 source desktop end-to-end checks passed, including no-match search recovery and appropriately disabled copy/export controls. This run did not enable Bluetooth.
- All 22 Android workflow checks passed on a disposable Android 13 emulator, including connection help, disabled-session explanations, compact settings, feedback choices and preference persistence, exact Copy/paste, and accessible input and queue actions at 720×1280. The emulator screenshot gallery was refreshed and visually inspected.
- Android debug/release builds and lint passed with zero errors and seven existing warnings. The release APK was signed with the existing key lineage and signature/alignment verification passed.
- Both Mac DMGs and the Windows x64 installer built. Packaged runtime and Bluetooth checks were not repeated for this refinement; the earlier results below remain separate evidence.

Physical testing was initially deferred at the owner’s request; the limited follow-up above was completed after the CT45 was reconnected. Sound, vibration, silent/Do Not Disturb behavior, and broader checks of the new controls still need verification on the CT45. Emulated UI checks cannot establish those hardware behaviors. The overnight automation remains paused and the stable release remains 2.0.0.

## Earlier September 30 product and design improvements (9e8a65d)

That commit added local queue actions, guided connection recovery, handheld session selection, exact repeated-barcode markers, visible Copy buttons, and clearer connection labels. It rejects oversized input without truncation and recovers invalid entries saved by older versions. Android status and history scroll together on short screens while manual barcode entry stays accessible. The pairing panel puts Copy pairing link before the Bluetooth controls and keeps token revocation secondary.

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

Those Android workflows were exercised on a disposable Android 13 emulator against the production desktop TLS server. A saved 70,000-character entry was rejected locally and the following valid scan delivered. New 8,193-character input was rejected without disconnecting. A 101-character device name connected with a bounded hello name. Session selection changed the desktop session; waiting scans retained their original session. Confirmed local discard survived restart and prevented retry of that record. A pairing without Bluetooth offered a working network switch, and reselecting the active transport preserved the connection.

The emulator's barcode input is synthetic. At that validation point, the APK had not been installed or tested on the physical CT45; see the later limited hardware follow-up above. The updated Intel packages have not been rerun under Rosetta. The historical radio evidence below applies to the earlier Bluetooth build. The overnight automation remains paused. Screenshots and reproducible test commands are in the [gallery](images/v2.1/README.md) and [README](../README.md).

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

Independent inspection of the persisted desktop log found 201 records with 201 unique IDs: 38 functional-test scans and all 163 soak scans in an uninterrupted sequence. The single repeated delivery was the deliberately lost acknowledgement in the functional suite, correctly deduplicated in storage. The runner and its Mac sleep-prevention process exited. Cleanup initially could not restore the temporary CT45 Wi-Fi/background settings because ADB remained unavailable; that cleanup was completed during the later main-branch follow-up above. The requested stay-awake-while-charging preference remains enabled. Test reports and persisted records remain in a private local directory.

Still required before calling the Bluetooth release fully validated:

- Complete an uninterrupted soak before claiming the six-hour check passed.
- Manually scan an optical barcode using the Honeywell hardware trigger; synthetic broadcasts do not test the camera/laser or firmware trigger behavior.
- Verify screen-off scanning when the owner can unlock the device again; Home-screen background checks do not establish screen-off behavior.
- Complete manual usability checks of the queue/session controls and keyboard on the physical CT45, including returning to the app without the soft keyboard covering scan history. The automated physical checks above covered session selection, local discard, and offline help/retry.
- Check perceived sound/vibration patterns and Do Not Disturb behavior; the physical feedback check above covered selection, persistence, and Silent-mode vibration suppression.

Windows runtime, Windows Bluetooth, Android 10–12 Bluetooth, real Intel radio hardware, enterprise device policies, and radio range/interference have not been validated. Windows Bluetooth is not implemented. See [Bluetooth setup and testing](bluetooth.md) for reproducible commands and the distinction between the scan suite and connection-only soak.

Private test profiles and raw device logs stay outside the repository. Release assets must contain only the intended installers, signed release APK, and checksums.
