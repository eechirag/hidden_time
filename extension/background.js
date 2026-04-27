// Service worker — opens Hidden Time as a side panel (so the streaming tab
// reflows alongside it instead of the popup floating on top) and routes
// messages between content scripts and the panel.

chrome.runtime.onInstalled.addListener(() => {
  // Clicking the toolbar icon opens the side panel in the current window.
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});
});

// Fallback: explicit open in case setPanelBehavior didn't latch
// (e.g. first install, or an older Chrome where the pref hasn't taken yet).
chrome.action.onClicked.addListener(async (tab) => {
  if (chrome.sidePanel && tab && tab.windowId !== undefined) {
    try { await chrome.sidePanel.open({ windowId: tab.windowId }); } catch (_) {}
  }
});

// Which tab the side panel is currently "watching" for video sync.
// Backed by chrome.storage.session so a service-worker suspension (MV3 puts
// the SW to sleep after ~30 s of idle) doesn't wipe it. The in-memory copy
// is a fast path; on a cold SW wake we rehydrate from storage before routing.
let watchingTabId = null;
let watchingTabLoaded = false;

function loadWatchingTab() {
  if (watchingTabLoaded) return Promise.resolve(watchingTabId);
  return new Promise((resolve) => {
    try {
      chrome.storage.session.get(["watchingTabId"], (res) => {
        watchingTabLoaded = true;
        if (!chrome.runtime.lastError && res && typeof res.watchingTabId === "number") {
          watchingTabId = res.watchingTabId;
        }
        resolve(watchingTabId);
      });
    } catch (_) {
      watchingTabLoaded = true;
      resolve(watchingTabId);
    }
  });
}
loadWatchingTab();

function setWatchingTab(tabId) {
  watchingTabId = tabId;
  watchingTabLoaded = true;
  try {
    if (tabId === null || tabId === undefined) {
      chrome.storage.session.remove("watchingTabId", () => void chrome.runtime.lastError);
    } else {
      chrome.storage.session.set({ watchingTabId: tabId }, () => void chrome.runtime.lastError);
    }
  } catch (_) {}
}

// If the watched tab goes away, clear the persisted id so a stale number
// doesn't outlive the tab across SW restarts.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (watchingTabId === tabId) setWatchingTab(null);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case "HT_SET_WATCHING_TAB":
      setWatchingTab(msg.tabId);
      sendResponse({ ok: true });
      break;

    case "HT_LIST_VIDEO_TABS":
      chrome.tabs.query({}, (tabs) => {
        const candidates = tabs.filter((t) => t.url && isStreamingUrl(t.url));
        sendResponse({ tabs: candidates });
      });
      return true;

    // Side panel -> content script on the watched tab. Kept for backwards
    // compatibility; the side panel now sends direct chrome.tabs.sendMessage
    // so SW suspension can't drop the action. Routes via storage-hydrated id
    // when used.
    case "HT_TO_CONTENT":
      loadWatchingTab().then((id) => {
        if (id !== null && id !== undefined) {
          chrome.tabs.sendMessage(id, msg.payload, () => void chrome.runtime.lastError);
        }
        sendResponse({ ok: true });
      });
      return true;

    // Content script -> every extension page (the side panel picks it up).
    case "HT_FROM_CONTENT":
      chrome.runtime.sendMessage(
        {
          type: "HT_CONTENT_EVENT",
          payload: msg.payload,
          fromTabId: sender.tab ? sender.tab.id : null
        },
        () => void chrome.runtime.lastError
      );
      break;

    // Content script asks us to inject page-context.js into the page's main
    // world. Content scripts can't do this directly — chrome.scripting with
    // world: "MAIN" is privileged and lives in the service worker.
    case "HT_INJECT_PAGE_CTX":
      if (sender.tab && sender.tab.id !== undefined) {
        chrome.scripting
          .executeScript({
            target: { tabId: sender.tab.id },
            world: "MAIN",
            files: ["page-context.js"]
          })
          .catch((e) => console.warn("HT page-context inject failed:", e && e.message));
      }
      break;
  }
});

function isStreamingUrl(url) {
  if (!url) return false;
  if (/^https:\/\/(?:[a-z0-9-]+\.)?(?:netflix|youtube|sonyliv|zee5|hotstar|jiocinema|jiohotstar|primevideo)\.com\//i.test(url)) return true;
  if (/^https:\/\/www\.amazon\.(?:com|in|co\.uk)\/gp\/video\//i.test(url)) return true;
  return false;
}
