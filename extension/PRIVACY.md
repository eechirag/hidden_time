# Hidden Time — Privacy Policy

_Last updated: 2026-04-23_

Hidden Time is a browser extension that lets two people watch a streaming video together and talk to each other over video, voice or text while they watch. This document explains exactly what the extension does with your data.

## What we collect

**Nothing is collected, stored, or transmitted to any server owned by the developer.**

The extension has no backend database, no analytics, no tracking pixels, no ad networks, and no usage logging.

## What leaves your device

Three categories of data leave your device while you are actively using the extension, and only while you are actively using it:

1. **Play / pause / seek events** for the streaming tab you choose. These are sent peer-to-peer over a WebRTC data channel directly to the other person in your room.
2. **Your camera and microphone streams** (only if you turn them on). These are sent peer-to-peer over WebRTC directly to the other person in your room, end-to-end encrypted by the browser (DTLS-SRTP).
3. **Text chat messages** you type in the room. Also peer-to-peer.

None of this data is recorded, copied, or sent anywhere else by the extension.

## Third-party network services

The extension relies on the following public infrastructure to establish the peer-to-peer connection. We do not own or operate these services.

| Service | Purpose | What it sees |
|---|---|---|
| **PeerJS cloud** (0.peerjs.com) | Signaling — helps two browsers find each other when you type a room code | The randomised peer IDs generated from your room code, and your public IP while a connection is being negotiated |
| **Google / Cloudflare / Twilio STUN servers** | Network-address discovery | Your public IP address while a connection is being negotiated |
| **Open Relay TURN server** | Fallback relay when direct peer-to-peer cannot be established (common on CGNAT / restricted networks) | When relaying, this server routes encrypted WebRTC media packets between the two peers. It does not hold the encryption keys and cannot see your video or audio content |

Each of these services has its own privacy policy published by its operator.

## Permissions the extension requests

| Permission | Why it is needed |
|---|---|
| `tabs` | To list your open streaming tabs in the room's "Watching" dropdown so you can pick which tab to sync |
| `host_permissions` for Netflix, YouTube, SonyLiv, Zee5, Hotstar, JioCinema, Prime Video | To inject the sync script into the streaming player and read / apply play, pause and seek events |
| Camera and microphone (requested via the browser's native prompt) | Only when you click **Call** or **Audio** — required for the video and voice call |

No other permissions are used. The extension does not read your browsing history, bookmarks, cookies, passwords, or page contents outside the supported streaming sites.

## Data retention

Because no data is collected, there is nothing to retain. Room codes and streams live only for the duration of the session and are not persisted anywhere.

## Children

The extension is not directed at children under 13. It is a generic media-viewing utility.

## Contact

Questions about this policy can be sent to the email listed on the extension's Chrome Web Store page.

## Changes

Any update to this policy will be reflected in the `Last updated` date above and ship with the next version of the extension.
