# CT45 ↔ computer protocol, version 2

JSON text frames over **TLS WebSockets (`wss://`)**, TLS 1.2 or later. The desktop listens on TCP 8765, trying up to nine subsequent ports if occupied. Plain WebSocket connections are rejected. Protocol 1 pairing codes require a one-time re-pair after upgrading both apps.

## Pairing and identity

The QR code contains a URL-encoded link:

```text
ct45tracker://pair?v=2&h=192.168.1.20,127.0.0.1&p=8765&t=<token>&n=<computer-name>&id=<computer-uuid>&fp=<sha256-hex>
```

| Parameter | Meaning |
|---|---|
| `v` | Protocol version, exactly `2` |
| `h` | Initial addresses, including loopback for `adb reverse` |
| `p` | Initial TCP port |
| `t` | Random 96-bit pairing token, base64url encoded |
| `n` | Display name |
| `id` | Stable public computer ID, at most 64 alphanumeric/hyphen characters |
| `fp` | Exact leaf certificate SHA-256 fingerprint, 64 lowercase hex characters |

The desktop generates an ECDSA P-256 self-signed certificate and private key on first run. `identity.json` persists that identity independently of IP addresses, device names, sessions, and token rotation. Its file is created with mode 0600 on systems that support POSIX modes. A corrupt identity stops startup instead of silently replacing the trust anchor. The certificate lasts ten years; replacement requires scanning a new QR.

The Android TLS trust manager verifies the leaf's validity period and pinned digest before any token or barcode is sent. Its hostname verifier checks the same certificate pin: trust is in the paired identity, not an IP address or a public CA. No plaintext fallback exists. `New pairing code` changes the token and disconnects clients; it does not change the certificate.

Pairing codes are consumed only while the Android activity is visible. Invalid links leave an existing valid pairing unchanged. Legacy saved links are discarded during migration, while saved scans are retained.

## Discovery and reconnection

The desktop publishes `_ct45link._tcp` using mDNS/DNS-SD. Its service name is `ct45-<computer-id>`, with TXT entries `id=<computer-id>` and `v=2`, and the current listening port. It republishes when network interfaces change. No token, barcode, or private key is advertised.

Android uses `NsdManager` while disconnected. It matches the service name and TXT ID, resolves a candidate address and port, and then performs the **same pinned TLS handshake**. A forged discovery record cannot change the trusted identity. The successfully authenticated endpoint is cached only after welcome. QR addresses and USB loopback remain fallbacks. Discovery stops once connected and retries periodically when unavailable.

After a connection failure, retry backoff grows to 15 seconds. Each failed address gets at most a four-second connection attempt and an eight-second pairing-response window. A pending scan with no reply for ten seconds causes reconnection. Otherwise the 60-second WebSocket heartbeat detects silent failures. Discovery is local-subnet only and depends on multicast being allowed.

## Messages

Android → desktop:

```json
{"type":"hello","token":"...","device":"CT45 1A2B","app":"2.0.0"}
{"type":"scan","id":"<uuid>","data":"0000123456789","scannedAt":1790000000000,"sentAt":1790000000150,"aimId":"]C0","codeId":"j","sessionId":"<uuid>","sessionName":"Morning count"}
```

The first message must be `hello`, within five seconds. A barcode is at most 8192 characters, its ID at most 64, AIM/code IDs at most 8, and device name at most 100. WebSocket payloads are capped at 64 KiB. Scan timestamps must be finite numbers. Unknown fields are ignored.

Desktop → Android:

```json
{"type":"welcome","name":"Computer","version":2,"session":{"id":"<uuid>","name":"Morning count"}}
{"type":"session","session":{"id":"<uuid>","name":"Afternoon count"}}
{"type":"ack","id":"<scan-uuid>"}
{"type":"error","code":"bad-token|bad-message|not-paired|save-failed","message":"...","id":"<scan-id-if-known>"}
```

Session IDs are at most 64 characters; names at most 80. The scanner persists the current session and copies it into each scan at capture time. A later session change never retags the outbox. Missing session data in pre-v2 history maps to `{id:"default",name:"General"}`. The desktop recovers unknown session IDs with their supplied names, for example after restoring a backup or moving a scanner to another computer.

## Delivery and storage

Android saves each scan before sending it. Failed local writes stay visible as **Not saved**, retry every five seconds, and are withheld from the network until saved. The outbox survives process restarts. Acknowledgements remove entries from the outbox; the device retains 100 completed scans for its recent history.

The desktop appends scans to JSONL before acknowledging them, deduplicating by ID. Failed writes return `save-failed`; Android retries after five seconds. `bad-message` with a scan ID marks the entry **Rejected** and stops resending it. Damaged trailing JSONL records are separated from future records during recovery. This is crash recovery, not a guarantee against storage hardware failure or loss of an unsaved scan.

Clearing a session rewrites the remaining records atomically and keeps tombstones for the latest 10,000 cleared IDs so lost acknowledgements do not bring cleared scans back. Existing session definitions remain available. Desktop session changes are saved atomically before being broadcast to authenticated clients.

A scan whose `sentAt - scannedAt` exceeds 60 seconds is stored but not typed into another app. Comparing timestamps from the scanner's own clock avoids requiring synchronized device clocks.

## Close codes

| Code | Meaning | Android action |
|---|---|---|
| 4001 | Wrong token | Stop retrying and request re-pairing |
| 4002 | No hello | Retry |
| 4003 | Pairing token revoked | Stop retrying and request re-pairing |

The certificate and token protect transport and pairing. Local scan files and exported spreadsheets are not additionally encrypted at rest.
