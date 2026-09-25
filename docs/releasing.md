# Release signing and recovery

## Android

`assembleRelease` produces a non-debuggable, unsigned APK. Never use the debug build as a public release again. `scripts/sign-release.sh` verifies that the input is not debuggable, signs it, checks its signatures, and checks ZIP alignment.

The maintainer's private signing directory defaults to `~/.local/share/ct45-computer-link/signing` (override with `CT45_SIGNING_DIR`). It contains:

- `release.keystore` — dedicated release key, alias `ct45release`.
- `release-password.txt` — password read directly by signing tools, never passed inline.
- `legacy-debug.keystore` and `legacy-password.txt` — the signer of the published v1.0.0 APK.
- `signing-lineage.bin` — authenticated rotation from that original signer to the release signer. Rollback to the old signer is disabled.

These files must **never** be committed, attached to a release, or included in screenshots/logs. A restricted local copy was created at `~/Documents/CT45 Computer Link Signing Backup`. A second copy on the same computer does not protect against loss of that computer: the maintainer should place an encrypted backup in secure offline storage or a password manager. Preserve both keys, both passwords, and the lineage together.

Release certificate SHA-256:

```text
615d55340375abf6490f175a5c3921ff0ee7880c10ce28bc5dfbaa68971823a2
```

The v2 APK uses signing scheme v3 rotation from Android 9 (API 28). Android 8 uses the original v2 signer for backwards compatibility. The application ID remains `com.henokabraham.ct45tracker`; increase `versionCode` for each release. Updating the published v1 APK on Android 13 preserves app data without uninstalling. Unrelated developer debug keys are not part of this lineage.

```sh
cd android
./gradlew testDebugUnitTest assembleRelease lintDebug
sh scripts/sign-release.sh /absolute/path/to/CT45-Computer-Link-VERSION.apk
```

Set `JAVA_HOME` to JDK 17 and `ANDROID_HOME` to the SDK as needed. Signing defaults to build tools 35.0.0; override with `ANDROID_BUILD_TOOLS_VERSION`. The script's default output name must be updated with the app version. Restoring a missing key requires the backup; generating a different key will not preserve the existing upgrade identity.

## Desktop

Keep the Electron app ID and original data directory stable. Change version fields in `desktop/package.json` and regenerate the lockfile, then run:

```sh
cd desktop
npm ci
npm test
npm run e2e
npm run dist:mac
npm run dist:win
CT45_APP='dist/mac-arm64/CT45 Computer Link.app/Contents/MacOS/CT45 Computer Link' npm run e2e
```

Mac apps use ad-hoc code signatures (`identity: "-"`) so their nested frameworks pass integrity checks. The current installers have no verified publisher signing or Apple notarization. They require the first-run steps in the README. Adding those later requires the maintainer's Apple Developer ID and/or Windows signing credentials; Android signing does not sign desktop installers.

Upload only the three installers, the signed release APK, and `SHA256SUMS.txt`. Normalize asset names to `CT45-Computer-Link-VERSION-mac-arm64.dmg`, `-mac-x64.dmg`, and `-windows-x64.exe`. Keep private keys, debug APKs, test fixtures, and build caches out of release assets. Use a release tag pointing at the exact tested commit and verify uploaded checksums.

## Android release integration test

Run `desktop/scripts/android-release-e2e.mjs` on a disposable Android 13 emulator, with `OLD_APK` pointing at the actual v1.0.0 release asset and `ANDROID_SERIAL` selecting the emulator. `RESET_TEST_APP=1` uninstalls this app first, only after verifying the target is an emulator.

The emulator's virtual network may not carry mDNS from the host's LAN. For that environment, `desktop/scripts/discovery-fixture/build.sh /tmp/ct45-discovery-fixture` builds a **test-only** Android app. Set `DISCOVERY_FIXTURE_APK=/tmp/ct45-discovery-fixture/fixture.apk` for the test. It advertises a new address/port through real Android NSD and forwards opaque TLS bytes to the desktop server. It cannot decrypt or authenticate the traffic; the normal production app still checks the pinned certificate. This tests Android discovery and endpoint migration without adding a test hook to the production app. It is not a physical Wi-Fi interoperability test.
