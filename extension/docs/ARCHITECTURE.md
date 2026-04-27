# Architecture & migration plan

## Current stack (v1.0)

```
[Browser A]                                    [Browser B]
  side panel                                     side panel
    └── popup.js                                    └── popup.js
         │                                              │
         ├── PeerJS 1.5.4  ←── 0.peerjs.com  (WSS) ──→  ├── PeerJS 1.5.4
         │    ↓                                          │    ↓
         │  RTCPeerConnection ←── DTLS-SRTP ─────────→ RTCPeerConnection
         │    ├── data channel (sync, chat, heartbeat)   │
         │    ├── audio track  (Opus, 32 kbps)           │
         │    └── video track  (VP8,  500 kbps)          │
         │                                              │
  background.js (MV3 SW)                         background.js
    └── routes HT_* messages                        └── routes HT_* messages
         ↕                                              ↕
  content.js (isolated world)                    content.js
    └── wraps <video>, emits play/pause/seek       └── same
```

### Components

| Layer | Tech | Where |
|---|---|---|
| UI | HTML / CSS / vanilla JS | [popup.html](../popup.html), [popup.css](../popup.css), [popup.js](../popup.js) |
| Signalling | PeerJS cloud (default) or self-hosted PeerServer | [lib/peerjs.min.js](../lib/peerjs.min.js) |
| Media transport | WebRTC (`RTCPeerConnection`) with DTLS-SRTP | browser-native |
| Data channel | PeerJS `DataConnection` (reliable, ordered) | browser-native |
| Sync events | Timestamped `{kind, time, rate, at}` envelopes over data channel | [popup.js](../popup.js), [content.js](../content.js) |
| Drift correction | Host broadcasts `drift-sync` every 5 s | [popup.js#broadcastTimeSync](../popup.js) |
| NAT traversal | STUN (Google/Cloudflare/Twilio) + TURN (OpenRelay default, customisable) | |
| QoS | `RTCPeerConnection.getStats()` polled every 3 s | [popup.js#startStatsLoop](../popup.js) |
| Media control | `getUserMedia`, `RTCRtpSender.setParameters`, `replaceTrack` | |
| Page hook | Content script (isolated world) + optional page-context script (MAIN world) | [content.js](../content.js), [page-context.js](../page-context.js) |
| Storage | `chrome.storage.local` (settings) + `chrome.storage.session` (last room) | |

### Message envelopes on the data channel

```js
{ t: "hello",        name }
{ t: "chat",         text }
{ t: "sync",         action: { kind, time, rate?, at? } }
{ t: "request",      action }       // guest → host in host-authority mode
{ t: "drift-sync",   action: { time, rate, paused, at } }   // host broadcast, 5 s
{ t: "need-time-sync" }             // guest asks host after refocus
{ t: "ping",         at }
{ t: "pong",         at }           // echoes the ping's `at` for RTT calc
```

---

## Why PeerJS for v1

- **Zero infra** — public cloud handles signalling for free.
- **Full `RTCPeerConnection` access** — `peerConnection` property exposes the raw PC for `getStats`, `setParameters`, `replaceTrack`. Not a sealed abstraction.
- **Handles reconnection, ICE-candidate munging, SDP boilerplate** — ~1000 LOC of code we don't have to write and debug.

### Where PeerJS becomes the bottleneck

1. **Public signalling rate-limits.** OK for casual use, flaky at scale.
2. **No simulcast / svc support** without SDP munging — WebRTC encodings work but PeerJS doesn't emit `a=simulcast` lines.
3. **No authentication** — anyone can connect to a known peer ID.
4. **Single signalling server** — no multi-region failover.

Point 1 is addressed in v1 by the **Settings panel** (users plug in their own PeerServer). Points 2–4 would require replacing PeerJS.

---

## Migration plan — PeerJS → raw WebRTC + custom signalling

Staged so each step is independently valuable and reversible.

### Stage 1 — Custom signalling over WebSocket (no code changes for users)
_Effort: ~1 weekend_

- Write a 100-LOC WebSocket server. Room identifier = channel name; server forwards `offer`, `answer`, `ice-candidate` messages between the two sockets in a channel.
- Add auth: room codes become short-lived tokens issued by a lightweight API (Cloudflare Worker / Fly app).
- Replace `new Peer()` with a hand-rolled `Signaller` that uses `RTCPeerConnection` directly.
- Public API of the client stays the same: `createRoom`, `joinRoom`, `sendData`, `call`. Everything above the signalling layer is untouched.
- User-facing: nothing changes. Default endpoint is our service; Settings still exposes a self-host field.

### Stage 2 — Simulcast + SVC
_Requires Stage 1 — PeerJS's SDP can't carry these._

- Add `a=simulcast` on outbound SDP (three rungs).
- On receive, use `getReceivers()` + `preferredCodecs` to pin VP9-SVC when supported.
- Exposes bandwidth-adaptive behaviour that today is simulated via `maxBitrate`.

### Stage 3 — Multi-party (SFU)
_Only if we grow beyond 2 people per room._

- Pick an SFU (mediasoup / LiveKit / ion-sfu).
- Signalling server routes offer/answer to the SFU instead of peer-to-peer.
- Data channel sync moves to server-authoritative state (same `drift-sync` envelope, but sent by the SFU process instead of the host user).

### Stage 4 — E2EE for multi-party
_After Stage 3 — DTLS-SRTP isn't end-to-end when media goes through an SFU._

- Add **insertable streams** / **SFrame** on top of SRTP.
- Keys exchanged over the data channel (already E2E through the data channel's DTLS).

---

## Deferred work

| Item | Priority | Notes |
|---|---|---|
| Simulcast SDP munging | Medium | Blocked on PeerJS replacement |
| Persistent session across SW wake | Low | Side panel closes → peer dies; needs offscreen doc if we care |
| True SFU for 3+ participants | Low | Out of scope for current product |
| Content-script adoption of MAIN-world helpers | Low | [page-context.js](../page-context.js) scaffold in place; currently unused |
| Telemetry (opt-in) | Low | Would need a backend and privacy-policy update |
