# CT45 Computer Link

Scan barcodes with a Honeywell CT45 and see them on your computer, live. The desktop app (macOS
and Windows) keeps a timestamped list you can search, copy and export to CSV. It can also type
each scan into whatever app you're using, like a keyboard scanner plugged into the computer.

The Android and desktop apps currently appear as **CT45 Tracker** when installed.

**[Download the Android APK](https://github.com/hnkabraham/CT45-Computer-Link/releases/latest)**
from GitHub Releases. The current APK is a debug build for sideloading; the desktop app can
be run from source or built using the commands below.

```
CT45 (Android 13)                          Computer (macOS / Windows)
┌──────────────────────┐   Wi-Fi, same     ┌─────────────────────────────┐
│ CT45 Tracker app     │   network         │ CT45 Tracker desktop app    │
│  scan button ────────┼──────────────────▶│  list · search · CSV export │
│  outbox (offline OK) │   WebSocket       │  optional: type into apps   │
└──────────────────────┘                   └─────────────────────────────┘
```

- **Pairing:** the desktop app shows a QR code. You scan it with the CT45 once. There's no IP
  address to type.
- **Nothing gets lost:** scans made while out of Wi-Fi range, or while the computer is off,
  wait on the CT45 and send when it reconnects. They survive the app being closed.
- **No duplicates:** each scan has an ID, and the computer ignores repeats.

## Set up

### 1. On the computer

With Node.js 20+ installed, clone this repository and run the desktop app:

```sh
git clone https://github.com/hnkabraham/CT45-Computer-Link.git
cd CT45-Computer-Link/desktop
npm ci
npm start
```

Alternatively, build a desktop installer using the Development commands below. The resulting
files are written to `desktop/dist/`:

| | File |
|---|---|
| Mac with Apple silicon | `CT45 Tracker-1.0.0-arm64.dmg` |
| Mac with Intel | `CT45 Tracker-1.0.0.dmg` |
| Windows | `CT45 Tracker Setup 1.0.0.exe` |

The builds aren't signed yet, so the first launch needs one extra step:
- **macOS:** a build made on this Mac opens normally. Copied to another Mac, macOS may say the
  app "is damaged". After dragging it to Applications, run
  `xattr -dr com.apple.quarantine "/Applications/CT45 Tracker.app"` once in Terminal.
- **Windows** SmartScreen says "Windows protected your PC". Click **More info** → **Run anyway**.
  When Windows Firewall asks, allow **Private networks**. Otherwise the CT45 can't connect. Windows
  treats most new Wi-Fi networks as **Public**, which that doesn't cover. Either set your Wi-Fi to
  Private (Settings → Network & internet → Wi-Fi → your network → **Private network**) or also
  tick **Public networks** in the firewall prompt.

### 2. On the CT45

Download `CT45-Computer-Link-1.0.0-debug.apk` from the
[v1.0.0 release](https://github.com/hnkabraham/CT45-Computer-Link/releases/tag/v1.0.0).
It supports Android 8.0 and later and is intended for the Honeywell CT45 running Android 13.
Either:
- **USB:** on the CT45 turn on Developer options (Settings → About phone → tap **Build number**
  7 times) and then **USB debugging**. Plug it in and run
  `adb install -r CT45-Computer-Link-1.0.0-debug.apk` from the download folder.
- **No cable:** copy the APK to the CT45 and open it in Files. Allow installing unknown apps
  when asked.

When building from source, the debug APK is at `android/app/build/outputs/apk/debug/app-debug.apk`.

### 3. Pair

Put the CT45 on the same Wi-Fi as the computer. Open **CT45 Tracker** on both, then press the
CT45's scan button while aiming at the QR code on the computer screen. The CT45 shows
**Connected to <computer>** and the computer shows the CT45. Scan away.

The CT45 remembers the pairing. You only pair again if you click **New pairing code** on the
computer, or if the computer's network address changes (for example, a different Wi-Fi). The
CT45 then says it can't reach the computer; scan the QR code again.

## Using it

**Desktop:** click a row to copy that barcode. **Copy all** copies the list, filtered by search
if you've typed one. **Export CSV** saves time, barcode, barcode type and device, oldest first.
It opens cleanly in Excel and Numbers. **Clear** empties the list; export first if you need it.
Scans are saved as you go, so quitting the app doesn't lose them.

If a desktop write is interrupted, the next launch separates the damaged entry from new scans
so later scans remain readable after another restart.

**Type into other apps:** turn on **Type each scan where your cursor is** and choose what to
press after each scan (Enter, Tab, or nothing). Click into a spreadsheet cell or a web form and
scan. A scan isn't typed while CT45 Tracker itself is the front window; it's still listed. Scans that
waited on the CT45 while it was disconnected aren't typed when they arrive later either, so a
backlog can't pour into whatever you have open. They're listed like any other scan.
- **macOS** asks for permission the first time. Allow it in System Settings → Privacy & Security
  → **Accessibility** (and click OK if asked to let it control System Events). If you run from
  source with `npm start`, macOS may ask about your terminal app instead. After installing a
  new build, turn the Accessibility switch off and on again; macOS ties the permission to
  that exact build.
- **Windows** needs no setup. It can't type into apps running as administrator.

**CT45:** the screen shows connection status, the last scan, and recent scans marked **Sent** or
**Waiting**. You can type or paste a barcode in the box at the bottom. Normally the app takes
over the scanner only while it's on screen; other apps get it back normally.

If the CT45 cannot save a scan, it shows **Not saved** and a warning on screen (and in the
background notification). Keep the app running and free some storage. It retries every five
seconds and sends the scan once it is saved. Unsaved scans cannot survive the app being stopped.
Invalid pairing codes show an error and leave the current pairing in place.

**Pairing** only works with CT45 Tracker open on screen. A pairing code that arrives while it's in
the background is ignored, so another app on the CT45 can't point it at a different computer.

**Keep running in the background (CT45):** turn this on to keep scanning while the CT45 is locked
or another app is open. A silent notification shows while it's on. To stop, tap **Turn off** on
the notification or use the switch. It comes back on by itself after a restart. While it's on,
other apps on the CT45 don't receive scans.

- **If scans only go through while the app is open:** the scanner may not stay with an app
  that's not on screen. Set it on the CT45 instead: Settings → Honeywell Settings → Scanning →
  Internal Scanner → Default profile → Data Processing Settings. Turn off **Wedge**, turn on
  **Data Intent**, and set its action to `com.henokabraham.ct45tracker.SCAN`. Menu names can
  differ slightly between firmware versions. Every scan then goes to CT45 Tracker, whatever is on
  screen.
- **With the screen fully off**, it depends on whether the CT45's scan button works while the
  screen is dark. Try it: if the red aiming light comes on, scans go through; if not, press Power
  first.
- **If Android stops the app** (rare with the notification showing), it restarts it within a
  few seconds. Scans made in that gap are lost, because the scanner is still set to hand them to
  an app that isn't running. To check, with the CT45 plugged in, run
  `adb shell am kill com.henokabraham.ct45tracker`, scan straight away, and see whether the scan
  arrives.

## If it won't connect

| CT45 says | Try |
|---|---|
| Can't reach <computer> | CT45 Tracker must be open on the computer and both devices on the same Wi-Fi. Guest and corporate networks often block device-to-device traffic. Use a phone hotspot or the USB fallback below. On Windows, check the firewall allowed CT45 Tracker on private networks. On a Mac with the firewall on, click **Allow** when asked about incoming connections (unsigned builds may ask on each launch) |
| Pairing code changed | Someone clicked **New pairing code**. Scan the new QR code |
| Not connected | Not paired yet. Scan the QR code |

**Security:** the connection is plain `ws://` on your local network. Anyone on the same Wi-Fi who
can capture traffic could read scans and the pairing token. The QR code on screen is the key:
anyone who scans it can send scans to your computer, so click **New pairing code** if someone
else may have scanned it. Scans marked **Rejected** on the CT45 were refused by the computer and
won't be sent again.

**USB fallback** for networks that block device-to-device traffic: plug the CT45 into the computer
(USB debugging on) and run `adb reverse tcp:8765 tcp:8765`. The pairing code already includes
this route, so the CT45 connects over the cable within a few seconds. Run the command again
after unplugging and replugging.

## Development

```
desktop/   Electron app (Node 20+). src/ has the logic, ui/ the window.
android/   Kotlin app, no Honeywell SDK needed (uses Honeywell's broadcast intent API).
docs/protocol.md   What goes over the wire.
```

```sh
cd desktop
npm test               # unit tests: protocol, server, CSV, typing commands, storage
npm run e2e            # launches the real app in a throwaway profile and drives it with a fake scanner
npm run fake-scanner -- "<pairing link>" 0123456789012   # send scans to a running app (Copy pairing link)
npm run android-e2e    # Android app on an emulator or USB device against the desktop server code
npm run dist:mac       # dmg for Apple silicon and Intel → dist/
npm run dist:win       # Windows installer → dist/ (builds on a Mac too)

cd android
./gradlew testDebugUnitTest assembleDebug   # needs JDK 17 (JAVA_HOME) and the Android SDK
```

`android-e2e` needs a running emulator (`emulator -avd ct45-test`) or a device. With the
emulator, the computer is `10.0.2.2`. It stands in for the scanner by sending the same
broadcast Honeywell's scanner service sends.

**Honeywell scanner details:** while the app is on screen, it claims the scanner with
`com.honeywell.aidc.action.ACTION_CLAIM_SCANNER`. The claim sets `DPR_DATA_INTENT` and
`DPR_WEDGE=false`, so scans arrive as broadcasts rather than keystrokes. If a unit doesn't honor
the claim, its keyboard-wedge output lands in the app's text box and Enter sends it. So scanning
still works; it just may need a tap on **Send** if the wedge doesn't add Enter.
