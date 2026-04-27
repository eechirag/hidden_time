# Hidden Time

A Chrome extension for watching movies together on **Netflix, YouTube, SonyLiv, Zee5, JioHotstar, JioCinema** and **Amazon Prime Video**, with built-in **video, voice and audio calls** and **text chat**.

## What it does

- **Synced playback** — play / pause / seek forward / seek backward / speed change on either side is mirrored on the other, instantly and bidirectionally.
- **Peer-to-peer calls** — video call, audio-only call, and live mute / camera-off toggles. Runs over WebRTC, so media goes direct between you and your friend (or via TURN relay when needed).
- **Room codes** — create a short 6-character code, share it, and join in one click. No account, no login.
- **Text chat** alongside the call.

## Supported sites

| Platform | Matched URLs |
|---|---|
| Netflix | `*.netflix.com` |
| YouTube | `*.youtube.com` (incl. `m.youtube.com`, `music.youtube.com`) |
| SonyLiv | `*.sonyliv.com` |
| Zee5 | `*.zee5.com` |
| JioHotstar | `*.hotstar.com` |
| JioCinema | `*.jiocinema.com` |
| Prime Video | `*.primevideo.com`, `amazon.com/gp/video/*`, `amazon.in/gp/video/*`, `amazon.co.uk/gp/video/*` |

The content script runs only on these domains, and only on the main frame (not ad iframes). Any other page in the browser is untouched.

## Install (load unpacked)

1. Open `chrome://extensions` in Chrome / Edge / Brave.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder.
4. Pin the **Hidden Time** icon to the toolbar.

## Use

