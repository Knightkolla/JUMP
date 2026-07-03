/**
 * Conduit background service worker.
 *
 * Owns the single WebSocket connection to the FastAPI backend.
 * Routes:  backend → extension → content script  (prompt delivery)
 *          content script → extension → backend   (injected / response / error)
 *
 * MV3 note: service workers are ephemeral (killed after ~30 s of inactivity).
 *   • chrome.alarms fires every ~24 s to keep the SW alive.
 *   • chrome.storage.session persists the provider→tab map across SW restarts.
 */

const BACKEND_WS_URL = "ws://localhost:8765/ws";
const KEEPALIVE_ALARM = "conduit-keepalive";

let ws = null;

// In-memory mirrors of chrome.storage.session (rebuilt on each SW wake)
// provider id  →  tab id
const providerToTab = {};
// tab id (number)  →  provider id
const tabToProvider = {};

// ─────────────────────────── Storage helpers ───────────────────────────

async function saveProviderMap() {
  await chrome.storage.session.set({ providerToTab });
}

async function loadProviderMap() {
  const stored = await chrome.storage.session.get("providerToTab");
  const map = stored.providerToTab || {};
  for (const [provider, tabId] of Object.entries(map)) {
    providerToTab[provider] = tabId;
    tabToProvider[tabId] = provider;
  }
}

// ─────────────────────────── WebSocket lifecycle ───────────────────────────

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  console.log("[Conduit bg] Connecting to backend…");
  ws = new WebSocket(BACKEND_WS_URL);

  ws.onopen = () => {
    console.log("[Conduit bg] Connected to backend");
    // Re-announce every provider we know about (handles SW restart + reconnect)
    for (const provider of Object.keys(providerToTab)) {
      wsSend({ type: "status", provider, ready: true });
    }
  };

  ws.onmessage = ({ data }) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    if (msg.type === "prompt") {
      routePromptToTab(msg);
    } else if (msg.type === "ping") {
      wsSend({ type: "pong" });
    }
  };

  ws.onerror = (e) => console.error("[Conduit bg] WebSocket error", e);

  ws.onclose = () => {
    console.warn("[Conduit bg] WebSocket closed – retrying in 3 s");
    ws = null;
    setTimeout(connect, 3_000);
  };
}

function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// ─────────────────────────── Prompt routing ───────────────────────────

function routePromptToTab(msg) {
  const { id, provider, text } = msg;
  const tabId = providerToTab[provider];

  if (!tabId) {
    wsSend({ type: "error", id, reason: `No tab registered for provider "${provider}"` });
    return;
  }

  chrome.tabs.sendMessage(tabId, { type: "prompt", id, text }, (response) => {
    if (chrome.runtime.lastError) {
      const reason = chrome.runtime.lastError.message || "content script unreachable";
      console.error("[Conduit bg] sendMessage error:", reason);
      wsSend({ type: "error", id, reason });
    }
  });
}

// ─────────────────────────── Messages from content scripts ───────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  switch (msg.type) {
    case "register": {
      const { provider } = msg;
      if (!provider || tabId == null) { sendResponse({ ok: false }); return true; }

      // Deregister any previous tab for this provider
      const oldTab = providerToTab[provider];
      if (oldTab && oldTab !== tabId) delete tabToProvider[oldTab];

      providerToTab[provider] = tabId;
      tabToProvider[tabId] = provider;
      saveProviderMap();
      wsSend({ type: "status", provider, ready: true });
      console.log(`[Conduit bg] Registered provider "${provider}" in tab ${tabId}`);
      sendResponse({ ok: true });
      break;
    }

    case "unregister": {
      const provider = tabToProvider[tabId];
      if (provider) {
        delete providerToTab[provider];
        delete tabToProvider[tabId];
        saveProviderMap();
        wsSend({ type: "status", provider, ready: false });
        console.log(`[Conduit bg] Unregistered "${provider}" (tab ${tabId})`);
      }
      sendResponse({ ok: true });
      break;
    }

    case "injected":
    case "response":
    case "error":
      wsSend(msg);
      sendResponse({ ok: true });
      break;

    case "getStatus":
      sendResponse({
        connected: ws?.readyState === WebSocket.OPEN,
        providers: Object.keys(providerToTab),
      });
      break;

    default:
      sendResponse({ ok: false, reason: "unknown message type" });
  }

  return true;
});

// ─────────────────────────── Tab cleanup ───────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  const provider = tabToProvider[tabId];
  if (provider) {
    delete providerToTab[provider];
    delete tabToProvider[tabId];
    saveProviderMap();
    wsSend({ type: "status", provider, ready: false });
    console.log(`[Conduit bg] Tab ${tabId} closed, unregistered "${provider}"`);
  }
});

// ─────────────────────────── Keepalive (MV3 service worker stays alive) ───────────────────────────

chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 }); // ~24 s

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  if (ws?.readyState === WebSocket.OPEN) {
    wsSend({ type: "ping" });
  } else {
    connect();
  }
});

// ─────────────────────────── Boot ───────────────────────────

(async () => {
  await loadProviderMap();
  connect();
})();
