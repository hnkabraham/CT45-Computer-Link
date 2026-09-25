# CT45 ↔ computer protocol

The CT45 app connects to the desktop app over a WebSocket on the local network. The desktop app
listens on port 8765, or the next free port up to 8774. Everything is JSON text frames.
`desktop/src/protocol.js` and `android/.../Protocol.kt` implement the two sides.

## Pairing

The desktop app shows a QR code holding a link:

```
ct45tracker://pair?h=192.168.1.20,10.0.0.5,127.0.0.1&p=8765&t=Xk3...&n=Henoks+MacBook
```

| Param | Meaning |
|---|---|
| `h` | Addresses to try, in order: this computer's LAN addresses, then `127.0.0.1` for a USB cable with `adb reverse` |
| `p` | Port |
| `t` | Pairing token, 16 random characters. **New pairing code** in the desktop app replaces it and disconnects every scanner |
| `n` | Computer name, shown on the CT45 before it connects |

The CT45 treats any scan that starts with `ct45tracker://pair?` as a pairing code rather than a
barcode. It stores the link and connects. It remembers which address worked and tries that one
first next time.

## Messages

CT45 → computer:

```json
{"type":"hello","token":"Xk3...","device":"CT45 1A2B","app":"1.0"}
{"type":"scan","id":"<uuid>","data":"0123456789012","scannedAt":1790000000000,"sentAt":1790000000150,"aimId":"]E0","codeId":"d"}
```

`hello` must be the first message, within 5 seconds. `aimId` is the standard AIM symbology
identifier and `codeId` is Honeywell's own code ID; both may be empty (for typed entries).
`sentAt` is when this copy was sent, by the CT45's clock. If it's more than 60 seconds after
`scannedAt`, the scan waited in the outbox, and the desktop doesn't type it into other apps.
Comparing two times from the same clock means the device and computer clocks needn't agree.

Computer → CT45:

```json
{"type":"welcome","name":"Henoks MacBook","version":1}
{"type":"ack","id":"<uuid>"}
{"type":"error","code":"bad-token|bad-message|not-paired|save-failed","message":"...","id":"<scan id, when there is one>"}
```

- `bad-message` with an `id`: the computer will never accept that scan. The CT45 marks it
  **Rejected** and stops sending it.
- `save-failed`: the computer couldn't store it. The CT45 offers it again after 5 seconds.

## Delivery

The CT45 keeps every scan in an outbox, saved to disk, until it gets the `ack` for that scan's
`id`. On every (re)connect it sends everything still in the outbox, oldest first. The computer
ignores an `id` it already has, so a resend after a lost ack can't create a duplicate.

## Close codes

| Code | Meaning | CT45 does |
|---|---|---|
| 4001 | Wrong token | Stops retrying; shows "Pairing code changed" |
| 4002 | No `hello` in time | Retries |
| 4003 | Computer made a new pairing code | Same as 4001 |

Both sides ping every 60 seconds, to save the CT45's battery. The computer drops a scanner
that misses a pong, so one that silently leaves Wi-Fi range stays listed for up to two minutes.
The CT45 also reconnects if its oldest unanswered scan gets no reply within 10 seconds, so a
dead connection is noticed as soon as it matters. The 10 seconds restart only when the computer
answers, not with each new scan, so steady scanning can't hide a dead connection. The computer
handles each scanner's messages one at a time, in order. When the
connection drops it retries by itself. An address that doesn't answer is skipped to the next
one straight away. After each round through all the addresses it waits longer, up to 15
seconds. Bringing the app to the front retries at once.
