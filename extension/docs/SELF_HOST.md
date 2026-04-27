# Self-hosting signalling and TURN

The free public PeerJS cloud and Open Relay TURN are fine for casual use, but both are **rate-limited, best-effort, and shared**. For production reliability — especially if you're distributing Hidden Time to paying users, or if your calls happen across Indian CGNAT networks — self-host both.

This document covers:

1. Running your own **PeerServer** (for signalling).
2. Running your own **coturn** (for relay / TURN).
3. Wiring them into the extension via the Settings panel.

---

## 1. PeerServer (signalling)

### Deploy options

PeerServer is a tiny Node.js process. Any VPS, container host, or serverless-container platform works. Two easy paths:

**Option A — Fly.io / Railway / Render (free tier)**

```Dockerfile
FROM node:20-alpine
WORKDIR /app
RUN npm init -y && npm install peer@1.0.2
EXPOSE 9000
CMD ["npx", "peerjs", "--port", "9000", "--path", "/"]
```

Deploy, expose port 9000, put it behind the platform's TLS terminator so you get HTTPS / WSS.

**Option B — Your own VM with Caddy or Nginx**

```bash
npm install -g peer
peerjs --port 9000 --path /          # run under systemd
```

Then terminate TLS:

```nginx
server {
  listen 443 ssl http2;
  server_name signal.example.com;
  ssl_certificate     /etc/letsencrypt/live/signal.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/signal.example.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:9000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 300s;
  }
}
```

### Point the extension at it

Open Hidden Time → ⚙ Settings → fill in:

| Field | Value |
|---|---|
| Signalling host | `signal.example.com` |
| Port | `443` |
| Path | `/` |
| Secure | ☑ |

Save. The next **Create** / **Join** uses your server instead of `0.peerjs.com`.

---

## 2. coturn (TURN relay)

The free Open Relay project works globally but has no uptime SLA. For reliable media on CGNAT networks (Jio / Airtel fibre / BSNL / most Indian mobile ISPs), deploy your own.

### Recommended host: Oracle Cloud Always-Free (zero ongoing cost)

Oracle Cloud's Always-Free tier gives you 2 AMD VMs (1 OCPU, 1 GB RAM) and 4 ARM Ampere cores **forever free**, no recurring charge. A coturn relay barely uses resources, so this is the cheapest reliable path for India users.

1. Sign up at <https://cloud.oracle.com/> → choose **Mumbai** or **Hyderabad** region for low-latency India coverage.
2. Create a **VM.Standard.E2.1.Micro** (Always-Free) instance running Ubuntu 22.04 / 24.04.
3. In the VCN's **default security list**, add ingress rules:
   - TCP 443 (TURNS / TLS) — `0.0.0.0/0`
   - UDP 3478 (TURN) — `0.0.0.0/0`
   - TCP 49152-65535 + UDP 49152-65535 (relay range) — `0.0.0.0/0`
4. On the VM also open the same ports in the host firewall: `iptables -I INPUT -p udp --dport 3478 -j ACCEPT`, etc., then persist with `iptables-save`.
5. Point a DNS A record (e.g. via Cloudflare DNS, free) at the VM's public IP — coturn's TLS cert needs a hostname, not a bare IP.
6. Issue a free Let's Encrypt cert: `certbot certonly --standalone -d turn.your-domain.com`.
7. Follow the coturn config below, then plug the URL into the extension's Settings panel.

After this, your TURN cost is zero rupees per month forever and the relay sits inside India's network — much better latency for Mumbai/Bangalore peers than the EU-hosted public relays.

### Minimum coturn config

Install:
```bash
apt install coturn
```

Edit `/etc/turnserver.conf`:
```
listening-port=3478
tls-listening-port=443
fingerprint
lt-cred-mech
realm=your-domain.com
user=hiddentime:your-strong-password-here
external-ip=<your-server-public-ip>

# TLS — required for turns:// and for networks that block UDP
cert=/etc/letsencrypt/live/your-domain.com/fullchain.pem
pkey=/etc/letsencrypt/live/your-domain.com/privkey.pem

# Sensible limits
total-quota=100
user-quota=12
max-bps=0
```

Start:
```bash
systemctl enable --now coturn
```

### Point the extension at it

Settings →

| Field | Value |
|---|---|
| TURN URL | `turns:your-domain.com:443` |
| User | `hiddentime` |
| Password | `your-strong-password-here` |

The `turns:` scheme is WSS-style TURN-over-TLS on port 443, which gets through almost every firewall. If you don't have TLS termination ready, fall back to `turn:your-domain.com:3478`.

### Verify it works

In a Hidden Time call, open DevTools on the side panel (right-click inside → Inspect). Check `Show call stats` in Settings — under heavy NAT restrictions you should see `RTT` and `Loss` stabilise via your TURN server. You can also confirm via `chrome://webrtc-internals` — look for `relay/udp` or `relay/tcp` candidate pairs once the call is up.

---

## 3. Managed TURN alternatives (no deploy)

If you don't want to run your own coturn, several managed providers offer **free tiers** that comfortably cover hobby and small-group use:

- **Metered.ca** — free tier includes **50 GB/month** of TURN relay, no card required. Sign up, copy the `turns:` URL + username + credential into Settings. This is the lowest-friction free option for India and works without any infra setup.
- **Cloudflare Calls TURN** — free tier with regional coverage; account required.
- **Twilio NTS** — per-GB pricing (paid only).
- **Xirsys** — pay-as-you-go with a small free trial.

Any of them give you `urls` / `username` / `credential` triples you paste into Settings the same way.

---

## 4. What the defaults give you

Leave every Settings field blank and the extension uses:

- **Signalling**: `wss://0.peerjs.com:443/` (free, shared, best-effort)
- **STUN**: Google (`stun.l.google.com:19302` × 3), Cloudflare, Twilio
- **TURN**: Open Relay Project (free, ports 80, 443 UDP and 443 TCP)

That's enough to ship. The self-host path is an upgrade when uptime and latency start mattering.
