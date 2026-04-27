// Runs in the page's main-world JS context (injected via
// chrome.scripting.executeScript with world: "MAIN"). From here we can
// reach globals the isolated content script can't touch — most importantly
// Netflix's `window.netflix.appContext.state.playerApp.getAPI().videoPlayer`.
//
// Driving Netflix through its own player API avoids the "extension
// interfering with the player" detection that throws error code S7361 when
// you mutate video.currentTime / call .play() on the raw <video> element.
// The API Teleparty uses is the same one we use here.
//
// Communication with the isolated content script is one-way request / reply
// over window.postMessage. Every request carries an `id` so the content
// script can match responses; we never expose live object references.

(() => {
  if (window.__hiddenTimePageCtx) return;
  window.__hiddenTimePageCtx = true;

  function getNetflixPlayer() {
    try {
      const api = window.netflix
               && window.netflix.appContext
               && window.netflix.appContext.state
               && window.netflix.appContext.state.playerApp
               && window.netflix.appContext.state.playerApp.getAPI
               && window.netflix.appContext.state.playerApp.getAPI().videoPlayer;
      if (!api || typeof api.getAllPlayerSessionIds !== "function") return null;
      const ids = api.getAllPlayerSessionIds();
      if (!ids || !ids.length) return null;
      return api.getVideoPlayerBySessionId(ids[0]);
    } catch (_) {
      return null;
    }
  }

  function respond(id, payload) {
    // Same-origin only — these messages are an internal IPC between this
    // main-world script and the isolated content script. A wildcard target
    // would let any embedded iframe sniff or inject responses.
    window.postMessage(Object.assign({ __ht: "nf-res", id }, payload), window.location.origin);
  }

  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    if (ev.origin !== window.location.origin) return;
    const req = ev.data;
    if (!req || req.__ht !== "nf-cmd") return;

    const player = getNetflixPlayer();
    if (!player) {
      respond(req.id, { ok: false, reason: "no-player" });
      return;
    }

    try {
      switch (req.cmd) {
        case "play":
          player.play();
          if (typeof req.ms === "number") {
            try { player.seek(req.ms); } catch (_) {}
          }
          break;
        case "pause":
          if (typeof req.ms === "number") {
            try { player.seek(req.ms); } catch (_) {}
          }
          player.pause();
          break;
        case "seek":
          if (typeof req.ms === "number") player.seek(req.ms);
          break;
        case "rate":
          if (typeof req.rate === "number" && typeof player.setPlaybackRate === "function") {
            player.setPlaybackRate(req.rate);
          }
          break;
        case "state": {
          const state = {
            time: (typeof player.getCurrentTime === "function" ? player.getCurrentTime() : 0) / 1000,
            duration: (typeof player.getDuration === "function" ? player.getDuration() : 0) / 1000,
            paused: typeof player.isPaused === "function" ? player.isPaused() : undefined,
            rate: typeof player.getPlaybackRate === "function" ? player.getPlaybackRate() : 1
          };
          respond(req.id, { ok: true, state });
          return;
        }
        default:
          respond(req.id, { ok: false, reason: "unknown-cmd" });
          return;
      }
      respond(req.id, { ok: true });
    } catch (e) {
      respond(req.id, { ok: false, reason: String(e && e.message || e) });
    }
  });
})();