1. Open the movie on any supported site (e.g. netflix.com/watch/...).
2. Click the **Hidden Time** toolbar icon. A side panel docks to the right of your browser and the page reflows to fit — no overlay hiding part of the video.
3. One of you clicks **Create room** and shares the 6-character code. The other pastes it and clicks **Join**.
4. Watch the `Room ready — waiting for partner to join…` line under the code. It switches to `Connected with GUEST-XXXXXX` in green when your partner actually joins.
5. Pick the streaming tab from the **Watching** dropdown (click ↻ if it isn't listed yet).
6. Click **Mic** to voice-call your partner, click **Cam** to share your camera. Either one auto-starts the call — no separate call button. Both turn blue when they're live.
   - **Testing your mic before the call:** the thin bar at the bottom of the "You" tile is a live level meter. When Mic is on, it moves with your voice — speak normally and you should see it pulse green/blue, turning amber on loud peaks. If the bar stays flat, your mic isn't being picked up (wrong device selected in OS settings, hardware muted, or permission denied).
7. Play the movie. Your pause / play / seek is now mirrored on your partner's tab, both ways.

### Watching in a big view

Because Hidden Time is a side panel, it stays docked next to the page at all times. To maximise the streaming area without hiding the side panel:

- **Press F11** (or Cmd/Ctrl + Shift + F on macOS) to toggle Chrome's browser-fullscreen. The side panel remains visible and the page fills the rest of the screen.
- **Do not click the streaming platform's own fullscreen button** (the diagonal-arrows icon inside the player). Native video-element fullscreen covers the entire screen including the side panel, so your call/chat disappears.
- Drag the left edge of the side panel to make it narrower — the movie gets more room.

If your partner doesn't show up after a few seconds, click **Retry** in the room bar — it rebuilds the connection without losing your room code. This covers the case where one of you opened the extension slightly before the other, or the signalling server blipped.

### Partner disconnected — rejoining

- **If your partner closes their side panel, loses Wi-Fi, or reloads the tab**, the room stays alive on the host side. You'll see `Partner left — they can rejoin with code PEDFHS` under the code.
- **The partner just opens Hidden Time again, pastes the same code into Join, and clicks Join.** They reconnect instantly. No need to create a new room.
- **On the guest side**, a transient network drop auto-retries up to 3 times before asking you to click **Retry**.
- **Clicking Leave really ends the room.** After Leave, the code is discarded. To start again, click **Create room** — you get a fresh code every time. The old code won't work anymore.

## Permissions

Hidden Time needs camera and microphone access for video / audio calls. Nothing else — no location, no contacts, no browsing history.

- Two dots at the top of the window show the current state of each permission: **green** = granted, **amber** = not yet asked, **red** = blocked, **grey** = unknown.
- The **Grant access** button triggers Chrome's native permission prompt on a user click (Chrome does not allow us to prompt silently). You can grant access up-front, or wait and grant it when you click **Call** / **Audio**.
- If you accidentally blocked access, click the small camera icon in Chrome's address bar — or open `chrome://settings/content` — and change Hidden Time back to **Allow**.
- The extension never records or uploads your audio/video anywhere. Streams go peer-to-peer over WebRTC, end-to-end encrypted by the browser (DTLS-SRTP).

## Settings

Click the ⚙ icon in the header to open the Settings panel.

- **Signalling host / port / path / secure** — point the extension at your own PeerServer. Leave blank to use the free PeerJS cloud.
- **TURN URL / user / password** — point at your own coturn or a managed TURN service. **Recommended for India:** sign up for a free [Metered.ca](https://www.metered.ca/) account (50&nbsp;GB/month free) and paste its `turns:` URL here — when set, this is tried *before* the public Open Relay fallback. Leave blank to use Open Relay only.
- **Host-only controls** — when checked, only the host's play / pause / seek is broadcast. Guest actions are sent as "requests" which the host decides whether to apply.
- **Show call stats** — reveals a row at the bottom of the panel with live RTT, packet loss, and up/down bitrate pulled from `RTCPeerConnection.getStats()`.

See [docs/SELF_HOST.md](docs/SELF_HOST.md) for a step-by-step on deploying your own PeerServer and coturn.
See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the message-envelope spec and the migration plan from PeerJS → raw WebRTC.

## Working in India

Indian ISPs (Jio, Airtel fibre, BSNL, many cable operators) run **CGNAT**, which often blocks direct peer-to-peer WebRTC. Hidden Time is pre-configured with:

- Multiple STUN servers (Google, Cloudflare, Twilio) so one outage doesn't break signalling.
- A free public **TURN relay** (Open Relay Project) that the call falls back to when STUN can't punch through the carrier NAT.

Both ports 80 and 443 are used for the TURN relay so it works even on strict office / campus networks that only allow HTTP(S) traffic.

**For better India reliability**, configure a dedicated TURN in Settings — both options are completely free:

- **Easiest:** sign up at [Metered.ca](https://www.metered.ca/) → free account, no credit card → 50&nbsp;GB/month TURN bandwidth → paste the `turns:` URL into Settings → done. The extension will try it before the public fallback.
- **Forever-free, self-owned:** deploy coturn on an [Oracle Cloud Always-Free VM](docs/SELF_HOST.md#recommended-host-oracle-cloud-always-free-zero-ongoing-cost) in Mumbai or Hyderabad. ~1 hour of one-time setup, zero rupees recurring, India PoP for low latency.

## Performance & reliability

- **Bitrate caps.** Outgoing video is capped at 500 kbps and audio at 32 kbps. WebRTC automatically scales further down under congestion. This is the right knob for typical Indian mobile and shared Wi-Fi uplinks — it keeps the call crisp instead of dropping packets.
- **Capture resolution** matches the side-panel tile size (480×360 @ 24 fps ideal). Higher resolutions would only be downsampled for display while costing bandwidth.
- **Throttled seeks.** Dragging the scrubber used to fire a stream of `seeked` events at the peer. They're now debounced to the final position, sent 150 ms after the scrub stops. Play / pause stay immediate.
- **Data-channel heartbeat.** A 10-second ping / pong surfaces silently-dead connections (mobile sleep, Wi-Fi handoff) instead of waiting for the next sync event. The UI warns if 25 s pass without a reply.
- **Bounded auto-reconnect.** If the data channel drops with the room still active, the extension retries up to 3 times with linear back-off before asking you to click **Retry** manually.
- **Content-script efficiency.** No more 2-second polling loop; a single debounced MutationObserver attaches to the correct video element on SPA navigation.
- **Remote code forbidden.** PeerJS is bundled locally (93 KB) — no runtime script fetch, faster first paint, and required for Chrome Web Store.

## Notes

- Signaling uses the free PeerJS cloud; media and sync events are peer-to-peer (or TURN-relayed).
- The side panel must stay open for the session — closing it ends the call. You can drag its left edge to resize, and it follows you across tabs within the same window.
- Both partners must be using at least Chrome (or Edge / Brave) 114 for the side panel; reload the extension after upgrading the source folder.
- Some sites lazy-load their video element. If sync doesn't start, reload the streaming tab after the movie begins playing.

## Troubleshooting

**"The tab doesn't show up in the dropdown."**
Hit the ↻ button next to the dropdown. The extension only lists tabs whose URL matches one of the supported sites above.

**"Sync works for play/pause but not for seek."**
Streaming sites can debounce native seek events. Try seeking with a more noticeable jump (more than half a second) — tiny nudges under 0.5 s are intentionally ignored to avoid feedback loops.

**"I get a brief ad on YouTube and the partner sees the main video."**
Ad breaks on ad-supported platforms (YouTube free, Hotstar free tier) are served independently to each viewer. Sync pauses during the mismatch and re-engages when both sides are back on the main stream.

**"Netflix shows a video error code."**
Hidden Time drives Netflix through its own player API (`netflix.appContext.state.playerApp.getAPI().videoPlayer`) exactly like Teleparty, which avoids the S7361 "extension interfering with the player" error in almost all cases. If you still see it:
- Make sure [page-context.js](page-context.js) is listed under `web_accessible_resources` in [manifest.json](manifest.json) (it is, but check after a manual install).
- Reload the Netflix tab *after* the extension is loaded — Hidden Time injects the main-world helper on every page load, and needs the extension live before that happens.
- If the error persists, the Netflix player API path silently falls back to touching the raw `<video>` element, which can still trip the detector. Close and re-open the episode as a reset.

**"Prime Video on amazon.in isn't detected."**
Make sure the URL contains `/gp/video/` — the direct Prime player URLs follow that pattern. If you're on `primevideo.com` it works unconditionally.

**"My partner can't join."**
- Make sure they loaded the *same* extension folder and reloaded it from `chrome://extensions`. An old cached version will use a different peer-ID format and silently fail.
- The line under the room code tells you what step is failing: `Room not found` = the host hasn't registered yet (or the code was mistyped); `Network issue` = the PeerJS signalling server wasn't reachable from one side.
- Click **Retry** once the host is definitely online. If it keeps failing, one of you is on a network that blocks WebSocket / WebRTC (rare; usually corporate or campus Wi-Fi). Switch to a phone hotspot and try again.

## Publishing to the Chrome Web Store

To make the extension appear as a verified / trusted listing to end users, publish it on the [Chrome Web Store](https://chrome.google.com/webstore/devconsole).

### One-time setup

1. Pay the **$5 developer registration fee** (one-time, per Google account).
2. Complete Google's **identity / phone verification** for the publisher account.
3. Host the privacy policy ([PRIVACY.md](PRIVACY.md)) at a public URL — a GitHub Pages repo or a plain HTML file works. You will paste that URL in the store listing.

### Per submission

1. **Package** — zip the extension folder (skip `README.md`, `PRIVACY.md`, `.git/`, any dotfiles), keeping `manifest.json` at the root of the zip.
2. **Upload** via the developer console and fill in:
    - Title: *Hidden Time*
    - Summary (short, ≤ 132 chars) and full description
    - Category: *Entertainment*
    - Language, supported regions
    - At least **one screenshot** at 1280×800 or 640×400
    - Privacy policy URL (from the hosting step above)
    - **Single purpose statement**: "Watch movies together on streaming platforms with synced playback and peer-to-peer video/voice calling."
    - **Permission justifications** — for each permission, a one-line explanation (the [PRIVACY.md](PRIVACY.md) table has ready-made text).
3. **Submit for review**. Turnaround is typically a few hours to a few weeks for a first submission.

### What earns the "verified publisher" checkmark

Google grants the badge to publisher accounts that:
- Have passed identity verification.
- Maintain extensions in good standing (no policy violations, complaints or takedowns) for a sustained period.
- Keep an active support / contact email.

There is no form to request it — it is granted automatically once the criteria are met. The "Featured" badge, if you want that too, is an editorial pick and requires strong UX and ratings.

### What is already in place

- Manifest v3, no remote code execution (PeerJS is bundled locally in [lib/peerjs.min.js](lib/peerjs.min.js)).
- Least-privilege permissions (`tabs` + host permissions for the listed streaming sites only).
- Clear privacy policy at [PRIVACY.md](PRIVACY.md).
- Explicit, user-gated permission flow for camera and microphone — no silent prompts.

### What you still need to provide

- A publisher account and the one-time fee.
- A hosting URL for the privacy policy.
- Screenshots of the extension in use.
- A support contact email shown on the store listing.

## Files

- `manifest.json` — MV3 manifest.
- `background.js` — service worker, opens the popup window and routes messages.
- `content.js` — injected into streaming sites; wraps the `<video>` element.
- `popup.html` / `popup.css` / `popup.js` — the Hidden Time window (room, call, chat).
- `lib/peerjs.min.js` — PeerJS 1.5.4, bundled locally because MV3 forbids remote scripts.
- `icons/` — toolbar icons.
- `PRIVACY.md` — privacy policy (required by the Chrome Web Store for camera/mic use).
