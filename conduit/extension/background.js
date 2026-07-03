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
const BACKEND_HTTP_URL = "http://localhost:8765";
const KEEPALIVE_ALARM = "conduit-keepalive";

let ws = null;
let reconnectDelay = 1_000;
const RECONNECT_MAX = 30_000;

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
    reconnectDelay = 1_000; // reset backoff on successful connect
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
    console.warn(`[Conduit bg] WebSocket closed – retrying in ${reconnectDelay}ms`);
    ws = null;
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX);
  };
}

function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// ─────────────────────────── Prompt routing ───────────────────────────

function routePromptToTab(msg) {
  const { id, provider, text, web_search, timeout } = msg;
  const tabId = providerToTab[provider];

  if (!tabId) {
    wsSend({ type: "error", id, reason: `No tab registered for provider "${provider}"` });
    return;
  }

  chrome.tabs.sendMessage(tabId, { type: "prompt", id, text, web_search, timeout }, (response) => {
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

    case "calibrate_request": {
      // Route DOM calibration through the SW so the LLM API key stays server-side.
      const { domain, dom_snapshot } = msg;
      fetch(`${BACKEND_HTTP_URL}/v1/calibrate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain, dom_snapshot }),
      })
        .then(async (res) => {
          if (!res.ok) {
            const err = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }));
            throw new Error(err.detail || `HTTP ${res.status}`);
          }
          return res.json();
        })
        .then((result) => {
          console.log(`[Conduit bg] Calibration succeeded for domain=${domain}`);
          sendResponse({ ok: true, selectors: result.selectors });
        })
        .catch((err) => {
          console.error(`[Conduit bg] Calibration failed for domain=${domain}:`, err.message);
          sendResponse({ ok: false, error: err.message });
        });
      return true; // async response
    }

    case "fetchImage": {
      // Fetch images from the SW where cross-origin requests bypass CORS.
      // FileReader is unavailable in SW; convert ArrayBuffer → base64 manually.
      (async () => {
        try {
          const resp = await fetch(msg.url);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const buf = await resp.arrayBuffer();
          const bytes = new Uint8Array(buf);
          const contentType = resp.headers.get("content-type") || "image/png";
          let binary = "";
          for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
          sendResponse({ ok: true, dataUrl: `data:${contentType};base64,${btoa(binary)}` });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
      })();
      break;
    }

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
