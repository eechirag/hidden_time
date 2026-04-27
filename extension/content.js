// Content script — finds the <video> element on the streaming page and
// bridges play/pause/seek between it and the Hidden Time popup window.

(() => {
  const SEEK_EPSILON = 0.5;          // seconds — ignore tiny drift when applying remote seeks
  const SUPPRESS_MS = 400;            // immediate window after applying remote to ignore echo events
  const ECHO_WINDOW_MS = 1500;        // longer window to catch delayed echo events on slow sites
  // Depth counter so overlapping remote actions (e.g. a play arrives while
  // a previous seek's suppression window is still ticking) don't have a
  // later timeout flip the flag back on too soon and let an echo through.
  let suppressDepth = 0;
  function suppressEnter() { suppressDepth++; setTimeout(suppressLeave, SUPPRESS_MS); }
  function suppressLeave() { suppressDepth = Math.max(0, suppressDepth - 1); }
  let lastRemote = { kind: null, time: 0, at: 0 };
  let duckedOriginalVolume = null;    // movie volume before audio-duck kicked in
  let video = null;
  let observer = null;

  // Netflix is hostile to generic <video> control — mutating currentTime or
  // calling .play() triggers their "extension interfering" error (code S7361)
  // and gets silently reverted. Instead, on Netflix we drive playback via the
  // site's own player API, reached through a main-world script injected by
  // the service worker.
  // NOTE: if a regional Netflix domain (e.g. netflix.in if it ever launches)
  // is added to manifest.json's host_permissions, update this regex too —
  // otherwise the page-context bridge will silently no-op and only the
  // generic-video fallback will run, which Netflix will reject with S7361.
  const IS_NETFLIX = /(^|\.)netflix\.com$/i.test(location.hostname);
  const IS_YOUTUBE = /(^|\.)youtube\.com$/i.test(location.hostname);
  const IS_PRIME   = /(^|\.)(primevideo|amazon)\.com$|(^|\.)amazon\.(in|co\.uk)$/i.test(location.hostname);
  if (IS_NETFLIX) {
    try { chrome.runtime.sendMessage({ type: "HT_INJECT_PAGE_CTX" }); } catch (_) {}
  }

  // Ad detection — seeking / play / pause during an ad slot affects the ad,
  // not the content, so we suspend sync broadcasts AND ignore incoming
  // actions until the ad ends. Once the content resumes, the next play /
  // pause / drift-sync puts everyone back in alignment.
  function isAdPlaying() {
    if (IS_YOUTUBE) {
      // YouTube's main player adds these classes while a video ad is up, but
      // the `ad-showing` class is known to linger on the player element after
      // the ad actually ends — which would perma-block sync. Require BOTH the
      // class and a live ad marker (the countdown text or the "Ad" badge) to
      // consider an ad truly playing.
      const p = document.querySelector(".html5-video-player");
      if (!p) return false;
      const classFlag = p.classList.contains("ad-showing") || p.classList.contains("ad-interrupting");
      if (!classFlag) return false;
      const liveAdMarker = document.querySelector(
        ".ytp-ad-duration-remaining, .ytp-ad-simple-ad-badge, .ytp-ad-player-overlay, .ytp-ad-skip-button, .ytp-ad-preview-container"
      );
      return !!liveAdMarker;
    }
    if (IS_PRIME) {
      // Prime Video's ad-tier overlay (rolled out Jan 2024 in most markets).
      if (document.querySelector(".atvwebplayersdk-adtimeindicator-text, .atvwebplayersdk-ads-bars")) return true;
    }
    return false;
  }

  // Post a request to the main-world script and wait for its response.
  // Returns { ok, reason?, state? }. Times out after 1500 ms so a stuck or
  // not-yet-ready player can't hang the content script.
  function nfRequest(cmd, payload, timeoutMs = 1500) {
    return new Promise((resolve) => {
      const id = "ht_" + Math.random().toString(36).slice(2, 9);
      const onRes = (ev) => {
        if (ev.source !== window) return;
        if (ev.origin !== window.location.origin) return;
        const res = ev.data;
        if (!res || res.__ht !== "nf-res" || res.id !== id) return;
        window.removeEventListener("message", onRes);
        resolve(res);
      };
      window.addEventListener("message", onRes);
      // Same-origin target — see page-context.js for rationale.
      window.postMessage(Object.assign({ __ht: "nf-cmd", id, cmd }, payload || {}), window.location.origin);
      setTimeout(() => {
        window.removeEventListener("message", onRes);
        resolve({ ok: false, reason: "timeout" });
      }, timeoutMs);
    });
  }

  function looksLikeEcho(kind, time) {
    if (!lastRemote.kind) return false;
    if (Date.now() - lastRemote.at > ECHO_WINDOW_MS) return false;
    const t = typeof time === "number" ? time : 0;
    const lt = typeof lastRemote.time === "number" ? lastRemote.time : 0;
    if (kind === "seek") return Math.abs(t - lt) < 1.5;
    // A remote pause often triggers a local "pause" AND a "seeked" event in
    // quick succession when we also corrected the time. Treat both as echo.
    if ((kind === "play" || kind === "pause") &&
        (lastRemote.kind === "play" || lastRemote.kind === "pause")) {
      return Math.abs(t - lt) < 1.5;
    }
    return false;
  }

  function findVideo() {
    // Rank candidates: the real player is the visible, large <video> with a
    // non-trivial duration. YouTube has extra <video> elements for ads and
    // preview cards; Prime/Netflix occasionally leave hidden ones around.
    const videos = Array.from(document.querySelectorAll("video"));
    if (videos.length === 0) return null;

    function score(v) {
      if (!v) return -1;
      const rect = v.getBoundingClientRect();
      const area = rect.width * rect.height;
      const visible = rect.width > 0 && rect.height > 0 && getComputedStyle(v).visibility !== "hidden";
      const dur = Number.isFinite(v.duration) ? v.duration : 0;
      let s = 0;
      if (visible) s += 1000;
      if (dur > 5) s += 500;         // real content, not a 1-second ad preview
      if (v.readyState >= 2) s += 100;
      if (!v.paused) s += 50;        // currently playing — almost certainly the one
      s += Math.min(area, 1_000_000) / 1000; // larger video wins on size
      return s;
    }

    return videos.reduce((best, v) => (score(v) > score(best) ? v : best), videos[0]);
  }

  // Tracks the most recent position reported via `timeupdate`. We sample
  // this *before* a seek lands so the seek event can report how big the
  // jump was — needed by the popup to decide whether to do the long-jump
  // pause-and-resume coordination dance.
  let lastKnownTime = 0;
  function onTimeUpdate() {
    if (suppressDepth > 0) return;
    if (video) lastKnownTime = video.currentTime;
  }

  function attach(v) {
    if (!v || v === video) return;
    detach();
    video = v;
    lastKnownTime = video.currentTime || 0;

    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("ratechange", onRateChange);
    video.addEventListener("timeupdate", onTimeUpdate);

    send({ kind: "attached", duration: video.duration || 0 });
    send({ kind: "meta", title: document.title, url: location.href });
  }

  function detach() {
    if (!video) return;
    video.removeEventListener("play", onPlay);
    video.removeEventListener("pause", onPause);
    video.removeEventListener("seeked", onSeeked);
    video.removeEventListener("ratechange", onRateChange);
    video.removeEventListener("timeupdate", onTimeUpdate);
    video = null;
  }

  function onPlay() {
    if (suppressDepth > 0 || looksLikeEcho("play", video.currentTime)) return;
    if (isAdPlaying()) return;
    send({ kind: "play", time: video.currentTime, rate: video.playbackRate, at: Date.now() });
  }
  function onPause() {
    if (suppressDepth > 0 || looksLikeEcho("pause", video.currentTime)) return;
    if (isAdPlaying()) return;
    send({ kind: "pause", time: video.currentTime, rate: video.playbackRate, at: Date.now() });
  }
  // Trailing-edge throttle on seeks: when the user drags the scrubber the
  // browser fires many `seeked` events in a row — collapse them into one,
  // 150 ms after the scrub stops, so we only send the final position.
  let seekTimer = null;
  function onSeeked() {
    if (suppressDepth > 0) return;
    if (seekTimer) clearTimeout(seekTimer);
    // Snapshot the pre-seek position the moment the user releases the
    // scrubber — the timeupdate samples after the seek will start
    // overwriting lastKnownTime within ~250 ms.
    const fromTime = lastKnownTime;
    seekTimer = setTimeout(() => {
      seekTimer = null;
      if (suppressDepth > 0 || looksLikeEcho("seek", video.currentTime)) return;
      if (isAdPlaying()) return;
      // paused: receiver uses this to decide whether to extrapolate the
      //         seek forward by transit time (playing) or treat it as a
      //         literal target (paused).
      // delta:  signed jump distance — popup uses |delta| to decide
      //         whether the jump is large enough to coordinate a buffer-
      //         friendly pause-and-resume rather than a raw seek.
      const delta = video.currentTime - fromTime;
      send({ kind: "seek", time: video.currentTime, rate: video.playbackRate,
             paused: video.paused, delta, at: Date.now() });
      lastKnownTime = video.currentTime;
    }, 150);
  }
  function onRateChange() {
    if (suppressDepth > 0) return;
    send({ kind: "rate", rate: video.playbackRate });
  }

  function send(payload) {
    try {
      chrome.runtime.sendMessage({ type: "HT_FROM_CONTENT", payload });
    } catch (_) {}
  }

  function applyRemote(action) {
    if (!video) video = findVideo();
    if (!video) return { ok: false, reason: "no-video" };

    // state-request is a read-only introspection call — don't touch the player.
    if (action.kind === "state-request") {
      return {
        ok: true,
        state: {
          time: video.currentTime,
          paused: video.paused,
          rate: video.playbackRate,
          duration: video.duration,
          title: document.title,
          url: location.href
        }
      };
    }
    if (action.kind === "meta-request") {
      return { ok: true, title: document.title, url: location.href };
    }

    // Audio ducking — lowers video volume while someone is talking on the
    // call. Doesn't touch play/pause/seek so it bypasses the suppress + echo
    // machinery entirely. duck saves the pre-duck volume; unduck restores it.
    if (action.kind === "duck") {
      if (video && duckedOriginalVolume == null) {
        duckedOriginalVolume = video.volume;
        const factor = typeof action.factor === "number" ? action.factor : 0.18;
        try { video.volume = Math.max(0, Math.min(1, duckedOriginalVolume * factor)); } catch (_) {}
      }
      return { ok: true };
    }
    if (action.kind === "unduck") {
      if (video && duckedOriginalVolume != null) {
        try { video.volume = duckedOriginalVolume; } catch (_) {}
        duckedOriginalVolume = null;
      }
      return { ok: true };
    }

    // Never apply remote play / pause / seek during an ad — the video we'd
    // seek is the ad, not the content. Let the ad finish; the next
    // drift-sync from the host (every 5 s) will re-align us.
    if (isAdPlaying() && (action.kind === "play" || action.kind === "pause" ||
                          action.kind === "seek" || action.kind === "drift-sync")) {
      return { ok: false, reason: "ad-playing" };
    }

    suppressEnter();
    lastRemote = {
      kind: action.kind,
      time: typeof action.time === "number" ? action.time : video.currentTime,
      at: Date.now()
    };

    try {
      switch (action.kind) {
        case "play": {
          const t = extrapolate(action);
          if (typeof t === "number" && Math.abs(video.currentTime - t) > SEEK_EPSILON) {
            video.currentTime = t;
          }
          if (typeof action.rate === "number") video.playbackRate = action.rate;
          video.play().catch(() => {});
          break;
        }
        case "pause":
          if (typeof action.time === "number" &&
              Math.abs(video.currentTime - action.time) > SEEK_EPSILON) {
            video.currentTime = action.time;
          }
          if (typeof action.rate === "number") video.playbackRate = action.rate;
          video.pause();
          break;
        case "seek": {
          // Extrapolate the sender's position forward by transit time when
          // the video is playing — otherwise a long forward-scrub leaves
          // the receiver `RTT + debounce` seconds behind, which on Indian
          // ISPs is easily a perceptible 0.5-1.5 s gap.
          const t = action.paused ? action.time : extrapolate(action);
          const target = typeof t === "number" ? t : action.time;
          if (typeof target === "number" &&
              Math.abs(video.currentTime - target) > SEEK_EPSILON) {
            video.currentTime = target;
          }
          break;
        }
        case "rate":
          if (typeof action.rate === "number") video.playbackRate = action.rate;
          break;
        case "cued-play": {
          // Scheduled-play: wait until the sender's wall-clock target time
          // then play. Used both by the "Start together" countdown and by
          // the long-jump coordinator: the popup converts a forward seek
          // > 5 s while playing into a cued-play so both sides pause,
          // pre-seek, and resume together — preventing the host from
          // running ahead while the guest stalls buffering.
          const delay = Math.max(0, (action.at || Date.now()) - Date.now());
          // Pre-seek + pause IMMEDIATELY — kicks the browser to start
          // fetching the new media range during the wait window so it's
          // ready to play the instant the timer fires. Without this the
          // host keeps rolling the old segment until `delay` elapses,
          // then jumps and stalls anyway.
          if (typeof action.time === "number" &&
              Math.abs(video.currentTime - action.time) > SEEK_EPSILON) {
            video.currentTime = action.time;
          }
          if (!video.paused) { try { video.pause(); } catch (_) {} }
          setTimeout(() => {
            suppressEnter();
            lastRemote = { kind: "play", time: action.time || 0, at: Date.now() };
            if (typeof action.time === "number" &&
                Math.abs(video.currentTime - action.time) > SEEK_EPSILON) {
              video.currentTime = action.time;
            }
            if (typeof action.rate === "number") video.playbackRate = action.rate;
            video.play().catch(() => {});
          }, delay);
          break;
        }
        case "drift-sync": {
          // Periodic resync from the host. Only nudge when drift exceeds the
          // threshold so we don't create a seeked event on every tick.
          const target = extrapolate(action);
          if (typeof target === "number") {
            const drift = Math.abs(video.currentTime - target);
            if (drift > 1.0) video.currentTime = target;
          }
          if (typeof action.rate === "number" && Math.abs(video.playbackRate - action.rate) > 0.01) {
            video.playbackRate = action.rate;
          }
          if (action.paused === true && !video.paused) video.pause();
          if (action.paused === false && video.paused) video.play().catch(() => {});
          break;
        }
      }
    } finally {
      // suppressEnter() already scheduled its own decrement.
    }
    return { ok: true };
  }

  // Given a sync payload with { time, rate, at }, compute the playback
  // position the sender SHOULD be at *right now* by accounting for the
  // one-way travel time. If the payload doesn't carry a timestamp (older
  // peer), fall back to the raw time.
  function extrapolate(action) {
    if (typeof action.time !== "number") return undefined;
    if (typeof action.at !== "number") return action.time;
    const now = Date.now();
    const elapsedMs = Math.max(0, now - action.at);
    const rate = typeof action.rate === "number" ? action.rate : 1;
    // For pause events the time is static, so don't advance it. Callers pass
    // only play/seek/drift-sync through here where advancing makes sense.
    return action.time + (elapsedMs / 1000) * rate;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.kind) return;

    // On Netflix, prefer the Netflix player API. If it's unavailable
    // (player not mounted yet, logged out, etc.) fall back to the generic
    // HTML5 <video> path so we at least try.
    if (IS_NETFLIX && msg.kind === "cued-play") {
      const delay = Math.max(0, (msg.at || Date.now()) - Date.now());
      // Pre-seek + pause now so Netflix starts buffering the target range
      // while we wait for the wall-clock target.
      if (typeof msg.time === "number") {
        nfRequest("pause", { ms: Math.round(msg.time * 1000) }).catch(() => {});
      } else {
        nfRequest("pause", {}).catch(() => {});
      }
      setTimeout(() => {
        suppressEnter();
        lastRemote = { kind: "play", time: msg.time || 0, at: Date.now() };
        nfRequest("play", {
          ms: typeof msg.time === "number" ? Math.round(msg.time * 1000) : undefined,
          rate: msg.rate
        }).then((res) => {
          if (!res || !res.ok) applyRemote({ kind: "play", time: msg.time, rate: msg.rate });
        });
      }, delay);
      sendResponse({ ok: true, via: "nf-api-cued" });
      return true;
    }
    if (IS_NETFLIX && (msg.kind === "play" || msg.kind === "pause" ||
                       msg.kind === "seek" || msg.kind === "rate" ||
                       msg.kind === "drift-sync")) {
      suppressEnter();
      lastRemote = {
        kind: msg.kind,
        time: typeof msg.time === "number" ? msg.time : (video ? video.currentTime : 0),
        at: Date.now()
      };

      // Map drift-sync to the underlying play/pause + seek intent for Netflix.
      const isDrift = msg.kind === "drift-sync";
      const cmd = isDrift ? (msg.paused ? "pause" : "play") : msg.kind;
      // Extrapolate the sender's current position only when the video
      // should be advancing — for pauses (incl. seeks made while paused)
      // the time is frozen and the literal target is correct.
      const advancing = (cmd === "play" || cmd === "seek") && msg.paused !== true;
      const payload = {};
      if (typeof msg.time === "number") {
        const target = advancing ? extrapolate(msg) : msg.time;
        const finalTime = typeof target === "number" ? target : msg.time;
        payload.ms = Math.round(finalTime * 1000);
      }
      if (typeof msg.rate === "number") payload.rate = msg.rate;

      nfRequest(cmd, payload).then((res) => {
        if (res && res.ok) {
          sendResponse({ ok: true, via: "nf-api" });
        } else {
          // Netflix API wasn't available — best-effort native fallback.
          sendResponse(applyRemote(msg));
        }
      });
      return true; // async response
    }

    const result = applyRemote(msg);
    sendResponse(result);
    return true;
  });

  // Keep looking for the video element — streaming sites lazy-mount their player.
  function watch() {
    // If our cached element got detached from the DOM (SPA nav, player teardown),
    // drop the reference so findVideo can pick up a fresh one.
    if (video && !video.isConnected) detach();
    const v = findVideo();
    if (v) attach(v);
  }

  watch();
  // Debounced observer — many sites mutate the DOM constantly (ad overlays,
  // caption frames). Coalesce rapid bursts so we only rescan once per burst.
  let watchDebounce = null;
  observer = new MutationObserver(() => {
    if (watchDebounce) return;
    watchDebounce = setTimeout(() => { watchDebounce = null; watch(); }, 250);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  // Safety net: if a DOM burst slips past the observer (site pauses mutations
  // while an ad plays, then swaps the video element in one frame), a slow
  // periodic rescan guarantees we re-attach within a few seconds.
  setInterval(watch, 5000);

  // Track <title> + URL changes. SPA navigation on YouTube / Netflix rewrites
  // both when you move between episodes. `popstate` covers back/forward;
  // `history.pushState` is silent so we poll location.href at 1 Hz as backup.
  let lastTitle = document.title;
  let lastUrl = location.href;
  function pushMetaIfChanged() {
    if (document.title !== lastTitle || location.href !== lastUrl) {
      lastTitle = document.title;
      lastUrl = location.href;
      send({ kind: "meta", title: lastTitle, url: lastUrl });
    }
  }
  const titleEl = document.querySelector("title");
  if (titleEl) {
    new MutationObserver(pushMetaIfChanged).observe(titleEl, {
      childList: true, characterData: true, subtree: true
    });
  }
  window.addEventListener("popstate", pushMetaIfChanged);
  setInterval(pushMetaIfChanged, 1000);

  // Allow the popup to pull the current title on demand (e.g. when the user
  // picks this tab from the dropdown long after the content script loaded).
  // Handled alongside the sync commands in applyRemote above.

  // When the tab comes back into focus after being hidden, browsers throttle
  // timers — playback state is typically stale. Push a fresh "refocus" event
  // so the popup can re-broadcast drift-sync to the peer.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !video) return;
    send({
      kind: "refocus",
      time: video.currentTime,
      paused: video.paused,
      rate: video.playbackRate,
      at: Date.now()
    });
  });
})();
