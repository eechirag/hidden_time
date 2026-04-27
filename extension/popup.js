// Hidden Time — popup window controller.
// Responsibilities:
//   1. PeerJS signaling (create/join room, data channel, media call).
//   2. Bridging video sync events between the chosen streaming tab and the remote peer.
//   3. Chat, mute/camera toggles.

(function () {
  "use strict";

  // ---------- ICE configuration ----------
  // Multiple STUN servers for diversity, plus a free public TURN relay.
  // The TURN relay matters on Indian ISPs — CGNAT (common on Jio, Airtel
  // fibre, BSNL) often blocks direct peer-to-peer, and without a relay the
  // call silently fails to connect. Open Relay is a free public TURN that
  // lets the call fall back to a relayed path when STUN cannot punch through.
  const ICE_SERVERS = [
    { urls: [
      "stun:stun.l.google.com:19302",
      "stun:stun1.l.google.com:19302",
      "stun:stun2.l.google.com:19302"
    ]},
    { urls: "stun:stun.cloudflare.com:3478" },
    { urls: "stun:global.stun.twilio.com:3478" },
    // Open Relay TURN — best-effort default for users who haven't configured
    // their own. India-specific note: this public TURN is rate-limited and
    // is occasionally blocked or DPI-throttled by Indian ISPs (Jio / Airtel
    // CGNAT), so pairs that can't punch through STUN may still fail to
    // connect. For reliable India connectivity, configure a turns: (TLS on
    // 443) endpoint via Settings → TURN URL — either a free Metered.ca
    // account (50 GB/mo) or a self-hosted coturn box. See docs/SELF_HOST.md.
    { urls: "turn:openrelay.metered.ca:80",            username: "openrelayproject", credential: "openrelayproject" },
    { urls: "turn:openrelay.metered.ca:443",           username: "openrelayproject", credential: "openrelayproject" },
    { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" }
  ];
  // Default PeerJS cloud config. Overridden per-session by user settings.
  const DEFAULT_SIGNAL = { host: "0.peerjs.com", port: 443, path: "/", secure: true, key: "peerjs" };

  // Outgoing media caps — keeps the call usable on a slow uplink (common on
  // Indian mobile networks and shared Wi-Fi). These are max values; WebRTC
  // scales down further automatically when congestion is detected.
  const MAX_VIDEO_BITRATE = 500_000;   // 500 kbps video
  const MAX_AUDIO_BITRATE = 32_000;    // 32 kbps opus (clear speech)
  const DRIFT_THRESHOLD_S = 1.0;       // resync when playback is off by more than this
  const TIME_SYNC_INTERVAL_MS = 5_000; // host broadcasts time-sync every 5 s

  // Capture at roughly the side-panel tile size — extra pixels get thrown away
  // by object-fit: cover and cost bandwidth for nothing.
  const VIDEO_CONSTRAINTS = {
    width:     { ideal: 480, max: 640 },
    height:    { ideal: 360, max: 480 },
    frameRate: { ideal: 24,  max: 30  }
  };

  const HEARTBEAT_INTERVAL_MS = 8_000;
  const HEARTBEAT_TIMEOUT_MS  = 18_000;
  const HEARTBEAT_RESTART_MS  = 12_000;   // try ICE restart this much before giving up
  const MAX_AUTO_RECONNECTS   = 3;

  // ---------- state ----------
  const state = {
    peer: null,
    dataConn: null,
    mediaCall: null,
    localStream: null,
    remoteStream: null,
    roomCode: null,
    isHost: false,
    watchingTabId: null,
    micEnabled: false,
    camEnabled: false,
    perms: { mic: "unknown", cam: "unknown" },
    heartbeatTimer: null,
    lastPongAt: 0,
    reconnectAttempts: 0,
    audioCtx: null,
    audioAnalyser: null,
    meterRAF: null,
    nowPlaying: null,
    nowPlayingUrl: "",
    lastAutoFollowAt: 0,
    lastAutoFollowUrl: "",
    partnerTitle: "",
    partnerUrl: "",
    micDeviceId: "",
    camDeviceId: "",
    displayName: "",
    partnerName: "",
    settings: null,                // populated from chrome.storage.local
    rttMs: 0,                      // rolling RTT from ping/pong
    rttSamples: [],
    timeSyncTimer: null,
    statsTimer: null,
    testStream: null,
    testAudioCtx: null,
    testMeterRAF: null,
    duckCtx: null,
    duckTimer: null,
    isDucked: false,
    remoteAnalyser: null,
    lastSpeakingAt: 0,
    screenStream: null,         // getDisplayMedia result while sharing
    screenAudioCtx: null,       // AudioContext for mic+screen audio mix
    previousVideoTrack: null,   // camera track saved to restore on stop
    previousAudioTrack: null,
    remoteScreenSharing: false  // partner announced { t: "screen-share", on: true }
  };

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const roomPanel = $("room-panel");
  const sessionPanel = $("session-panel");
  const btnCreate = $("btn-create");
  const btnJoin = $("btn-join");
  const joinCode = $("join-code");
  const roomCodeEl = $("room-code");
  const btnCopy = $("btn-copy");
  const btnShareLink = $("btn-share-link");
  const btnLeave = $("btn-leave");
  const btnReconnect = $("btn-reconnect");
  const btnSyncPlay = $("btn-sync-play");
  const countdownOverlay = $("countdown-overlay");
  const countdownNumber = $("countdown-number");
  const peerStatusEl = $("peer-status");
  const btnCam = $("btn-cam");
  const btnMic = $("btn-mic");
  const btnDevices = $("btn-devices");
  const devicePickerEl = $("device-picker");
  const devicePickerHostSession = $("device-picker-host");
  const devicePickerParentPre = devicePickerEl ? devicePickerEl.parentNode : null;
  const devicePickerPreAnchor = devicePickerEl ? devicePickerEl.nextSibling : null;
  const localVideo = $("local-video");
  const remoteVideo = $("remote-video");
  const tabSelect = $("tab-select");
  const btnRefreshTabs = $("btn-refresh-tabs");
  const watchStatus = $("watch-status");
  const chatLog = $("chat-log");
  const chatForm = $("chat-form");
  const chatInput = $("chat-input");
  const statusText = $("status-text");
  const connDot = $("connection-dot");
  const headerCode = $("header-code");
  const micDot = $("perm-mic-dot");
  const camDot = $("perm-cam-dot");
  const btnGrant = $("btn-grant");
  const micMeter = $("mic-meter");
  const micMeterFill = $("mic-meter-fill");
  const btnTestDevices = $("btn-test-devices");
  const setupPreview = $("setup-preview");
  const setupCamPreview = $("setup-cam-preview");
  const setupMicFill = $("setup-mic-fill");
  const accessHelp = $("access-help");
  const btnOpenSettings = $("btn-open-settings");
  const btnCheckPerms = $("btn-check-perms");
  const nowPlayingBox = $("now-playing");
  const npTitle = $("np-title");
  const partnerBanner = $("partner-banner");
  const pbTitle = $("pb-title");
  const pbPlatform = $("pb-platform");
  const pbHint = $("pb-hint");
  const btnOpenPartner = $("btn-open-partner");
  const micSelect = $("mic-select");
  const camSelect = $("cam-select");
  const displayNameInput = $("display-name");
  const localLabelEl = document.querySelector("#local-tile .tile-label");
  const remoteLabelEl = document.querySelector("#remote-tile .tile-label");
  const settingsPanel = $("settings-panel");
  const btnSettings = $("btn-settings");
  const btnSettingsClose = $("btn-settings-close");
  const btnSettingsSave = $("btn-settings-save");
  const btnSettingsReset = $("btn-settings-reset");
  const sSignalHost = $("s-signal-host");
  const sSignalPort = $("s-signal-port");
  const sSignalPath = $("s-signal-path");
  const sSignalSecure = $("s-signal-secure");
  const sTurnUrl = $("s-turn-url");
  const sTurnUser = $("s-turn-user");
  const sTurnPass = $("s-turn-pass");
  const sHostAuthority = $("s-host-authority");
  const sShowStats = $("s-show-stats");
  const statsRow = $("stats-row");
  const statRtt = $("stat-rtt");
  const statLoss = $("stat-loss");
  const statDown = $("stat-down");
  const statUp = $("stat-up");

  // ---------- helpers ----------
  function setStatus(text) { if (statusText) statusText.textContent = text; }

  // Keep the code in the header synced with state.roomCode; hidden when
  // there's no active room.
  function updateHeaderCode() {
    if (!headerCode) return;
    if (state.roomCode) {
      headerCode.textContent = state.roomCode;
      headerCode.classList.remove("hidden");
    } else {
      headerCode.textContent = "";
      headerCode.classList.add("hidden");
    }
  }
  function setPeerStatus(text, stateAttr) {
    if (!peerStatusEl) return;
    peerStatusEl.textContent = text;
    if (stateAttr) peerStatusEl.dataset.state = stateAttr;
    else delete peerStatusEl.dataset.state;
  }
  function setConn(kind) {
    if (!connDot) return;
    connDot.classList.remove("dot--idle", "dot--connecting", "dot--connected", "dot--error");
    connDot.classList.add(`dot--${kind}`);
    connDot.title = kind.charAt(0).toUpperCase() + kind.slice(1);
  }
  function appendChat(text, cls = "") {
    if (!chatLog) return;
    const div = document.createElement("div");
    div.className = `msg ${cls}`.trim();
    div.textContent = text;
    chatLog.appendChild(div);
    // Bound the DOM — long sessions otherwise accumulate thousands of nodes.
    while (chatLog.children.length > 200) chatLog.firstChild.remove();
    chatLog.scrollTop = chatLog.scrollHeight;
  }
  // Wipe the chat log — called when starting/joining a fresh party so the
  // user doesn't see leftover sync events ("Sunny set speed to 1×") from
  // a previous session.
  function clearChat() {
    if (chatLog) chatLog.replaceChildren();
  }
  // Human-readable description of a sync action — used for both the footer
  // status bar and the chat log, for either side ("You" or "Partner").
  function actionLine(who, a) {
    if (!a || !a.kind) return null;
    switch (a.kind) {
      case "play":      return `${who} played from ${fmtTime(a.time)}`;
      case "pause":     return `${who} paused at ${fmtTime(a.time)}`;
      case "seek":      return `${who} jumped to ${fmtTime(a.time)}`;
      case "rate":      return `${who} set speed to ${a.rate}×`;
      case "cued-play": return `${who} started together at ${fmtTime(a.time)}`;
      default:          return null;
    }
  }

  function fmtTime(t) {
    if (typeof t !== "number" || !isFinite(t) || t < 0) return "?";
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = Math.floor(t % 60).toString().padStart(2, "0");
    return h > 0
      ? `${h}:${m.toString().padStart(2, "0")}:${s}`
      : `${m}:${s}`;
  }

  function shortCode() {
    // 6-char code, easy to read aloud.
    const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    let s = "";
    for (let i = 0; i < 6; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
    return s;
  }
  function peerIdFor(code) { return `hiddentime-${code.toLowerCase()}`; }

  // ---------- display name ----------
  const NAME_ADJECTIVES = [
    "Cosmic", "Silent", "Lucky", "Gentle", "Witty", "Curious", "Calm",
    "Brave", "Mellow", "Sly", "Clever", "Bold", "Warm", "Quiet", "Sunny"
  ];
  const NAME_NOUNS = [
    "Panda", "Fox", "Otter", "Tiger", "Lynx", "Heron", "Koala", "Wolf",
    "Owl", "Hare", "Swan", "Crane", "Badger", "Robin", "Ferret"
  ];
  function autoName() {
    const a = NAME_ADJECTIVES[Math.floor(Math.random() * NAME_ADJECTIVES.length)];
    const n = NAME_NOUNS[Math.floor(Math.random() * NAME_NOUNS.length)];
    return `${a} ${n}`;
  }

  // Resolve the display name at session start: user-typed wins; blank falls
  // back to a random "Cosmic Panda"-style handle. Only explicit typings get
  // remembered for next time so the auto-picks don't stick.
  function resolveDisplayName() {
    const typed = (displayNameInput.value || "").trim().slice(0, 24);
    if (typed) {
      try { localStorage.setItem("ht_displayName", typed); } catch (_) {}
      return typed;
    }
    return autoName();
  }

  function updateTileLabels() {
    const youName = state.displayName || "You";
    const partnerName = state.partnerName || "Partner";
    // Mark the host with a "(Host)" suffix on the label so either side
    // can see at a glance who started the room.
    const youIsHost = !!state.isHost;
    const partnerIsHost = !state.isHost && !!state.dataConn;
    if (localLabelEl) localLabelEl.textContent = youIsHost ? `${youName} (Host)` : youName;
    if (remoteLabelEl) remoteLabelEl.textContent = partnerIsHost ? `${partnerName} (Host)` : partnerName;
  }

  // Restore the last typed name so returning users don't retype it.
  try {
    const saved = localStorage.getItem("ht_displayName");
    if (saved) displayNameInput.value = saved;
  } catch (_) {}

  // ---------- permissions ----------
  // The Permissions API gives us a live view of whether the user has already
  // allowed or blocked mic / camera. We reflect that state in the UI and gate
  // the explicit grant button accordingly. The actual prompt can only be shown
  // in response to a user gesture (the grant / call buttons), which is why
  // we never try to auto-prompt on load.
  async function refreshPermissions() {
    const names = [["mic", "microphone"], ["cam", "camera"]];
    for (const [key, apiName] of names) {
      try {
        const status = await navigator.permissions.query({ name: apiName });
        state.perms[key] = status.state; // "granted" | "prompt" | "denied"
        status.onchange = () => {
          state.perms[key] = status.state;
          updatePermissionUI();
          refreshDevices();
        };
      } catch (_) {
        state.perms[key] = "unknown";
      }
    }
    updatePermissionUI();
    // Re-enumerate now — device labels only become readable after a
    // permission has been granted at least once.
    refreshDevices();
  }

  function updatePermissionUI() {
    micDot.dataset.state = state.perms.mic;
    camDot.dataset.state = state.perms.cam;
    micDot.title = `Microphone: ${state.perms.mic}`;
    camDot.title = `Camera: ${state.perms.cam}`;

    const bothGranted = state.perms.mic === "granted" && state.perms.cam === "granted";
    const anyDenied   = state.perms.mic === "denied"  || state.perms.cam === "denied";
    if (bothGranted) {
      btnGrant.textContent = "Access granted";
      btnGrant.disabled = true;
    } else if (anyDenied) {
      btnGrant.textContent = "Unblock";
      btnGrant.disabled = false;
    } else {
      btnGrant.textContent = "Grant access";
      btnGrant.disabled = false;
    }
    // Reveal the inline help panel whenever something is blocked; hide it
    // once the user has unblocked / granted.
    if (accessHelp) {
      if (anyDenied) accessHelp.classList.remove("hidden");
      else accessHelp.classList.add("hidden");
    }
  }

  // Helper used by multiple buttons to open Chrome's per-extension
  // site-settings page. Returns true on success.
  async function openChromeSiteSettings() {
    const siteUrl = `chrome-extension://${chrome.runtime.id}`;
    const settingsUrl = `chrome://settings/content/siteDetails?site=${encodeURIComponent(siteUrl)}`;
    try {
      await chrome.tabs.create({ url: settingsUrl, active: true });
      return true;
    } catch (_) {
      try {
        // Fallback: the camera settings page lists every origin with explicit
        // permissions — the user can scroll to find Hidden Time.
        await chrome.tabs.create({ url: "chrome://settings/content/camera", active: true });
        return true;
      } catch (_) {
        return false;
      }
    }
  }

  async function requestPermissions() {
    // Ask for both at once so the user sees a single combined prompt.
    // We stop the tracks immediately — this call is only to obtain consent,
    // the real stream is created when the user starts a call.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: VIDEO_CONSTRAINTS
      });
      stream.getTracks().forEach((t) => t.stop());
      setStatus("Camera and microphone allowed.");
    } catch (e) {
      if (state.perms.mic === "denied" || state.perms.cam === "denied") {
        // Fall through to media error handler for specific guidance.
      }
      handleMediaError(e);
    } finally {
      await refreshPermissions();
    }
  }

  function handleMediaError(e) {
    const name = e && e.name;
    let msg;
    switch (name) {
      case "NotAllowedError":
      case "SecurityError":
        msg = "Camera/mic blocked. Click \"Open Chrome settings\" above to unblock Hidden Time.";
        break;
      case "NotFoundError":
      case "OverconstrainedError":
        msg = "No camera or microphone detected on this device.";
        break;
      case "NotReadableError":
        msg = "Another app is using your camera or microphone. Close it and try again.";
        break;
      case "AbortError":
        msg = "Camera/mic request was cancelled.";
        break;
      default:
        msg = `Media error: ${(e && e.message) || name || "unknown"}`;
    }
    setStatus(msg);
  }

  // ---------- settings ----------
  // User-overrideable configuration. Everything has a sane default so the
  // extension works out of the box without opening the settings panel.
  const DEFAULT_SETTINGS = {
    signalHost: "",   signalPort: 0, signalPath: "", signalSecure: true,
    turnUrl: "",      turnUser: "",  turnPass: "",
    hostAuthority: false,
    showStats: false
  };

  // Defensive getter: if the `storage` permission isn't active yet (e.g. the
  // user hasn't reloaded the extension since this permission was added), fall
  // back to defaults instead of throwing a TypeError on chrome.storage.local.
  function hasStorage() {
    return typeof chrome !== "undefined"
        && chrome.storage
        && chrome.storage.local;
  }
  function loadSettings() {
    return new Promise((resolve) => {
      if (!hasStorage()) { resolve(Object.assign({}, DEFAULT_SETTINGS)); return; }
      chrome.storage.local.get("ht_settings", ({ ht_settings }) => {
        resolve(Object.assign({}, DEFAULT_SETTINGS, ht_settings || {}));
      });
    });
  }
  function saveSettings(settings) {
    return new Promise((resolve) => {
      if (!hasStorage()) { resolve(); return; }
      chrome.storage.local.set({ ht_settings: settings }, resolve);
    });
  }

  async function initSettings() {
    state.settings = await loadSettings();
    hydrateSettingsForm();
    applyUISettings();
  }
  function hydrateSettingsForm() {
    const s = state.settings;
    // Show the active defaults as real values so the user can see what's
    // actually in use, and can tweak rather than type from scratch.
    sSignalHost.value = s.signalHost || DEFAULT_SIGNAL.host;
    sSignalPort.value = s.signalPort || DEFAULT_SIGNAL.port;
    sSignalPath.value = s.signalPath || DEFAULT_SIGNAL.path;
    sSignalSecure.checked = s.signalSecure !== false;
    sTurnUrl.value  = s.turnUrl  || "";
    sTurnUser.value = s.turnUser || "";
    sTurnPass.value = s.turnPass || "";
    sHostAuthority.checked = !!s.hostAuthority;
    sShowStats.checked = !!s.showStats;
  }
  function readSettingsForm() {
    return {
      signalHost: sSignalHost.value.trim(),
      signalPort: parseInt(sSignalPort.value, 10) || 0,
      signalPath: sSignalPath.value.trim(),
      signalSecure: sSignalSecure.checked,
      turnUrl: sTurnUrl.value.trim(),
      turnUser: sTurnUser.value.trim(),
      turnPass: sTurnPass.value,
      hostAuthority: sHostAuthority.checked,
      showStats: sShowStats.checked
    };
  }
  function applyUISettings() {
    if (state.settings.showStats) statsRow.classList.remove("hidden");
    else statsRow.classList.add("hidden");
  }

  // Build Peer() options fresh each time we create a peer — so edits to
  // the Settings panel take effect on the next Create/Join without reload.
  function buildPeerOptions() {
    const s = state.settings || DEFAULT_SETTINGS;
    const hasCustomSignal = s.signalHost && s.signalHost.length > 0;
    const base = hasCustomSignal
      ? {
          host:   s.signalHost,
          port:   s.signalPort || (s.signalSecure ? 443 : 80),
          path:   s.signalPath || "/",
          secure: s.signalSecure !== false,
          key:    "peerjs"
        }
      : DEFAULT_SIGNAL;

    // Build ICE list with user-configured TURN FIRST. Browser ICE iterates
    // candidates in order; on Indian CGNAT (Jio/Airtel), a free Metered.ca
    // or self-hosted coturn `turns:443` entry is dramatically more reliable
    // than the public Open Relay default, so we want it tried before the
    // shared fallback eats the connection budget.
    const ice = [];
    // STUN entries — keep these at the top, they're cheap.
    for (const e of ICE_SERVERS) {
      if (typeof e.urls === "string" ? /^stun:/.test(e.urls) : (e.urls || []).some((u) => /^stun:/.test(u))) {
        ice.push(e);
      }
    }
    // User TURN (Metered.ca free tier or self-hosted coturn) — highest priority.
    if (s.turnUrl) {
      ice.push({ urls: s.turnUrl, username: s.turnUser || "", credential: s.turnPass || "" });
    }
    // Public Open Relay TURN — last-resort fallback only when no user TURN
    // is configured. Frequently blocked / rate-limited on Indian ISPs.
    if (!s.turnUrl) {
      for (const e of ICE_SERVERS) {
        if (typeof e.urls === "string" ? /^turns?:/.test(e.urls) : false) ice.push(e);
      }
    }
    return Object.assign({ debug: 1, config: { iceServers: ice } }, base);
  }

  btnSettings.addEventListener("click", () => {
    // Toggle: a second click on the gear closes Settings rather than being a
    // no-op. More discoverable than hunting for "Done".
    if (!settingsPanel.classList.contains("hidden")) {
      closeSettings();
      return;
    }
    hydrateSettingsForm();
    settingsPanel.classList.remove("hidden");
    roomPanel.classList.add("hidden");
    sessionPanel.classList.add("hidden");
    document.body.classList.add("settings-open");
  });
  btnSettingsClose.addEventListener("click", closeSettings);
  async function closeSettings() {
    settingsPanel.classList.add("hidden");
    document.body.classList.remove("settings-open");
    if (state.roomCode) sessionPanel.classList.remove("hidden");
    else roomPanel.classList.remove("hidden");
  }
  btnSettingsSave.addEventListener("click", async () => {
    state.settings = readSettingsForm();
    await saveSettings(state.settings);
    applyUISettings();
    setStatus("Settings saved. New values apply on the next Create / Join.");
    closeSettings();
  });
  btnSettingsReset.addEventListener("click", async () => {
    state.settings = Object.assign({}, DEFAULT_SETTINGS);
    hydrateSettingsForm();
    await saveSettings(state.settings);
    applyUISettings();
    setStatus("Settings reset to defaults.");
  });

  // ---------- device picker ----------
  // The dropdowns show "System default" until permission is granted; browsers
  // hide the real device labels to prevent fingerprinting until the user has
  // authorised camera/mic. refreshDevices re-runs after permission changes and
  // on hardware hot-plug so labels appear and disappear automatically.
  async function refreshDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    let devices;
    try { devices = await navigator.mediaDevices.enumerateDevices(); }
    catch (_) { return; }
    populateDeviceSelect(micSelect, devices.filter((d) => d.kind === "audioinput"),  "Microphone", state.micDeviceId);
    populateDeviceSelect(camSelect, devices.filter((d) => d.kind === "videoinput"),  "Camera",     state.camDeviceId);
  }

  function populateDeviceSelect(select, devices, fallbackLabel, currentValue) {
    const want = currentValue || select.value || "";
    select.innerHTML = "";

    // Chrome / Edge list a virtual "default" entry whose label is
    // "Default - <physical device name>". Surface that mapping so the user
    // can see what "System default" actually resolves to right now — it
    // might be the laptop mic, their AirPods, their USB interface, etc.
    const defaultEntry = devices.find((d) => d.deviceId === "default");
    const defaultLabel = defaultEntry && defaultEntry.label
      ? defaultEntry.label.replace(/^Default\s*-\s*/i, "").trim()
      : "";

    const def = document.createElement("option");
    def.value = "";
    def.textContent = defaultLabel
      ? `System default — ${defaultLabel}`
      : "System default";
    select.appendChild(def);

    for (const d of devices) {
      // Skip Chrome's virtual default / communications entries — the info
      // they carry is already folded into the "System default" option above
      // and duplicating them just clutters the list.
      if (d.deviceId === "default" || d.deviceId === "communications") continue;
      const opt = document.createElement("option");
      opt.value = d.deviceId;
      opt.textContent = d.label || `${fallbackLabel} ${d.deviceId.slice(0, 6)}`;
      select.appendChild(opt);
    }

    // Re-apply the previously-chosen value if it still exists; otherwise
    // fall back to System default silently.
    const hasValue = Array.from(select.options).some((o) => o.value === want);
    select.value = hasValue ? want : "";
  }

  // When the user picks a different device, flip the track under the hood
  // without tearing down the whole call. Uses RTCRtpSender.replaceTrack so
  // the peer sees a smooth switch, no SDP renegotiation, no black frame.
  async function switchDevice(kind) {
    if (!state.localStream) return; // applied on next getUserMedia
    const deviceId = kind === "video" ? state.camDeviceId : state.micDeviceId;
    const constraints = kind === "video"
      ? { video: Object.assign({}, VIDEO_CONSTRAINTS, deviceId ? { deviceId: { exact: deviceId } } : {}) }
      : { audio: deviceId ? { deviceId: { exact: deviceId } } : true };
    let fresh;
    try { fresh = await navigator.mediaDevices.getUserMedia(constraints); }
    catch (e) { handleMediaError(e); return; }

    const newTrack = kind === "video" ? fresh.getVideoTracks()[0] : fresh.getAudioTracks()[0];
    const oldTracks = kind === "video" ? state.localStream.getVideoTracks() : state.localStream.getAudioTracks();
    for (const t of oldTracks) { state.localStream.removeTrack(t); t.stop(); }
    if (newTrack) {
      newTrack.enabled = kind === "video" ? state.camEnabled : state.micEnabled;
      state.localStream.addTrack(newTrack);
    }
    localVideo.srcObject = state.localStream;

    if (state.mediaCall && state.mediaCall.peerConnection && newTrack) {
      const sender = state.mediaCall.peerConnection
        .getSenders()
        .find((s) => s.track && s.track.kind === newTrack.kind);
      if (sender) { try { await sender.replaceTrack(newTrack); } catch (e) { console.warn(e); } }
    }
    if (kind === "audio" && state.micEnabled) startMicMeter();
  }

  micSelect.addEventListener("change", () => {
    state.micDeviceId = micSelect.value;
    switchDevice("audio");
  });
  camSelect.addEventListener("change", () => {
    state.camDeviceId = camSelect.value;
    switchDevice("video");
  });

  // Move the one device-picker between "above the room panel" (pre-join) and
  // "inline below the controls" (in-session). Using a single element avoids
  // having to sync two sets of selects.
  function mountDevicePickerForSession() {
    if (devicePickerEl && devicePickerHostSession) {
      devicePickerHostSession.appendChild(devicePickerEl);
    }
  }
  function mountDevicePickerForPreJoin() {
    if (!devicePickerEl || !devicePickerParentPre) return;
    if (devicePickerPreAnchor && devicePickerPreAnchor.parentNode === devicePickerParentPre) {
      devicePickerParentPre.insertBefore(devicePickerEl, devicePickerPreAnchor);
    } else {
      devicePickerParentPre.appendChild(devicePickerEl);
    }
    document.body.classList.remove("devices-open");
  }

  if (btnDevices) {
    btnDevices.addEventListener("click", () => {
      document.body.classList.toggle("devices-open");
      btnDevices.classList.toggle("active", document.body.classList.contains("devices-open"));
      // Refresh the list in case a USB mic/cam was plugged in since session start.
      refreshDevices();
    });
  }

  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener("devicechange", refreshDevices);
  }

  // ---------- peer lifecycle ----------
  function ensurePeer(id) {
    if (state.peer && !state.peer.destroyed) return state.peer;

    // Uses the free PeerJS cloud signaling server. No server setup needed.
    const peer = new Peer(id, buildPeerOptions());
    state.peer = peer;

    peer.on("open", (openId) => {
      setStatus(`Signed in as ${openId}`);
      if (state.isHost) setPeerStatus("Room ready — waiting for partner to join…");
      else              setPeerStatus("Reaching partner…");
    });
    peer.on("error", (err) => {
      console.error(err);

      // Host picked a code that's already live on the public signalling
      // server. Regenerate a fresh code and rebuild the peer — the user
      // never has to know this happened.
      if (err.type === "unavailable-id" && state.isHost) {
        const fresh = shortCode();
        state.roomCode = fresh;
        roomCodeEl.textContent = fresh;
        updateHeaderCode();
        setStatus("Picked a new room code…");
        try { peer.destroy(); } catch (_) {}
        state.peer = null;
        ensurePeer(peerIdFor(fresh));
        return;
      }

      // Guest tried to reach a room that doesn't exist — probably a typo,
      // or the host hasn't opened Hidden Time yet.
      if (err.type === "peer-unavailable") {
        setStatus(`Couldn't find room "${state.roomCode}". Ask your partner to click Create room first, then try Join again.`);
        setPeerStatus("Room not found — press Retry when your partner is online.", "error");
        setConn("error");
        return;
      }

      if (err.type === "network" || err.type === "server-error" || err.type === "socket-error") {
        setStatus(`Network issue (${err.type}). Check your internet and try again.`);
        setPeerStatus(`Network issue (${err.type}) — press Retry.`, "error");
        setConn("error");
        return;
      }

      setStatus(`Peer error: ${err.type || err.message}`);
      setPeerStatus(`Error: ${err.type || err.message}`, "error");
      setConn("error");
    });
    peer.on("connection", (conn) => {
      attachDataConn(conn);
    });
    peer.on("call", async (call) => {
      // Auto-enable mic when the partner dials us in and we've already
      // granted mic permission. Without this, the caller would hear silence
      // because our track.enabled is still false by default — the most
      // confusing version of "one-way audio". Camera stays off (more
      // privacy-sensitive — user clicks Cam to share video).
      const autoUnmute = state.perms.mic === "granted" && !state.micEnabled;
      if (autoUnmute) state.micEnabled = true;

      let stream = state.localStream;
      if (!stream) {
        const granted = state.perms.mic === "granted" || state.perms.cam === "granted";
        if (granted) {
          try { stream = await ensureLocalMedia(); } catch (_) { stream = null; }
        }
      }
      if (stream) {
        stream.getVideoTracks().forEach((t) => { t.enabled = state.camEnabled; });
        stream.getAudioTracks().forEach((t) => { t.enabled = state.micEnabled; });
        call.answer(stream);
        if (autoUnmute) {
          startMicMeter();
          updateCamMicUI();
          appendChat("Auto-answered with mic on.", "sys");
        }
      } else {
        call.answer();
      }
      attachMediaCall(call);
    });
    peer.on("disconnected", () => {
      setStatus("Signaling disconnected — retrying…");
      setConn("connecting");
      try { peer.reconnect(); } catch (_) {}
    });

    return peer;
  }

  function attachDataConn(conn) {
    // A new data-connection is arriving (partner is rejoining, or we just
    // initiated a fresh one). Close any previous conn cleanly so we never
    // have two half-alive channels talking over each other.
    if (state.dataConn && state.dataConn !== conn) {
      try { state.dataConn.close(); } catch (_) {}
    }
    state.dataConn = conn;
    setConn("connecting");

    conn.on("open", () => {
      setConn("connected");
      // Introduce ourselves first; the partner's tile label stays "Partner"
      // until we receive their "hello" and populate state.partnerName.
      sendData({ t: "hello", name: state.displayName });
      // Tell the partner what we're watching right now (if anything), so
      // their "Partner is watching…" banner appears instantly rather than on
      // the next meta change. Both sides push their own now-playing now.
      if (state.nowPlayingUrl) {
        sendData({ t: "now-playing", title: state.nowPlaying, url: state.nowPlayingUrl });
      }
      const peerLabel = conn.peer.replace("hiddentime-", "").toUpperCase();
      setStatus(`Connected to ${peerLabel}`);
      setPeerStatus(`Connected — say hi to ${state.partnerName || "your partner"}.`, "connected");
      appendChat("Peer connected.", "sys");
      state.reconnectAttempts = 0;
      startHeartbeat();
      startTimeSyncLoop();
      startStatsLoop();
      requestLocalStateAndBroadcast();
      updateSyncPlayVisibility();
    });
    conn.on("data", onDataMessage);
    conn.on("close", () => {
      setConn("idle");
      const who = state.partnerName || (state.isHost ? "Partner" : "Host");
      if (state.isHost) {
        setStatus(`${who} left. Room ${state.roomCode} is still open — they can rejoin any time.`);
        appendChat(`${who} left. Share the code again to let them rejoin.`, "sys");
      } else {
        setStatus(`Disconnected from ${who}.`);
        appendChat(`Lost connection to ${who}.`, "sys");
      }
      state.dataConn = null;
      stopHeartbeat();
      stopTimeSyncLoop();
      stopStatsLoop();
      scheduleAutoReconnect();
      updateSyncPlayVisibility();
    });
    conn.on("error", (err) => {
      console.error(err);
      setStatus(`Data channel error: ${err.message}`);
      setPeerStatus(`Connection error: ${err.type || err.message}`, "error");
    });
  }

  // What to do when the data channel drops:
  //   * Host — the room stays alive. Keep the peer registered under the same
  //     room code so the partner can rejoin whenever they're ready. No retry
  //     storm; we just wait for the next incoming connection.
  //   * Guest — the host might still be there, just a network blip. Try to
  //     reach them up to MAX_AUTO_RECONNECTS times with linear back-off.
  //     After that, ask the user to press Retry manually.
  // Clicking Leave clears roomCode, so a deliberate teardown never triggers
  // any of this.
  function scheduleAutoReconnect() {
    if (!state.roomCode) return;

    if (state.isHost) {
      setPeerStatus(`Partner left — they can rejoin with code ${state.roomCode}.`);
      setConn("connecting");
      return;
    }

    if (state.reconnectAttempts >= MAX_AUTO_RECONNECTS) {
      setPeerStatus("Peer disconnected — press Retry to reconnect.", "error");
      return;
    }
    state.reconnectAttempts += 1;
    // Exponential backoff capped at 12 s — protects the signaller from a
    // retry storm when the network is genuinely down (e.g. metro / lift)
    // while still recovering quickly from a brief blip. If the browser
    // reports we're offline, wait until it comes back online instead of
    // burning attempts against a cold radio.
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    if (offline) {
      setPeerStatus("Offline — will reconnect when you're back online.", "error");
      return;
    }
    const backoffMs = Math.min(12_000, 1_500 * Math.pow(2, state.reconnectAttempts - 1));
    setPeerStatus(`Reconnecting (attempt ${state.reconnectAttempts}/${MAX_AUTO_RECONNECTS})…`);
    setTimeout(() => {
      if (state.roomCode && !state.dataConn) btnReconnect.click();
    }, backoffMs);
  }

  // Browser-level online/offline tells us about Wi-Fi handoffs and laptop
  // sleeps faster than the heartbeat. When we come back online and have
  // an active room but no data channel, kick a reconnect immediately
  // instead of waiting for the next backoff tick.
  if (typeof window !== "undefined") {
    window.addEventListener("offline", () => {
      if (state.roomCode) setPeerStatus("Offline — waiting for network…", "error");
    });
    window.addEventListener("online", () => {
      if (state.roomCode && !state.dataConn) {
        state.reconnectAttempts = 0;   // fresh budget after the actual outage
        setPeerStatus("Back online — reconnecting…");
        try { btnReconnect.click(); } catch (_) {}
      } else if (state.roomCode) {
        // Channel survived the dip — kick ICE in case candidates went stale.
        attemptIceRestart();
      }
    });
  }

  // -------- Audio ducking --------
  // Monitors both the local mic and the incoming remote audio; when either
  // is above the speaking threshold we send a "duck" command to the watched
  // tab's content script, which lowers the movie's volume. When both sides
  // have been quiet for 800 ms we restore the original volume. Makes voice
  // audible without having to mash the volume slider during dialogue.
  const DUCK_THRESHOLD = 24;       // RMS on 0..255 scale — speech sits ~30+
  const DUCK_TAIL_MS   = 800;       // how long after silence before we un-duck
  const DUCK_FACTOR    = 0.18;      // fraction of original volume while ducked
  const DUCK_POLL_MS   = 100;

  function startDucking() {
    stopDucking();
    if (!state.remoteStream) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      const src = ctx.createMediaStreamSource(state.remoteStream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.6;
      src.connect(analyser);
      state.duckCtx = ctx;
      state.remoteAnalyser = analyser;

      const remoteBuf = new Uint8Array(analyser.frequencyBinCount);
      state.duckTimer = setInterval(() => {
        // Local mic — reuse the meter's analyser when the user has mic on.
        let localLevel = 0;
        if (state.audioAnalyser && state.micEnabled) {
          const localBuf = new Uint8Array(state.audioAnalyser.frequencyBinCount);
          state.audioAnalyser.getByteFrequencyData(localBuf);
          let sum = 0;
          for (let i = 0; i < localBuf.length; i++) sum += localBuf[i] * localBuf[i];
          localLevel = Math.sqrt(sum / localBuf.length);
        }
        // Remote audio.
        analyser.getByteFrequencyData(remoteBuf);
        let sum2 = 0;
        for (let i = 0; i < remoteBuf.length; i++) sum2 += remoteBuf[i] * remoteBuf[i];
        const remoteLevel = Math.sqrt(sum2 / remoteBuf.length);

        const someoneTalking = localLevel > DUCK_THRESHOLD || remoteLevel > DUCK_THRESHOLD;
        if (someoneTalking) {
          state.lastSpeakingAt = Date.now();
          if (!state.isDucked) {
            state.isDucked = true;
            forwardToContent({ kind: "duck", factor: DUCK_FACTOR });
          }
        } else if (state.isDucked && Date.now() - state.lastSpeakingAt > DUCK_TAIL_MS) {
          state.isDucked = false;
          forwardToContent({ kind: "unduck" });
        }
      }, DUCK_POLL_MS);
    } catch (e) {
      console.warn("Audio ducking setup failed:", e);
    }
  }

  function stopDucking() {
    if (state.duckTimer) { clearInterval(state.duckTimer); state.duckTimer = null; }
    if (state.duckCtx)   { try { state.duckCtx.close(); } catch (_) {} state.duckCtx = null; }
    state.remoteAnalyser = null;
    if (state.isDucked) {
      state.isDucked = false;
      forwardToContent({ kind: "unduck" });
    }
  }

  function attachMediaCall(call) {
    state.mediaCall = call;
    call.on("stream", (remote) => {
      state.remoteStream = remote;
      remoteVideo.srcObject = remote;
      startDucking();
      // Chrome's autoplay policy can block unmuted playback even with the
      // `autoplay` attribute when the MediaStream is attached programmatically.
      // Explicitly play(); if it rejects, the global click handler below
      // resumes it the next time the user clicks inside the side panel.
      remoteVideo.play().catch((err) => {
        console.warn("Remote audio blocked by autoplay policy:", err);
        setStatus("Click anywhere in the panel to start your partner's audio.");
      });
    });
    call.on("close", () => {
      state.mediaCall = null;
      state.remoteStream = null;
      remoteVideo.srcObject = null;
      stopDucking();
    });
    call.on("error", (err) => {
      console.error(err);
      setStatus(`Call error: ${err.message}`);
    });
    // Let PeerJS finish SDP negotiation, then cap outgoing bitrate so the
    // call stays responsive on slow uplinks instead of saturating the pipe.
    setTimeout(() => capOutgoingBitrate(call), 600);
  }

  function capOutgoingBitrate(call) {
    const pc = call && call.peerConnection;
    if (!pc || typeof pc.getSenders !== "function") return;
    for (const sender of pc.getSenders()) {
      if (!sender.track) continue;
      const params = sender.getParameters();
      if (sender.track.kind === "audio") {
        if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
        params.encodings[0].maxBitrate = MAX_AUDIO_BITRATE;
      } else if (sender.track.kind === "video") {
        // Simulcast-ready encoding config. Even for a single recipient it
        // gives WebRTC's congestion controller multiple resolution/bitrate
        // rungs to fall back to under load instead of just dropping frames
        // at the top rung. When the SDP doesn't include simulcast (PeerJS
        // doesn't munge it), only the first entry is used — still correct.
        params.encodings = [
          { rid: "h", maxBitrate: MAX_VIDEO_BITRATE,        scaleResolutionDownBy: 1 },
          { rid: "m", maxBitrate: Math.round(MAX_VIDEO_BITRATE / 2), scaleResolutionDownBy: 2 },
          { rid: "l", maxBitrate: Math.round(MAX_VIDEO_BITRATE / 5), scaleResolutionDownBy: 4 }
        ];
      }
      sender.setParameters(params).catch((e) => console.warn("setParameters:", e));
    }
  }

  // Heartbeat — a silent data channel can keep reporting "open" long after
  // the underlying transport has died (mobile sleep, Wi-Fi handoff). A
  // ping/pong every 10 s lets us surface stale connections immediately.
  function startHeartbeat() {
    stopHeartbeat();
    state.lastPongAt = Date.now();
    state.iceRestartedAt = 0;
    state.heartbeatTimer = setInterval(() => {
      if (!state.dataConn || !state.dataConn.open) return;
      sendData({ t: "ping", at: Date.now() });
      const sinceLastPong = Date.now() - state.lastPongAt;
      // Mid-stall: attempt an ICE restart on the media PC. This kicks the
      // browser to renegotiate candidate pairs, which often recovers from
      // a Wi-Fi handoff or transient TURN flap without the user pressing
      // Retry. Throttled so we don't restart more than once per 30 s.
      if (sinceLastPong > HEARTBEAT_RESTART_MS &&
          Date.now() - state.iceRestartedAt > 30_000) {
        attemptIceRestart();
        state.iceRestartedAt = Date.now();
        setPeerStatus("Connection slow — attempting to recover…", "error");
      }
      if (sinceLastPong > HEARTBEAT_TIMEOUT_MS) {
        setPeerStatus("Connection idle — press Retry if it stays this way.", "error");
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  // Force WebRTC to refresh ICE candidates without tearing down the call.
  // Cheap recovery for transient network changes; harmless when the call is
  // already healthy because the PC will just keep the existing pair.
  function attemptIceRestart() {
    try {
      const pc = state.mediaCall && state.mediaCall.peerConnection;
      if (pc && typeof pc.restartIce === "function") pc.restartIce();
    } catch (_) {}
  }
  function stopHeartbeat() {
    if (state.heartbeatTimer) { clearInterval(state.heartbeatTimer); state.heartbeatTimer = null; }
  }

  // Host-only: every TIME_SYNC_INTERVAL_MS query the watched tab's current
  // playback state and broadcast it to the peer as a drift-sync. The peer's
  // content script nudges the playhead only when drift > 1 s so the user
  // never sees a visible "catch up" on a good network.
  function startTimeSyncLoop() {
    stopTimeSyncLoop();
    if (!state.isHost) return;
    state.timeSyncTimer = setInterval(broadcastTimeSync, TIME_SYNC_INTERVAL_MS);
  }
  function stopTimeSyncLoop() {
    if (state.timeSyncTimer) { clearInterval(state.timeSyncTimer); state.timeSyncTimer = null; }
  }
  function broadcastTimeSync() {
    if (!state.isHost || !state.dataConn || !state.dataConn.open) return;
    if (!state.watchingTabId) return;
    // Skip when the channel is congested — sendData already drops low-
    // priority traffic, but we shouldn't even bother probing the tab when
    // the result will be discarded. This also prevents the local
    // chrome.tabs.sendMessage from stacking up callbacks during a stall.
    if (dataBufferedAmount() > DATA_BUFFER_BUSY) return;
    chrome.tabs.sendMessage(state.watchingTabId, { kind: "state-request" }, (resp) => {
      if (chrome.runtime.lastError) return;
      if (!resp || !resp.ok || !resp.state) return;
      sendData({
        t: "drift-sync",
        action: {
          time:   resp.state.time,
          rate:   resp.state.rate,
          paused: resp.state.paused,
          at:     Date.now()
        }
      });
    });
  }

  // ---------- QoS stats ----------
  // RTCPeerConnection.getStats polled every 3 s. Only rendered when the user
  // checked "Show call stats" in Settings; otherwise this is a no-op.
  function startStatsLoop() {
    stopStatsLoop();
    if (!state.settings || !state.settings.showStats) return;
    let prevBytesIn = 0, prevBytesOut = 0, prevAt = 0;
    state.statsTimer = setInterval(async () => {
      if (!state.mediaCall || !state.mediaCall.peerConnection) return;
      let bytesIn = 0, bytesOut = 0, packetsLost = 0, packetsRecv = 0, rtt = 0;
      try {
        const stats = await state.mediaCall.peerConnection.getStats();
        stats.forEach((r) => {
          if (r.type === "inbound-rtp" && (r.kind === "video" || r.kind === "audio")) {
            bytesIn += r.bytesReceived || 0;
            packetsLost += r.packetsLost || 0;
            packetsRecv += r.packetsReceived || 0;
          } else if (r.type === "outbound-rtp") {
            bytesOut += r.bytesSent || 0;
          } else if (r.type === "candidate-pair" && r.state === "succeeded" && r.currentRoundTripTime) {
            rtt = Math.round(r.currentRoundTripTime * 1000);
          }
        });
      } catch (_) { return; }

      const now = Date.now();
      if (prevAt) {
        const dtSec = (now - prevAt) / 1000;
        const kbpsDown = Math.round((bytesIn  - prevBytesIn)  * 8 / 1000 / dtSec);
        const kbpsUp   = Math.round((bytesOut - prevBytesOut) * 8 / 1000 / dtSec);
        const lossPct  = packetsRecv ? ((packetsLost / (packetsLost + packetsRecv)) * 100).toFixed(1) : "0.0";
        if (statRtt)  statRtt.textContent  = `${rtt || state.rttMs || 0} ms`;
        if (statLoss) statLoss.textContent = `${lossPct}%`;
        if (statDown) statDown.textContent = `${kbpsDown} kbps`;
        if (statUp)   statUp.textContent   = `${kbpsUp} kbps`;
      }
      prevAt = now; prevBytesIn = bytesIn; prevBytesOut = bytesOut;
    }, 3000);
  }
  function stopStatsLoop() {
    if (state.statsTimer) { clearInterval(state.statsTimer); state.statsTimer = null; }
  }

  // ---------- auto-rejoin ----------
  // When we create/join a room we snapshot it to session storage; if the
  // side panel is reopened within the same browser session, we offer to
  // resume. session storage is wiped when Chrome shuts down, so this
  // won't try to reach a code that's definitely stale.
  function hasSessionStorage() {
    return typeof chrome !== "undefined"
        && chrome.storage
        && chrome.storage.session;
  }
  function saveSession() {
    if (!state.roomCode || !hasSessionStorage()) return;
    try {
      chrome.storage.session.set({
        ht_lastSession: {
          code: state.roomCode,
          isHost: state.isHost,
          displayName: state.displayName,
          at: Date.now()
        }
      });
    } catch (_) {}
  }
  function clearSession() {
    if (!hasSessionStorage()) return;
    try { chrome.storage.session.remove("ht_lastSession"); } catch (_) {}
  }
  async function maybeOfferResume() {
    if (!hasSessionStorage()) return;
    try {
      const { ht_lastSession } = await chrome.storage.session.get("ht_lastSession");
      if (!ht_lastSession) return;
      if (Date.now() - ht_lastSession.at > 5 * 60 * 1000) {
        chrome.storage.session.remove("ht_lastSession");
        return;
      }
      const code = ht_lastSession.code;
      const role = ht_lastSession.isHost ? "reopen" : "rejoin";
      setStatus(`Previous session ${code} found — click ${role === "reopen" ? "Create room" : "Join"} with this code to resume.`);
      if (!ht_lastSession.isHost) joinCode.value = code;
      if (ht_lastSession.displayName) displayNameInput.value = ht_lastSession.displayName;
    } catch (_) {}
  }

  // ---------- messaging over the data channel ----------
  // Backpressure threshold — when the SCTP send queue holds more than this
  // many bytes, the channel is congested. Pushing more low-priority traffic
  // (drift-sync, ping/pong) on top just deepens the backlog. User-driven
  // events (chat, play/pause/seek) still go through unconditionally because
  // dropping those would feel broken.
  const DATA_BUFFER_BUSY = 64 * 1024;   // 64 KB
  const LOW_PRIORITY = new Set(["drift-sync", "ping", "pong", "need-time-sync"]);

  function dataBufferedAmount() {
    try {
      const ch = state.dataConn && state.dataConn.dataChannel;
      return ch ? (ch.bufferedAmount || 0) : 0;
    } catch (_) { return 0; }
  }

  function sendData(obj) {
    if (!state.dataConn || !state.dataConn.open) return;
    // Drop low-priority traffic when the channel is congested. This keeps
    // sync / chat instant on a flaky network instead of getting buried
    // behind 30 stale drift-sync packets that didn't fit on the wire.
    if (obj && LOW_PRIORITY.has(obj.t) && dataBufferedAmount() > DATA_BUFFER_BUSY) {
      return;
    }
    try { state.dataConn.send(obj); } catch (e) { console.error(e); }
  }

  function onDataMessage(msg) {
    if (!msg || !msg.t) return;
    switch (msg.t) {
      case "ping":
        // Echo the sender's timestamp so they can compute RTT; reset our own
        // freshness clock so we don't fire the "connection idle" warning.
        sendData({ t: "pong", at: msg.at });
        state.lastPongAt = Date.now();
        break;
      case "pong": {
        state.lastPongAt = Date.now();
        if (typeof msg.at === "number") {
          const rtt = Date.now() - msg.at;
          state.rttSamples.push(rtt);
          if (state.rttSamples.length > 5) state.rttSamples.shift();
          state.rttMs = Math.round(
            state.rttSamples.reduce((a, b) => a + b, 0) / state.rttSamples.length
          );
          if (statRtt) statRtt.textContent = `${state.rttMs} ms`;
        }
        break;
      }
      case "screen-share": {
        // Partner flipped screen share on/off. Their video track in our
        // Partner tile already swapped via replaceTrack; we additionally
        // expand their tile so they can show us something readable.
        state.remoteScreenSharing = !!msg.on;
        const who = state.partnerName || "Partner";
        appendChat(
          msg.on ? `${who} started sharing their screen.`
                 : `${who} stopped sharing their screen.`,
          "sys"
        );
        updateShareLayout();
        break;
      }
      case "now-playing": {
        // Partner is telling us what they're watching. Update banner +
        // state, and — crucially — auto-follow them to a new episode /
        // video when we're already on the same platform with a tab open.
        const prevUrl = state.partnerUrl;
        state.partnerTitle = (msg.title || "").toString().slice(0, 200);
        state.partnerUrl = canonicalizeUrl(msg.url || "");
        updatePartnerBanner();
        if (prevUrl && prevUrl !== state.partnerUrl) {
          appendChat(`${state.partnerName || "Partner"} switched to ${cleanTitle(state.partnerTitle)}.`, "sys");
        }
        // Auto-follow when the partner navigates within the same platform
        // (e.g. clicked "Next episode" on Netflix, picked another video on
        // YouTube). Conditions:
        //  - we have a watched tab to redirect (don't open something the
        //    user didn't ask for),
        //  - the new URL is on the same platform we're currently watching
        //    (different platforms = different login, don't yank the user
        //    onto a service they may not have),
        //  - the canonical URL is actually different from ours.
        // The ping-pong is naturally bounded: once we navigate, our own
        // meta event fires, we broadcast a now-playing match, and the
        // partner's check sees the URLs equal so they no-op.
        if (state.partnerUrl &&
            state.watchingTabId &&
            state.nowPlayingUrl &&
            state.partnerUrl !== state.nowPlayingUrl &&
            platformName(state.partnerUrl) === platformName(state.nowPlayingUrl)) {
          autoFollowPartner(state.partnerUrl, state.partnerTitle);
        }
        break;
      }
      case "hello": {
        const nice = (msg.name || "").toString().slice(0, 24).trim();
        state.partnerName = nice || "Partner";
        updateTileLabels();
        setPeerStatus(`Connected with ${state.partnerName}.`, "connected");
        appendChat(`${state.partnerName} joined.`, "sys");
        break;
      }
      case "chat": {
        // Cap incoming chat so a malicious / buggy peer can't blow up the
        // DOM by sending a multi-megabyte payload.
        const text = (typeof msg.text === "string" ? msg.text : "").slice(0, 1000);
        if (text) appendChat(`${state.partnerName || "Partner"}: ${text}`);
        break;
      }
      case "sync": {
        const a = msg.action || {};
        if (!isValidSyncAction(a)) break;
        const line = actionLine(state.partnerName || "Partner", a);
        if (line) { setStatus(line); appendChat(line, "sys"); }
        forwardToContent(a);
        // Long forward seeks need a beat for the receiving player to buffer
        // the new range. The host fires one corrective drift-sync ~1.5s
        // after the seek so any residual offset gets snapped away instead
        // of waiting up to 5s for the periodic loop.
        if (a.kind === "seek" && state.isHost) {
          setTimeout(broadcastTimeSync, 1500);
        }
        // Cued-play covers two cases:
        //  - "Start together" countdown: show the 3-2-1 overlay so users
        //    see the deliberate sync.
        //  - Long-jump rejoin (silent: true): no UI — we just need both
        //    sides to pause, pre-seek, and resume at the shared wallclock.
        if (a.kind === "cued-play" && typeof a.at === "number" && !a.silent) {
          appendChat(`${state.partnerName || "Partner"} is starting playback in sync…`, "sys");
          showCountdown(a.at);
        }
        break;
      }
      case "drift-sync": {
        // Periodic time sync from the host — quiet, no chat log entry.
        const a = Object.assign({ kind: "drift-sync" }, msg.action || msg);
        if (!isValidSyncAction(a)) break;
        forwardToContent(a);
        break;
      }
      case "need-time-sync":
        if (state.isHost) broadcastTimeSync();
        break;
      case "request": {
        // In host-authority mode the guest sends its playback intent here;
        // the host decides whether to apply + broadcast.
        if (state.isHost && state.settings && state.settings.hostAuthority) {
          const a = msg.action || {};
          if (!isValidSyncAction(a)) break;
          const line = actionLine(state.partnerName || "Partner", a);
          if (line) appendChat(line + " (requested)", "sys");
          forwardToContent(a);                                 // host applies locally
          sendData({ t: "sync", action: a });                   // and echoes the final decision
        }
        break;
      }
      case "state": {
        // Received a state snapshot from peer — align our player if we're behind.
        const a = msg.action || {};
        if (typeof a.time !== "number" || !Number.isFinite(a.time) || a.time < 0 || a.time > 86400) break;
        forwardToContent({ kind: a.paused ? "pause" : "play", time: a.time });
        break;
      }
    }
  }

  // Whitelist of sync action shapes we'll accept from a peer. Anything
  // outside this set — unknown kinds, NaN times, absurd playback rates —
  // is dropped before it ever reaches the content script. Cheap belt-and-
  // braces against a buggy or malicious peer.
  const ALLOWED_SYNC_KINDS = new Set(["play","pause","seek","rate","drift-sync","cued-play"]);
  function isValidSyncAction(a) {
    if (!a || !ALLOWED_SYNC_KINDS.has(a.kind)) return false;
    if (a.time != null && (!Number.isFinite(a.time) || a.time < 0 || a.time > 86400)) return false;
    if (a.rate != null && (!Number.isFinite(a.rate) || a.rate < 0.25 || a.rate > 4)) return false;
    if (a.at != null && !Number.isFinite(a.at)) return false;
    return true;
  }

  // ---------- create / join ----------
  btnCreate.addEventListener("click", async () => {
    stopDeviceTest();
    const code = shortCode();
    state.isHost = true;
    state.roomCode = code;
    state.displayName = resolveDisplayName();
    state.partnerName = "";
    roomCodeEl.textContent = code;
    roomPanel.classList.add("hidden");
    sessionPanel.classList.remove("hidden");
    document.body.classList.add("in-session");
    mountDevicePickerForSession();
    clearChat();
    updateTileLabels();
    updateHeaderCode();
    setConn("connecting");
    setStatus("Creating room…");
    ensurePeer(peerIdFor(code));
    refreshTabs();
    saveSession();
    appendChat(`Room ${code} created. Share this code with your partner.`, "sys");
    appendChat(`You're signed in as ${state.displayName}.`, "sys");
  });

  btnJoin.addEventListener("click", () => {
    stopDeviceTest();
    const code = joinCode.value.trim().toUpperCase();
    if (!code) return;
    state.isHost = false;
    state.roomCode = code;
    state.displayName = resolveDisplayName();
    state.partnerName = "";
    roomCodeEl.textContent = code;
    roomPanel.classList.add("hidden");
    sessionPanel.classList.remove("hidden");
    document.body.classList.add("in-session");
    mountDevicePickerForSession();
    clearChat();
    updateTileLabels();
    updateHeaderCode();
    setConn("connecting");
    setStatus(`Joining room ${code}…`);
    appendChat(`You're signed in as ${state.displayName}.`, "sys");

    const peer = ensurePeer(peerIdFor(`guest-${shortCode()}`));
    const doConnect = () => {
      const conn = peer.connect(peerIdFor(code), { reliable: true });
      attachDataConn(conn);

      // If the data channel hasn't opened within 5 s it usually means the
      // host isn't registered yet or typed-in code is wrong. Surface a hint
      // without killing the connection — PeerJS will still retry in the
      // background and onDataConn("open") will cheerfully clear this message
      // if the host shows up late.
      setTimeout(() => {
        if (state.dataConn === conn && !conn.open) {
          setStatus(`Still trying to reach room ${code}… double-check the code, and ask your partner to open Hidden Time.`);
        }
      }, 5000);
    };
    if (peer.open) doConnect();
    else peer.once("open", doConnect);
    refreshTabs();
    saveSession();
  });

  btnCopy.addEventListener("click", async () => {
    if (!state.roomCode) return;
    try {
      await navigator.clipboard.writeText(state.roomCode);
      setStatus("Code copied.");
    } catch (_) {
      setStatus("Copy failed — select the code manually.");
    }
  });

  // Share link — a one-click invite. Pasting the URL into Chrome opens
  // Hidden Time with the Join field pre-filled; the recipient just clicks
  // Join. The URL is chrome-extension://<id>/popup.html?room=CODE which is
  // only shareable when both people already have the extension installed,
  // but that's the reality for any invite of this shape.
  function buildInviteUrl() {
    if (!state.roomCode) return null;
    return chrome.runtime.getURL("popup.html") + "?room=" + encodeURIComponent(state.roomCode);
  }
  if (btnShareLink) {
    btnShareLink.addEventListener("click", async () => {
      const url = buildInviteUrl();
      if (!url) return;
      const msg = `Join me on Hidden Time (code ${state.roomCode}): ${url}`;
      try {
        await navigator.clipboard.writeText(msg);
        setStatus("Invite link copied — paste it into any chat app.");
      } catch (_) {
        setStatus("Copy failed. URL: " + url);
      }
    });
  }

  // Auto-fill the Join field if the popup was opened via an invite URL
  // (?room=CODE). Side panels don't carry search params, so this only
  // fires when the popup is loaded as a tab via btnOpenInTab or the
  // invite link.
  (function seedRoomFromUrl() {
    try {
      const params = new URLSearchParams(location.search || "");
      const code = (params.get("room") || "").trim().toUpperCase();
      if (code && /^[A-Z0-9]{3,12}$/.test(code)) {
        joinCode.value = code;
        setStatus(`Room ${code} pre-filled. Click Join to enter.`);
      }
    } catch (_) {}
  })();

  // Clicking the code chip in the header also copies — handy when it's in
  // the room-bar at the bottom is scrolled out of view.
  if (headerCode) {
    headerCode.addEventListener("click", async () => {
      if (!state.roomCode) return;
      try {
        await navigator.clipboard.writeText(state.roomCode);
        headerCode.classList.add("flash");
        setTimeout(() => headerCode.classList.remove("flash"), 700);
        setStatus("Code copied.");
      } catch (_) {}
    });
  }

  btnLeave.addEventListener("click", () => {
    teardown();
    clearSession();
    roomPanel.classList.remove("hidden");
    sessionPanel.classList.add("hidden");
    document.body.classList.remove("in-session");
    mountDevicePickerForPreJoin();
    if (btnDevices) btnDevices.classList.remove("active");
    updateHeaderCode();
    setConn("idle");
    setStatus("Left the room.");
    setPeerStatus("Waiting for partner…");
  });

  // Retry keeps the current room code but rebuilds whatever has died.
  //   * Host — if the peer is still registered with the signalling server,
  //     nothing to rebuild; just surface the "waiting" state so the user
  //     knows the room is healthy and their partner can still rejoin.
  //   * Guest — always rebuild a fresh guest peer and dial the host.
  // Guest clicks "Open" on the partner banner: open the host's URL in a new
  // tab and promote that tab to our Watching selection. The content script
  // on that tab sends its first meta event once the video element mounts,
  // which updates state.nowPlayingUrl and auto-hides the banner via
  // updatePartnerBanner.
  btnOpenPartner.addEventListener("click", async () => {
    if (!state.partnerUrl) return;
    try {
      const tab = await chrome.tabs.create({ url: state.partnerUrl, active: true });
      if (!tab || !tab.id) return;
      state.watchingTabId = tab.id;
      chrome.runtime.sendMessage({ type: "HT_SET_WATCHING_TAB", tabId: tab.id });
      // Optimistically assume we're now on the partner's URL so the banner
      // disappears right away; the content script's first meta event will
      // confirm (or clear) it authoritatively.
      state.nowPlayingUrl = state.partnerUrl;
      updatePartnerBanner();
      setStatus("Opening your partner's page…");
      // Content scripts need ~1–2 s to register after a fresh page load.
      setTimeout(() => {
        refreshTabs();
        setTimeout(() => {
          const id = String(tab.id);
          if (Array.from(tabSelect.options).some((o) => o.value === id)) {
            tabSelect.value = id;
            tabSelect.dispatchEvent(new Event("change"));
          }
        }, 1500);
      }, 500);
    } catch (e) {
      setStatus(`Couldn't open the link: ${e.message}`);
    }
  });

  btnReconnect.addEventListener("click", () => {
    if (!state.roomCode) return;
    const code = state.roomCode;
    const asHost = state.isHost;

    if (state.dataConn) { try { state.dataConn.close(); } catch (_) {} state.dataConn = null; }

    if (asHost) {
      const peerHealthy = state.peer && !state.peer.destroyed && state.peer.open;
      if (peerHealthy) {
        setConn("connecting");
        setStatus(`Waiting for partner on ${code}…`);
        setPeerStatus(`Room ready — partner can rejoin with ${code}.`);
        return;
      }
      // Peer itself is gone (signalling outage, etc.) — full rebuild.
      if (state.peer) { try { state.peer.destroy(); } catch (_) {} state.peer = null; }
      setConn("connecting");
      setStatus("Reopening room…");
      setPeerStatus("Reopening room…");
      ensurePeer(peerIdFor(code));
      return;
    }

    // Guest rebuild
    if (state.peer) { try { state.peer.destroy(); } catch (_) {} state.peer = null; }
    setConn("connecting");
    setStatus("Reconnecting…");
    setPeerStatus("Reconnecting…");
    const peer = ensurePeer(peerIdFor(`guest-${shortCode()}`));
    const doConnect = () => {
      const conn = peer.connect(peerIdFor(code), { reliable: true });
      attachDataConn(conn);
    };
    if (peer.open) doConnect();
    else peer.once("open", doConnect);
  });

  function teardown() {
    stopHeartbeat();
    stopTimeSyncLoop();
    stopStatsLoop();
    stopMicMeter();
    stopDeviceTest();
    stopDucking();
    // Stop screen share but don't wait on the replaceTrack dance; the peer
    // connection is about to close anyway.
    if (state.screenStream) {
      state.screenStream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
      state.screenStream = null;
    }
    if (state.screenAudioCtx) { try { state.screenAudioCtx.close(); } catch (_) {} state.screenAudioCtx = null; }
    state.previousVideoTrack = null;
    state.previousAudioTrack = null;
    state.remoteScreenSharing = false;
    if (localVideo) localVideo.classList.remove("sharing");
    updateShareLayout();
    if (state.mediaCall) { try { state.mediaCall.close(); } catch (_) {} }
    if (state.dataConn) { try { state.dataConn.close(); } catch (_) {} }
    if (state.peer) { try { state.peer.destroy(); } catch (_) {} }
    if (state.localStream) { state.localStream.getTracks().forEach((t) => t.stop()); }
    state.peer = null;
    state.dataConn = null;
    state.mediaCall = null;
    state.localStream = null;
    state.remoteStream = null;
    state.roomCode = null;           // disables scheduleAutoReconnect
    state.reconnectAttempts = 0;
    state.partnerName = "";
    state.partnerUrl = "";
    state.partnerTitle = "";
    updateTileLabels();
    updatePartnerBanner();
    localVideo.srcObject = null;
    remoteVideo.srcObject = null;
  }

  // ---------- media (call + local preview) ----------
  // We request one stream with both audio + video up-front, then let the user
  // control what is actually live via the .enabled flag on each track. This
  // keeps preview, mute, un-mute and in-call replacement simple: no need to
  // tear down and re-getUserMedia every time the user toggles a device.
  async function ensureLocalMedia() {
    if (state.localStream && state.localStream.getTracks().length > 0) {
      return state.localStream;
    }
    try {
      const audio = state.micDeviceId
        ? { deviceId: { exact: state.micDeviceId } }
        : true;
      const video = Object.assign({}, VIDEO_CONSTRAINTS,
        state.camDeviceId ? { deviceId: { exact: state.camDeviceId } } : {});
      const stream = await navigator.mediaDevices.getUserMedia({ audio, video });
      // Stop any orphan stream before we overwrite the reference, otherwise
      // the camera light stays on until GC eventually runs the finalizer.
      if (state.localStream) {
        try { state.localStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
      }
      state.localStream = stream;
      localVideo.srcObject = stream;
      stream.getVideoTracks().forEach((t) => { t.enabled = state.camEnabled; });
      stream.getAudioTracks().forEach((t) => { t.enabled = state.micEnabled; });
      await refreshPermissions();
      return stream;
    } catch (e) {
      await refreshPermissions();
      handleMediaError(e);
      throw e;
    }
  }

  function updateCamMicUI() {
    btnCam.classList.toggle("active", state.camEnabled);
    btnMic.classList.toggle("active", state.micEnabled);
    btnCam.textContent = state.camEnabled ? "Cam on" : "Cam";
    btnMic.textContent = state.micEnabled ? "Mic on" : "Mic";
  }

  // -------- Mic level meter (local test) --------
  // Lets the user confirm their microphone works before anyone joins the
  // room: the bar under the "You" tile pulses with your voice. Built on the
  // Web Audio API so it reflects the actual audio the peer would receive.
  function startMicMeter() {
    stopMicMeter();
    if (!state.localStream) return;
    const audioTrack = state.localStream.getAudioTracks()[0];
    if (!audioTrack) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      const source = ctx.createMediaStreamSource(state.localStream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.6;
      source.connect(analyser);
      state.audioCtx = ctx;
      state.audioAnalyser = analyser;

      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        if (!state.audioAnalyser) return;
        analyser.getByteFrequencyData(data);
        // RMS is a better perceptual match than mean — matches what the peer
        // will actually hear in loudness terms.
        let sumSq = 0;
        for (let i = 0; i < data.length; i++) sumSq += data[i] * data[i];
        const rms = Math.sqrt(sumSq / data.length);   // 0..255
        const level = Math.min(100, (rms / 140) * 100); // compressed to 0..100
        if (micMeterFill) micMeterFill.style.width = level.toFixed(1) + "%";
        if (micMeter) micMeter.classList.toggle("peaking", level > 80);
        state.meterRAF = requestAnimationFrame(tick);
      };
      tick();
      if (micMeter) micMeter.classList.add("active");
    } catch (e) {
      console.warn("Mic meter failed:", e);
    }
  }

  function stopMicMeter() {
    if (state.meterRAF) { cancelAnimationFrame(state.meterRAF); state.meterRAF = null; }
    if (state.audioCtx) { try { state.audioCtx.close(); } catch (_) {} state.audioCtx = null; }
    state.audioAnalyser = null;
    if (micMeterFill) micMeterFill.style.width = "0%";
    if (micMeter) micMeter.classList.remove("active", "peaking");
  }

  // When an active call is running and we toggle a track, apply the change
  // to the outgoing RTCRtpSender too so the peer sees it immediately.
  function applyTrackToCall(kind) {
    if (!state.mediaCall || !state.mediaCall.peerConnection) return;
    const pc = state.mediaCall.peerConnection;
    const sender = pc.getSenders().find((s) => s.track && s.track.kind === kind);
    if (!sender || !state.localStream) return;
    const track = kind === "video"
      ? state.localStream.getVideoTracks()[0]
      : state.localStream.getAudioTracks()[0];
    if (track && sender.track !== track) {
      try { sender.replaceTrack(track); } catch (_) {}
    }
  }

  // Shared toggle: flips either track on/off, creates the local stream on
  // first use, and auto-starts the outgoing call to the connected peer so the
  // user never has to press a separate "Call" button.
  async function toggleTrack(kind) {
    const key = kind === "video" ? "camEnabled" : "micEnabled";
    const previous = state[key];
    state[key] = !state[key];
    updateCamMicUI();
    try {
      if (state.camEnabled || state.micEnabled) await ensureLocalMedia();
      if (state.localStream) {
        const tracks = kind === "video"
          ? state.localStream.getVideoTracks()
          : state.localStream.getAudioTracks();
        tracks.forEach((t) => { t.enabled = state[key]; });
      }
      if (kind === "audio") {
        if (state.micEnabled) startMicMeter();
        else stopMicMeter();
      }
      applyTrackToCall(kind);
      await maybeStartCall();
    } catch (_) {
      state[key] = previous;
      updateCamMicUI();
    }
  }

  btnCam.addEventListener("click", () => toggleTrack("video"));
  btnMic.addEventListener("click", () => toggleTrack("audio"));

  async function maybeStartCall() {
    if (!state.dataConn || !state.dataConn.open) return;      // no peer yet
    if (!state.micEnabled && !state.camEnabled) return;       // nothing to send
    if (!state.localStream) return;

    // An existing call with our tracks already attached: nothing to do —
    // the track.enabled flip does the work.
    if (state.mediaCall) {
      const pc = state.mediaCall.peerConnection;
      const hasOurTracks = pc && pc.getSenders().some((s) => s.track);
      if (hasOurTracks) return;
      // We answered earlier without a stream; renegotiate by closing and
      // re-calling with the stream we now have.
      try { state.mediaCall.close(); } catch (_) {}
      state.mediaCall = null;
    }

    const call = state.peer.call(state.dataConn.peer, state.localStream);
    attachMediaCall(call);
    setStatus("Connecting call…");
  }

  // -------- Device test (pre-join preview) --------
  // Gives the user a way to verify their mic + camera work before they join
  // a room, which is exactly the feedback people expect from a "Grant access"
  // flow. Runs an isolated stream that ends the moment they press Stop, so
  // the browser's "camera in use" indicator disappears.
  async function startDeviceTest() {
    try {
      const audio = state.micDeviceId ? { deviceId: { exact: state.micDeviceId } } : true;
      const video = Object.assign({}, VIDEO_CONSTRAINTS,
        state.camDeviceId ? { deviceId: { exact: state.camDeviceId } } : {});
      const stream = await navigator.mediaDevices.getUserMedia({ audio, video });
      if (state.testStream) {
        try { state.testStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
      }
      state.testStream = stream;
      setupCamPreview.srcObject = state.testStream;
      setupPreview.classList.remove("hidden");
      btnTestDevices.textContent = "Stop test";
      btnTestDevices.classList.add("active");
      startTestMeter();
      await refreshPermissions();
      setStatus("Device test running — speak and move to verify.");
    } catch (e) {
      handleMediaError(e);
      await refreshPermissions();
    }
  }

  function stopDeviceTest() {
    if (state.testMeterRAF) { cancelAnimationFrame(state.testMeterRAF); state.testMeterRAF = null; }
    if (state.testAudioCtx) { try { state.testAudioCtx.close(); } catch (_) {} state.testAudioCtx = null; }
    if (state.testStream) {
      state.testStream.getTracks().forEach((t) => t.stop());
      state.testStream = null;
    }
    if (setupCamPreview) setupCamPreview.srcObject = null;
    if (setupMicFill) setupMicFill.style.width = "0%";
    if (setupPreview) setupPreview.classList.add("hidden");
    if (btnTestDevices) {
      btnTestDevices.textContent = "Test";
      btnTestDevices.classList.remove("active");
    }
  }

  function startTestMeter() {
    if (!state.testStream) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      state.testAudioCtx = ctx;
      const src = ctx.createMediaStreamSource(state.testStream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.6;
      src.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        if (!state.testAudioCtx) return;
        analyser.getByteFrequencyData(data);
        let sumSq = 0;
        for (let i = 0; i < data.length; i++) sumSq += data[i] * data[i];
        const rms = Math.sqrt(sumSq / data.length);
        const level = Math.min(100, (rms / 140) * 100);
        if (setupMicFill) setupMicFill.style.width = level.toFixed(1) + "%";
        state.testMeterRAF = requestAnimationFrame(tick);
      };
      tick();
    } catch (e) {
      console.warn("Test meter failed:", e);
    }
  }

  if (btnTestDevices) {
    btnTestDevices.addEventListener("click", () => {
      if (state.testStream) { stopDeviceTest(); return; }
      // Denied path — same behaviour as Grant access: send them to Chrome's
      // per-extension settings page.
      const denied = state.perms.mic === "denied" || state.perms.cam === "denied";
      if (denied) {
        btnGrant.click();
        return;
      }
      startDeviceTest();
    });
  }

  // Grant flow: always try getUserMedia first. The cached perms state can
  // be stale (especially right after the user unblocks in settings and comes
  // back here), so attempting the real call is the source of truth.
  //   * Success  → granted.
  //   * NotAllowedError + cached "denied" → open Chrome's site settings.
  //   * NotAllowedError + cached "prompt"  → user dismissed the prompt; just
  //     ask them to try again.
  //   * Any other error → show the specific media-error message.
  btnGrant.addEventListener("click", async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: VIDEO_CONSTRAINTS
      });
      stream.getTracks().forEach((t) => t.stop());
      await refreshPermissions();
      setStatus("Camera and microphone allowed.");
    } catch (e) {
      await refreshPermissions();
      const name = e && e.name;
      if (name === "NotAllowedError" || name === "SecurityError") {
        // Don't trust cached state.perms here — after a dismissal, Chrome
        // may still report "prompt" while silently blocking getUserMedia.
        // Surface the help panel unconditionally and try opening settings.
        if (accessHelp) accessHelp.classList.remove("hidden");
        const opened = await openChromeSiteSettings();
        if (opened) {
          setStatus("On the page that just opened, set Camera + Microphone to Allow, then click Check now.");
        } else {
          setStatus("Chrome blocked the settings link. Paste chrome://settings/content/camera into a new tab and set Hidden Time to Allow.");
        }
      } else {
        handleMediaError(e);
      }
    }
  });

  if (btnOpenSettings) {
    btnOpenSettings.addEventListener("click", async () => {
      const opened = await openChromeSiteSettings();
      if (!opened) {
        setStatus("Open chrome://settings/content/camera and chrome://settings/content/microphone to allow Hidden Time.");
      }
    });
  }

  if (btnCheckPerms) {
    btnCheckPerms.addEventListener("click", async () => {
      await refreshPermissions();
      if (state.perms.mic === "granted" && state.perms.cam === "granted") {
        setStatus("Access granted. You're good to go.");
      } else if (state.perms.mic === "denied" || state.perms.cam === "denied") {
        setStatus("Still blocked. Make sure both Camera and Microphone are set to Allow in Chrome settings.");
      } else {
        setStatus("Permissions look resettable — click Grant access to trigger the prompt.");
      }
    });
  }

  // "Open in tab" — opens popup.html as a full tab. Chrome's permission
  // prompts attach to the tab's own URL bar there, which is much more
  // visible than the small pill that appears in the main window when a
  // side panel requests media. Side panels also hit Chrome's "dismissal
  // backoff" harder, so a fresh tab context often clears the throttle.
  const btnOpenInTab = document.getElementById("btn-open-in-tab");
  if (btnOpenInTab) {
    btnOpenInTab.addEventListener("click", async () => {
      try {
        await chrome.tabs.create({
          url: chrome.runtime.getURL("popup.html"),
          active: true
        });
        setStatus("Hidden Time opened in a full tab — click Grant access there. The prompt is clearer.");
      } catch (e) {
        setStatus(`Couldn't open in a tab: ${e.message}`);
      }
    });
  }

  // The URL shown in the fallback paragraph — populated at runtime so the
  // user can copy the real per-extension siteDetails URL.
  const settingsUrlText = document.getElementById("settings-url-text");
  if (settingsUrlText) {
    settingsUrlText.textContent =
      `chrome://settings/content/siteDetails?site=${encodeURIComponent("chrome-extension://" + chrome.runtime.id)}`;
  }

  // ---------- chat ----------
  chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    sendData({ t: "chat", text });
    appendChat(`${state.displayName || "You"}: ${text}`, "me");
    chatInput.value = "";
  });

  // ---------- watched tab (video sync) ----------
  const SCREEN_SHARE_VALUE = "__screen__";

  function refreshTabs() {
    chrome.runtime.sendMessage({ type: "HT_LIST_VIDEO_TABS" }, (resp) => {
      const tabs = (resp && resp.tabs) || [];
      const prev = tabSelect.value;
      tabSelect.innerHTML = '<option value="">— pick a streaming tab —</option>';

      // Screen share option — always available, sits right under the
      // placeholder so it's the first actionable entry.
      const shareOpt = document.createElement("option");
      shareOpt.value = SCREEN_SHARE_VALUE;
      shareOpt.textContent = state.screenStream
        ? "Sharing your screen — pick again to stop"
        : "Share my screen…";
      tabSelect.appendChild(shareOpt);

      // Dedupe — users often end up with the same title open twice (a
      // background reload + the active player, or pinned + window copy).
      // Collapse by canonical URL, then by platform+title as a fallback,
      // preferring the most recently active tab so the chosen entry is
      // the one actually playing.
      const seen = new Map();
      const sorted = tabs.slice().sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
      for (const t of sorted) {
        const key = canonicalizeUrl(t.url) || `${platformName(t.url)}::${(t.title || "").trim()}`;
        if (!key || seen.has(key)) continue;
        seen.set(key, t);
      }

      for (const t of seen.values()) {
        const opt = document.createElement("option");
        opt.value = String(t.id);
        opt.textContent = `${platformName(t.url)} — ${truncate(t.title || t.url, 40)}`;
        tabSelect.appendChild(opt);
      }
      // If the previously-selected tab id is gone (deduped or closed) keep
      // the dropdown at the placeholder rather than silently selecting it.
      if (prev && Array.from(tabSelect.options).some((o) => o.value === prev)) {
        tabSelect.value = prev;
      }
      updateWatchStatus();
    });
  }

  function platformName(url) {
    if (!url) return "Unknown";
    let host = "";
    try { host = new URL(url).hostname.toLowerCase(); } catch (_) { host = url.toLowerCase(); }
    if (/(^|\.)netflix\.com$/.test(host))    return "Netflix";
    if (/(^|\.)youtube\.com$/.test(host))    return "YouTube";
    if (/(^|\.)sonyliv\.com$/.test(host))    return "SonyLiv";
    if (/(^|\.)zee5\.com$/.test(host))       return "Zee5";
    if (/(^|\.)hotstar\.com$/.test(host))    return "JioHotstar";
    if (/(^|\.)jiohotstar\.com$/.test(host)) return "JioHotstar";
    if (/(^|\.)jiocinema\.com$/.test(host))  return "JioCinema";
    if (/(^|\.)primevideo\.com$/.test(host)) return "Prime Video";
    if (/(^|\.)amazon\.(com|in|co\.uk)$/.test(host)) return "Prime Video";
    return "Web";
  }
  function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }

  // Strip tracking / session query-string junk from the URL before we
  // share or compare it. Netflix ships ?trackId=...&tctx=...&CNES_=... which
  // is session-scoped to the host; YouTube keeps v= but drops t=, list=, ab_.
  // For all other supported platforms the pathname alone identifies the
  // content, so drop the search+hash outright.
  function canonicalizeUrl(raw) {
    if (!raw) return "";
    let u;
    try { u = new URL(raw); } catch (_) { return raw; }
    const host = u.hostname.toLowerCase();
    if (/(^|\.)youtube\.com$/.test(host)) {
      const v = u.searchParams.get("v");
      if (v) return `${u.origin}/watch?v=${v}`;
      return u.origin + u.pathname;
    }
    return u.origin + u.pathname;
  }

  // Single source of truth for what we're watching — updates local state,
  // refreshes the UI, and tells the partner. Broadcast is bidirectional now:
  // either side can change their tab / URL, and the other sees it in chat
  // and in the "Partner is watching…" banner. Only broadcasts on change.
  function setNowPlaying(title, url) {
    const newTitle = title || null;
    const newUrl   = url ? canonicalizeUrl(url) : "";
    const changed  = state.nowPlaying !== newTitle || state.nowPlayingUrl !== newUrl;
    state.nowPlaying   = newTitle;
    state.nowPlayingUrl = newUrl;
    updateWatchStatus();
    updatePartnerBanner();
    if (changed && state.dataConn && state.dataConn.open) {
      sendData({ t: "now-playing", title: state.nowPlaying, url: state.nowPlayingUrl });
    }
  }

  // Navigate our watched tab to the URL the partner just switched to.
  // Used when the partner clicks "next episode" / picks another video on
  // a platform we're already on — keeps the rooms in sync without the
  // user having to chase the change manually. Throttled so a flapping
  // partner URL can't redirect-spam our tab.
  function autoFollowPartner(url, title) {
    if (!url || !state.watchingTabId) return;
    const now = Date.now();
    if (state.lastAutoFollowAt && now - state.lastAutoFollowAt < 4_000) return;
    if (state.lastAutoFollowUrl === url) return;
    state.lastAutoFollowAt = now;
    state.lastAutoFollowUrl = url;
    chrome.tabs.update(state.watchingTabId, { url }, () => {
      if (chrome.runtime.lastError) return;
      const niceTitle = cleanTitle(title) || url;
      appendChat(`Following ${state.partnerName || "partner"} to ${niceTitle}.`, "sys");
      // Optimistically reflect the change locally so we don't immediately
      // re-broadcast a stale URL when our own content.js fires a meta
      // event for the new page. setNowPlaying does the dedupe.
      setNowPlaying(title || state.nowPlaying, url);
    });
  }

  function updatePartnerBanner() {
    if (!state.partnerUrl) { partnerBanner.classList.add("hidden"); return; }
    // If we already have a watched tab on the same canonical URL, there's
    // nothing to prompt for — hide.
    const ours = canonicalizeUrl(state.nowPlayingUrl || "");
    if (ours && ours === state.partnerUrl) { partnerBanner.classList.add("hidden"); return; }
    partnerBanner.classList.remove("hidden");
    pbTitle.textContent = cleanTitle(state.partnerTitle) || state.partnerUrl;
    const platform = platformName(state.partnerUrl);
    pbPlatform.textContent = platform;
    pbHint.textContent = platform ? `Requires a ${platform} subscription.` : "";
  }

  // Strip the platform suffix each site appends to document.title so we show
  // the movie name cleanly. Handles " - YouTube", " | Netflix", "(3) " YT
  // unread-notification prefix, etc. Falls back to the raw title if nothing
  // matches.
  function cleanTitle(raw) {
    if (!raw) return "";
    let t = raw.replace(/^\(\d+\)\s*/, "").trim();
    const re = /\s*[\-|–—]\s*(YouTube|Netflix|SonyLIV|ZEE5|Hotstar|JioHotstar|JioCinema|Prime\s*Video|Amazon(\s*Prime)?(\s*Video)?)\s*$/i;
    t = t.replace(re, "").trim();
    t = t.replace(/^Watch\s+/i, "").trim();
    return t || raw;
  }

  tabSelect.addEventListener("change", async () => {
    const raw = tabSelect.value;

    // Screen share path — separate from streaming-tab sync.
    if (raw === SCREEN_SHARE_VALUE) {
      if (state.screenStream) {
        await stopScreenShare();
        tabSelect.value = "";
      } else {
        const ok = await startScreenShare();
        if (!ok) tabSelect.value = "";   // revert if user cancelled the picker
      }
      return;
    }

    // If we were screen sharing and picked a real tab, stop the share first.
    if (state.screenStream) await stopScreenShare();

    const id = raw ? parseInt(raw, 10) : null;
    state.watchingTabId = id;
    chrome.runtime.sendMessage({ type: "HT_SET_WATCHING_TAB", tabId: id });

    if (!id) {
      setNowPlaying(null, "");
      return;
    }

    // Two sources of truth: chrome.tabs.get() gives us title + URL
    // immediately (browser-synced metadata); the content script's
    // meta-request reply is authoritative for SPA-navigated pages where
    // the tab URL lags behind. Both flow through setNowPlaying, so each
    // broadcasts to the partner if values actually changed.
    chrome.tabs.get(id, (tab) => {
      if (chrome.runtime.lastError || !tab) return;
      setNowPlaying(
        tab.title || state.nowPlaying || "",
        tab.url   || state.nowPlayingUrl || ""
      );
    });
    chrome.tabs.sendMessage(id, { kind: "meta-request" }, (resp) => {
      if (chrome.runtime.lastError || !resp) return;
      if (resp.title || resp.url) {
        setNowPlaying(
          resp.title || state.nowPlaying || "",
          resp.url   || state.nowPlayingUrl || ""
        );
      }
    });

    requestLocalStateAndBroadcast();
  });

  btnRefreshTabs.addEventListener("click", refreshTabs);

  // -------- Screen-share tile layout --------
  // When either side is screen-sharing, expand that side's tile to a 16:9
  // main view and shrink the other to a picture-in-picture corner. Driven
  // by body.screen-expanded and .main-tile / .pip-tile classes — CSS does
  // the actual sizing, this function just applies the right classes based
  // on who's sharing.
  function updateShareLayout() {
    const localTile  = document.getElementById("local-tile");
    const remoteTile = document.getElementById("remote-tile");
    if (!localTile || !remoteTile) return;

    const localSharing  = !!state.screenStream;
    const remoteSharing = !!state.remoteScreenSharing;

    document.body.classList.toggle("screen-expanded", localSharing || remoteSharing);

    localTile.classList.remove("main-tile", "pip-tile");
    remoteTile.classList.remove("main-tile", "pip-tile");
    if (localSharing) {
      localTile.classList.add("main-tile");
      remoteTile.classList.add("pip-tile");
    } else if (remoteSharing) {
      remoteTile.classList.add("main-tile");
      localTile.classList.add("pip-tile");
    }

    // If we were in browser-fullscreen on a video that's no longer
    // the main-tile, exit fullscreen politely.
    if (!localSharing && !remoteSharing && document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
  }

  // Fullscreen button: tap to pop the current video into Chrome's
  // fullscreen. Works on either tile's video. Pressing ESC or clicking the
  // button again exits — browsers handle that by default.
  document.querySelectorAll(".tile-expand").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const targetId = btn.getAttribute("data-target");
      const el = document.getElementById(targetId);
      if (!el) return;
      try {
        if (document.fullscreenElement === el) {
          await document.exitFullscreen();
        } else {
          await el.requestFullscreen();
        }
      } catch (err) {
        setStatus(`Full screen unavailable: ${err.message}`);
      }
    });
  });

  // -------- Screen share --------
  // Swaps the outgoing camera track for a getDisplayMedia video track, and
  // if the user chose to share tab audio too, mixes that with the mic over
  // an AudioContext so the partner hears both the content + your voice.
  // Selecting a streaming tab from the dropdown, clicking "Stop sharing"
  // in Chrome's own pill, or leaving the room all revert cleanly.
  async function startScreenShare() {
    if (!state.dataConn || !state.dataConn.open) {
      setStatus("Start a room and wait for your partner to join before sharing your screen.");
      return false;
    }
    // Make sure there's an outgoing call to hijack; if not, start one with
    // mic so we have the sender pipes already wired up.
    if (!state.mediaCall) {
      if (!state.micEnabled && !state.camEnabled) state.micEnabled = true;
      updateCamMicUI();
      try { await ensureLocalMedia(); } catch (_) { return false; }
      await maybeStartCall();
    }

    let display;
    try {
      display = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 24, max: 30 } },
        audio: true   // user can opt in via the picker; we handle both cases
      });
    } catch (e) {
      // User cancelled the picker or Chrome denied — just silently revert.
      if (e && e.name !== "NotAllowedError" && e.name !== "AbortError") {
        setStatus(`Couldn't start screen share: ${e.message}`);
      }
      return false;
    }

    const screenVideo = display.getVideoTracks()[0];
    const screenAudio = display.getAudioTracks()[0] || null;
    if (!screenVideo) { display.getTracks().forEach((t) => t.stop()); return false; }

    const pc = state.mediaCall && state.mediaCall.peerConnection;
    const videoSender = pc && pc.getSenders().find((s) => s.track && s.track.kind === "video");
    const audioSender = pc && pc.getSenders().find((s) => s.track && s.track.kind === "audio");

    // Save the outgoing tracks so we can put them back on stop.
    state.previousVideoTrack = videoSender && videoSender.track || null;
    state.previousAudioTrack = audioSender && audioSender.track || null;

    // Hot-swap the outgoing video.
    if (videoSender) { try { await videoSender.replaceTrack(screenVideo); } catch (_) {} }

    // If we got tab audio, mix it with the mic into a single outgoing track.
    if (screenAudio && audioSender && state.localStream && state.localStream.getAudioTracks()[0]) {
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        const ctx = new Ctx();
        const micSrc    = ctx.createMediaStreamSource(new MediaStream([state.localStream.getAudioTracks()[0]]));
        const screenSrc = ctx.createMediaStreamSource(new MediaStream([screenAudio]));
        const dest = ctx.createMediaStreamDestination();
        micSrc.connect(dest);
        screenSrc.connect(dest);
        const mixed = dest.stream.getAudioTracks()[0];
        await audioSender.replaceTrack(mixed);
        state.screenAudioCtx = ctx;
      } catch (e) {
        console.warn("Screen audio mix failed:", e);
      }
    }

    // Local preview of the screen in the "You" tile.
    localVideo.srcObject = new MediaStream([screenVideo]);
    localVideo.classList.add("sharing");

    state.screenStream = display;

    // When the user clicks Chrome's own "Stop sharing" pill the track ends.
    screenVideo.addEventListener("ended", () => {
      if (state.screenStream === display) stopScreenShare();
    });

    sendData({ t: "screen-share", on: true });
    appendChat(`${state.displayName || "You"} started sharing their screen.`, "sys");
    setStatus("Screen sharing to your partner.");
    refreshTabs();   // update the dropdown label
    updateShareLayout();
    return true;
  }

  async function stopScreenShare() {
    if (!state.screenStream) return;
    const display = state.screenStream;
    state.screenStream = null;

    // Close the audio mix graph first.
    if (state.screenAudioCtx) {
      try { state.screenAudioCtx.close(); } catch (_) {}
      state.screenAudioCtx = null;
    }

    // Stop every captured track (video + optional screen audio).
    display.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });

    // Restore the camera and mic tracks we saved when we started.
    const pc = state.mediaCall && state.mediaCall.peerConnection;
    if (pc) {
      const videoSender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
      const audioSender = pc.getSenders().find((s) => s.track && s.track.kind === "audio");
      if (videoSender) {
        const cam = state.previousVideoTrack ||
                    (state.localStream && state.localStream.getVideoTracks()[0]) || null;
        try { await videoSender.replaceTrack(cam); } catch (_) {}
      }
      if (audioSender) {
        const mic = state.previousAudioTrack ||
                    (state.localStream && state.localStream.getAudioTracks()[0]) || null;
        try { await audioSender.replaceTrack(mic); } catch (_) {}
      }
    }
    state.previousVideoTrack = null;
    state.previousAudioTrack = null;

    // Restore the camera preview in the local tile.
    if (state.localStream) localVideo.srcObject = state.localStream;
    localVideo.classList.remove("sharing");

    sendData({ t: "screen-share", on: false });
    appendChat(`${state.displayName || "You"} stopped sharing their screen.`, "sys");
    setStatus("Screen share stopped.");
    refreshTabs();
    if (tabSelect.value === SCREEN_SHARE_VALUE) tabSelect.value = "";
    updateShareLayout();
  }

  // -------- "Start together" (cued-play) --------
  // Broadcasts a scheduled-play message to the peer with a wallclock target
  // ~3 s in the future; both sides show a countdown overlay and the video
  // plays at exactly the target time on each device. Solves the "are we in
  // sync?" anxiety at the start of a movie.
  const COUNTDOWN_MS = 3000;

  function updateSyncPlayVisibility() {
    if (!btnSyncPlay) return;
    const ready = state.watchingTabId &&
                  state.dataConn && state.dataConn.open &&
                  !countdownActive();
    btnSyncPlay.classList.toggle("hidden", !ready);
  }

  let countdownTimer = null;
  function countdownActive() { return !!countdownTimer; }

  function showCountdown(targetAt) {
    if (!countdownOverlay || !countdownNumber) return;
    if (countdownTimer) { cancelAnimationFrame(countdownTimer); countdownTimer = null; }
    countdownOverlay.classList.remove("hidden");
    countdownNumber.classList.remove("go");

    let lastShown = -1;
    const tick = () => {
      const remain = targetAt - Date.now();
      if (remain <= 0) {
        countdownNumber.textContent = "▶";
        countdownNumber.classList.add("go");
        // Linger briefly so the user sees the "play" cue, then hide.
        setTimeout(() => {
          countdownOverlay.classList.add("hidden");
          countdownTimer = null;
          updateSyncPlayVisibility();
        }, 600);
        return;
      }
      const secs = Math.ceil(remain / 1000);
      if (secs !== lastShown) {
        lastShown = secs;
        countdownNumber.textContent = secs;
        // Restart the CSS pulse by toggling a class.
        countdownNumber.style.animation = "none";
        void countdownNumber.offsetWidth;
        countdownNumber.style.animation = "";
      }
      countdownTimer = requestAnimationFrame(tick);
    };
    countdownTimer = requestAnimationFrame(tick);
    updateSyncPlayVisibility();
  }

  if (btnSyncPlay) {
    btnSyncPlay.addEventListener("click", () => {
      if (!state.watchingTabId || !state.dataConn || !state.dataConn.open) return;
      // Ask the watched tab for its current playback position, then schedule
      // a cued-play on both sides for wall-clock (now + COUNTDOWN_MS).
      chrome.tabs.sendMessage(state.watchingTabId, { kind: "state-request" }, (resp) => {
        if (chrome.runtime.lastError) return;
        const s = resp && resp.ok && resp.state;
        if (!s) return;
        const targetAt = Date.now() + COUNTDOWN_MS;
        // First make sure both sides are paused at the same time — otherwise
        // host might be playing already, diverging before the cue fires.
        forwardToContent({ kind: "pause", time: s.time });
        const action = { kind: "cued-play", time: s.time, rate: s.rate, at: targetAt };
        sendData({ t: "sync", action });
        forwardToContent(action);
        showCountdown(targetAt);
      });
    });
  }

  function updateWatchStatus() {
    const nice = cleanTitle(state.nowPlaying);

    // Prominent "Now playing" banner above the video tiles.
    if (nice && state.watchingTabId) {
      npTitle.textContent = nice;
      nowPlayingBox.classList.remove("hidden");
      nowPlayingBox.title = state.nowPlaying || nice;
    } else {
      nowPlayingBox.classList.add("hidden");
      npTitle.textContent = "";
    }

    // Watch-status line below the dropdown — now just confirms sync state.
    if (!state.watchingTabId) {
      watchStatus.textContent = "No tab selected. Pick the tab that has your movie.";
      updateSyncPlayVisibility();
      return;
    }
    const opt = tabSelect.options[tabSelect.selectedIndex];
    const platform = opt && opt.textContent ? opt.textContent.split(" — ")[0] : "";
    watchStatus.textContent = platform
      ? `Synced with ${platform}.`
      : (opt ? `Synced with: ${opt.textContent}` : "Syncing…");
    updateSyncPlayVisibility();
  }

  function forwardToContent(action) {
    if (!state.watchingTabId) return;
    // Direct tab message — going through the service worker means an SW
    // suspension (every ~30s idle in MV3) silently drops actions, which is
    // exactly how play/pause/seek sync "suddenly stops working" mid-session.
    chrome.tabs.sendMessage(state.watchingTabId, action, () => void chrome.runtime.lastError);
  }

  function requestLocalStateAndBroadcast() {
    if (!state.watchingTabId || !state.dataConn || !state.dataConn.open) return;
    chrome.tabs.sendMessage(state.watchingTabId, { kind: "state-request" }, (resp) => {
      if (chrome.runtime.lastError) return;
      if (resp && resp.ok && resp.state) {
        sendData({ t: "state", action: resp.state });
      }
    });
  }

  // ---------- listen for events from the content script (routed via background) ----------
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "HT_CONTENT_EVENT") return;
    if (msg.fromTabId && state.watchingTabId && msg.fromTabId !== state.watchingTabId) return;
    const p = msg.payload;
    if (!p || !p.kind) return;
    if (p.kind === "attached") {
      setStatus(`Video detected (${Math.round(p.duration || 0)}s).`);
      return;
    }
    if (p.kind === "meta") {
      setNowPlaying(p.title, p.url);
      return;
    }
    if (p.kind === "refocus") {
      // Tab just came back into focus — ask the host to push a fresh
      // drift-sync so we snap back into alignment.
      if (!state.isHost) sendData({ t: "need-time-sync" });
      else broadcastTimeSync(); // host immediately pushes one
      return;
    }

    const line = actionLine(state.displayName || "You", p);
    if (line) appendChat(line, "sys");

    // ---- Long-jump coordination ----
    // For a *large* forward scrub while the video is playing, a raw seek
    // leaves the receiver chasing buffer: their player stalls fetching
    // the new range while the sender keeps rolling. Upgrade only those
    // big jumps to a cued-play: BOTH sides pause, pre-seek, then play
    // together at a shared wall-clock target ~1.5 s out.
    //
    // Threshold tuned past the default UI skip buttons (5-10 s on most
    // platforms — YouTube's arrow keys, Netflix / Prime / Hotstar /
    // JioCinema 10 s skips). Those keep using the existing fast path so
    // they feel instant. Only scrub-bar drags more than 30 s pay the
    // pause-and-resume cost.
    const LONG_JUMP_S = 30;
    const REJOIN_DELAY_MS = 1500;
    const isLongJump =
      p.kind === "seek" &&
      p.paused === false &&
      typeof p.delta === "number" &&
      p.delta > LONG_JUMP_S;

    if (isLongJump) {
      const at = Date.now() + REJOIN_DELAY_MS;
      const cue = {
        kind: "cued-play",
        time: typeof p.time === "number" ? p.time : 0,
        rate: typeof p.rate === "number" ? p.rate : 1,
        at,
        silent: true   // skip the on-screen 3-2-1 countdown overlay
      };
      // Apply locally — pauses our own video, pre-seeks, plays at `at`.
      forwardToContent(cue);
      // Same to peer.
      const authorityLJ = state.settings && state.settings.hostAuthority;
      if (authorityLJ && !state.isHost) {
        sendData({ t: "request", action: cue });
      } else {
        sendData({ t: "sync", action: cue });
      }
      // Backstop: if either side overshoots / undershoots, the periodic
      // drift-sync will land within ~5 s — but kick off one early.
      if (state.isHost) setTimeout(broadcastTimeSync, REJOIN_DELAY_MS + 600);
      return;
    }

    // In host-authority mode only the host broadcasts sync; guests send a
    // "request" which the host then applies + echoes as authoritative sync.
    const authority = state.settings && state.settings.hostAuthority;
    if (authority && !state.isHost) {
      sendData({ t: "request", action: p });
    } else {
      sendData({ t: "sync", action: p });
    }
    // After a local seek (short or paused-scrub), still schedule one
    // corrective drift-sync to clean up any residual offset.
    if (p.kind === "seek" && state.isHost) {
      setTimeout(broadcastTimeSync, 1500);
    }
  });

  // Autoplay unblock — if Chrome blocked the remote <video> from starting
  // audio, any click inside the side panel is a gesture good enough to
  // resume playback. Cheap, works quietly in the background.
  document.addEventListener("click", () => {
    if (remoteVideo && remoteVideo.srcObject && remoteVideo.paused) {
      remoteVideo.play().catch(() => {});
    }
  });

  // ---------- boot ----------
  setConn("idle");
  setStatus("Ready.");
  updateCamMicUI();
  refreshTabs();
  refreshPermissions();
  (async () => {
    await initSettings();
    await maybeOfferResume();
  })();

  // Release the camera + mic when the side panel is closed or reloaded.
  // Without this the OS-level "in use" indicator and the green tab dot
  // can linger because GC doesn't collect the MediaStream right away.
  window.addEventListener("pagehide", () => { try { teardown(); } catch (_) {} });
})();
