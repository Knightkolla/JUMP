/**
 * Conduit content script.
 *
 * Runs inside supported LLM chat tabs. Responsibilities:
 *   1. Detect which provider we're on and load its adapter.
 *   2. Discover CSS selectors via the self-healing ladder (cache → defaults → stable anchors → LLM).
 *   3. Inject prompts into the chat input and submit them.
 *   4. Detect when the streamed response is done (button-state signal, not text-pause).
 *   5. Capture and return the final assistant message text.
 *   6. Register/unregister with the background service worker.
 */

"use strict";

// ═══════════════════════════════════════════════════════════════
// 1. PROVIDER ADAPTERS
// ═══════════════════════════════════════════════════════════════

const ADAPTERS = {
  chatgpt: {
    id: "chatgpt",
    urlMatch: /(chat\.openai\.com|chatgpt\.com)/,
    defaultSelectors: {
      input: "#prompt-textarea",
      submit: '[data-testid="send-button"]',
      responseContainer: null, // discovered dynamically
      doneSignal: '[data-testid="send-button"]:not([disabled])',
    },
    injectStrategy: "textarea",
  },
  claude: {
    id: "claude",
    urlMatch: /claude\.ai/,
    defaultSelectors: {
      input: '[contenteditable="true"]',
      submit: 'button[aria-label="Send Message"]',
      responseContainer: null,
      doneSignal: 'button[aria-label="Send Message"]:not([disabled])',
    },
    injectStrategy: "contenteditable",
  },
  gemini: {
    id: "gemini",
    urlMatch: /gemini\.google\.com/,
    defaultSelectors: {
      input: ".ql-editor[contenteditable]",
      submit: 'button[aria-label="Send message"]',
      responseContainer: null,
      doneSignal: 'button[aria-label="Send message"]:not([disabled])',
    },
    injectStrategy: "contenteditable",
  },
};

// ═══════════════════════════════════════════════════════════════
// 2. SELF-HEALING SELECTOR ENGINE
// ═══════════════════════════════════════════════════════════════

// In-memory cache: `${providerId}:${role}` → selector string
const selectorCache = {};

// Stable anchor candidates, cheapest/most universal first, per role
const ANCHOR_CANDIDATES = {
  input: [
    "#prompt-textarea",
    '[data-testid*="prompt"]',
    '[data-testid*="input"]',
    'textarea[placeholder]',
    '[role="textbox"]',
    '[contenteditable="true"]',
    ".ql-editor[contenteditable]",
  ],
  submit: [
    '[data-testid="send-button"]',
    '[data-testid="composer-submit-button"]',
    '[data-testid*="send"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label="Send Message"]',
    'button[aria-label="Send message"]',
    'button[aria-label*="Send"]',
    'button[aria-label*="send"]',
    'button[title="Send prompt"]',
    'button[title*="Send"]',
    'button[title*="send"]',
    'form button[type="submit"]',
    '#composer-submit-button',
  ],
  doneSignal: [
    '[data-testid="send-button"]:not([disabled])',
    'button[aria-label="Send Message"]:not([disabled])',
    'button[aria-label="Send message"]:not([disabled])',
    'button[aria-label*="Send"]:not([disabled])',
  ],
};

/**
 * Returns the DOM element if the selector resolves to an element, else null.
 * For the "input" role, also rejects file/checkbox/radio inputs.
 */
function resolveSelector(selector, role) {
  if (!selector) return null;
  try {
    const el = document.querySelector(selector);
    if (!el) return null;
    if (role === "input" && !isEditableInput(el)) return null;
    return el;
  } catch {
    return null;
  }
}

function isEditableInput(el) {
  if (el.tagName === "TEXTAREA") return true;
  if (el.contentEditable === "true") return true;
  if (el.tagName === "INPUT") {
    const t = (el.getAttribute("type") || "text").toLowerCase();
    return ["text", "search", "email", "url", "tel", "number", "password", ""].includes(t);
  }
  return false;
}

/**
 * Self-healing selector discovery.
 * Ladder: cache → adapter defaults → stable anchors → LLM fallback.
 * Returns { selector, element } or null.
 */
async function discoverSelector(adapter, role) {
  const cacheKey = `${adapter.id}:${role}`;

  // ── Step 1: Cache hit ──
  const cached = selectorCache[cacheKey];
  if (cached) {
    const el = resolveSelector(cached, role);
    if (el) return { selector: cached, element: el };
    delete selectorCache[cacheKey];
    console.log(`[Conduit] Cache invalidated for ${cacheKey} (selector broke)`);
  }

  // ── Step 2: Adapter default ──
  const defaultSel = adapter.defaultSelectors[role];
  if (defaultSel) {
    const el = resolveSelector(defaultSel, role);
    if (el) {
      selectorCache[cacheKey] = defaultSel;
      return { selector: defaultSel, element: el };
    }
  }

  // ── Step 3: Stable anchor candidates ──
  const candidates = ANCHOR_CANDIDATES[role] || [];
  for (const sel of candidates) {
    const el = resolveSelector(sel, role);
    if (el) {
      selectorCache[cacheKey] = sel;
      console.log(`[Conduit] Anchor found for ${cacheKey}: ${sel}`);
      return { selector: sel, element: el };
    }
  }

  // ── Step 4: LLM fallback ──
  console.warn(`[Conduit] Falling back to LLM for ${cacheKey}`);
  try {
    const domSnapshot = trimDOM();
    const resp = await fetch("http://localhost:8765/v1/derive-selector", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: adapter.id, role, dom: domSnapshot }),
    });
    if (resp.ok) {
      const { selector } = await resp.json();
      if (selector) {
        const el = resolveSelector(selector, role);
        if (el) {
          selectorCache[cacheKey] = selector;
          console.log(`[Conduit] LLM selector for ${cacheKey}: ${selector}`);
          return { selector, element: el };
        }
      }
    }
  } catch (e) {
    console.warn("[Conduit] LLM fallback request failed:", e.message);
  }

  console.error(`[Conduit] Could not find selector for ${cacheKey}`);
  return null;
}

/** Serialize a trimmed DOM snapshot for LLM consumption (≤8 KB). */
function trimDOM() {
  const clone = document.body.cloneNode(true);
  clone.querySelectorAll("script, style, svg, noscript, link, meta").forEach((n) => n.remove());
  // Remove deeply invisible subtrees
  clone.querySelectorAll("[aria-hidden='true']").forEach((n) => n.remove());
  return clone.innerHTML.replace(/\s{2,}/g, " ").slice(0, 8000);
}

// ═══════════════════════════════════════════════════════════════
// 3. PROMPT INJECTION  (delegates to injector.js in MAIN world)
// ═══════════════════════════════════════════════════════════════

function mainWorldCall(eventName, resultEvent, detail, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const requestId = Math.random().toString(36).slice(2);
    const timer = setTimeout(() => {
      document.removeEventListener(resultEvent, handler);
      reject(new Error(`${eventName} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    function handler(ev) {
      if (ev.detail.requestId !== requestId) return;
      document.removeEventListener(resultEvent, handler);
      clearTimeout(timer);
      resolve(ev.detail);
    }

    document.addEventListener(resultEvent, handler);
    document.dispatchEvent(new CustomEvent(eventName, { detail: { requestId, ...detail } }));
  });
}

async function injectPrompt(adapter, promptText) {
  const found = await discoverSelector(adapter, "input");
  if (!found) throw new Error("Cannot locate the chat input element.");

  console.log(`[Conduit] Injecting into selector: ${found.selector}`);

  const result = await mainWorldCall(
    "conduit:inject",
    "conduit:inject:result",
    { selector: found.selector, text: promptText }
  );

  console.log(`[Conduit] Inject result from MAIN world: ok=${result.ok}, method=${result.method}, error=${result.error}`);

  if (!result.ok) {
    throw new Error(result.error || "Injection failed in MAIN world");
  }
}

const SEND_BUTTON_SELECTORS = [
  '[data-testid="send-button"]',
  '[data-testid="composer-submit-button"]',
  'button[aria-label="Send prompt"]',
  'button[aria-label="Send Message"]',
  'button[aria-label="Send message"]',
  'button[aria-label*="Send"]',
  'button[title*="Send"]',
  'form button[type="submit"]',
];

async function waitForEnabledSendButton(timeoutMs = 4000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    for (const sel of SEND_BUTTON_SELECTORS) {
      const btn = document.querySelector(sel);
      if (btn && !btn.disabled && !btn.hasAttribute("disabled") && btn.getAttribute("aria-disabled") !== "true") {
        return sel;
      }
    }
    await sleep(150);
  }
  return null;
}

async function submitPrompt(adapter) {
  const inputFound = await discoverSelector(adapter, "input");

  // Poll until the send button is enabled (React must process the injection first)
  console.log("[Conduit] Waiting for send button to become enabled...");
  const enabledSel = await waitForEnabledSendButton(4000);
  if (enabledSel) {
    console.log(`[Conduit] Send button ready: ${enabledSel}`);
  } else {
    console.warn("[Conduit] Send button NOT enabled after 4s — injection may have failed. Will try Enter key.");
    await sleep(300);
  }

  const result = await mainWorldCall(
    "conduit:submit",
    "conduit:submit:result",
    { inputSelector: inputFound?.selector || null }
  );

  console.log(`[Conduit] Submit result: method=${result.method}, ok=${result.ok}, html=${result.html}`);
}

// ═══════════════════════════════════════════════════════════════
// 4. DONE-SIGNAL DETECTION (button-state, not text-pause)
// ═══════════════════════════════════════════════════════════════

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Polls for the "send button re-enabled" done signal.
 *
 * Flow:
 *   Phase 1 (up to 15 s): wait for generation to START (handles SPA navigation delay).
 *   Phase 2 (up to timeoutMs): wait for generation to FINISH (send btn enabled, stop btn gone).
 *
 * The text-stable heuristic is NOT used because streaming has pauses that trigger false positives.
 */
async function waitForDone(msgsBefore = 0, timeoutMs = 120_000) {
  const started = Date.now();

  // ── Phase 1: wait for generation to START (up to 15 s handles SPA navigation) ──
  const phase1End = Date.now() + 15_000;
  let generationStarted = false;
  while (!generationStarted && Date.now() < phase1End) {
    await sleep(300);
    if (generationIsActive()) generationStarted = true;
  }
  if (!generationStarted) {
    console.warn("[Conduit] Phase 1 timeout: proceeding to Phase 2");
  } else {
    console.log("[Conduit] Phase 1 done: generation is active");
  }

  // ── Phase 2: wait for generation to stop ──
  return new Promise((resolve, reject) => {
    let settled = false;
    let pollCount = 0;

    const interval = setInterval(async () => {
      if (settled) { clearInterval(interval); return; }

      if (Date.now() - started > timeoutMs) {
        clearInterval(interval);
        settled = true;
        reject(new Error(`Timeout after ${timeoutMs / 1000}s`));
        return;
      }

      const active = generationIsActive();
      pollCount++;
      if (pollCount % 6 === 0) {
        console.log(`[Conduit] poll #${pollCount}: active=${active}, url=${window.location.pathname}`);
      }

      if (!active) {
        // Lock before yielding so no other interval tick re-enters
        settled = true;
        clearInterval(interval);
        // Grace period: let the last tokens render to the DOM
        await sleep(1500);
        // Try to capture; if empty, wait a bit more and retry once
        let captured = captureResponse(msgsBefore);
        if (!captured) {
          console.warn("[Conduit] captureResponse empty on first try, retrying in 2s...");
          await sleep(2000);
          captured = captureResponse(msgsBefore);
        }
        console.log(`[Conduit] captureResponse: ${captured.length} chars`);
        resolve(captured);
      }
    }, 500);
  });
}

/**
 * Returns true when the LLM is actively generating (send button disabled or stop-btn visible).
 */
function generationIsActive() {
  const stopBtn =
    document.querySelector('[aria-label="Stop generating"]') ||
    document.querySelector('[aria-label="Stop streaming"]') ||
    document.querySelector('[data-testid="stop-button"]') ||
    document.querySelector('[data-testid="stop-streaming-button"]') ||
    document.querySelector('[aria-label="Stop"]');

  if (stopBtn) return true;

  const sendDisabled =
    document.querySelector('[data-testid="send-button"][disabled]') ||
    document.querySelector('[data-testid="send-button"][aria-disabled="true"]') ||
    document.querySelector('button[aria-label="Send prompt"][disabled]') ||
    document.querySelector('button[aria-label="Send Message"][disabled]') ||
    document.querySelector('button[aria-label="Send message"][disabled]') ||
    document.querySelector('button[aria-label*="Send"][disabled]');

  return !!sendDisabled;
}

// ═══════════════════════════════════════════════════════════════
// 5. RESPONSE CAPTURE
// ═══════════════════════════════════════════════════════════════

/**
 * Extracts the last assistant message text from the page.
 * Tries provider-specific selectors first, then falls back to generics.
 */
function captureResponse(msgsBefore = 0) {
  const strategies = [
    // ChatGPT: prefer the .markdown prose div inside the new assistant message
    // (avoids web-search cards, citations, knowledge panels that pollute innerText)
    () => {
      const msgs = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
      const newMsgs = msgs.slice(msgsBefore);
      if (!newMsgs.length) return;
      const last = newMsgs[newMsgs.length - 1];
      const prose =
        last.querySelector('.markdown') ||
        last.querySelector('[class*="prose"]') ||
        last.querySelector('[data-message-content-type="text"]');
      if (prose) return text(prose);
      // Fallback: strip non-prose children (search cards, buttons, footnotes)
      const clone = last.cloneNode(true);
      clone.querySelectorAll('button, [data-testid*="source"], [class*="citation"], [class*="footnote"], ol[start]').forEach(n => n.remove());
      return text(clone);
    },
    // ChatGPT: .markdown elements (each assistant msg typically has one)
    () => {
      const all = Array.from(document.querySelectorAll('.markdown'));
      if (all.length > msgsBefore) return text(all[all.length - 1]);
    },
    // ChatGPT: conversation turn containing an assistant role
    () => {
      const turns = document.querySelectorAll('[data-testid^="conversation-turn"]');
      for (let i = turns.length - 1; i >= 0; i--) {
        const turn = turns[i];
        if (!turn.querySelector('[data-message-author-role="assistant"]')) continue;
        const prose = turn.querySelector('.markdown, [class*="prose"]');
        return text(prose || turn);
      }
    },
    // Claude: .font-claude-message
    () => {
      const msgs = document.querySelectorAll('.font-claude-message');
      if (msgs.length) return text(msgs[msgs.length - 1]);
    },
    // Claude: generic selectors
    () => {
      const msgs = document.querySelectorAll('[data-is-streaming], .claude-message, [class*="claude-message"]');
      if (msgs.length) return text(msgs[msgs.length - 1]);
    },
    // Gemini: model-response web component
    () => {
      const msgs = document.querySelectorAll('model-response');
      if (msgs.length) return text(msgs[msgs.length - 1]);
    },
    // Gemini: response-container
    () => {
      const msgs = document.querySelectorAll('.response-container, [class*="response-container"]');
      if (msgs.length) return text(msgs[msgs.length - 1]);
    },
    // Generic: role=article, skip user turns
    () => {
      const articles = document.querySelectorAll('[role="article"]');
      for (let i = articles.length - 1; i >= 0; i--) {
        const a = articles[i];
        if (a.querySelector('[data-message-author-role="user"]')) continue;
        const t = text(a);
        if (t.length > 10) return t;
      }
    },
  ];

  for (let i = 0; i < strategies.length; i++) {
    try {
      const t = strategies[i]();
      console.log(`[Conduit] captureResponse strategy ${i}: "${(t || "").slice(0, 80)}"`);
      if (t && t.trim().length > 0) return t.trim();
    } catch (e) {
      console.log(`[Conduit] captureResponse strategy ${i} error: ${e.message}`);
    }
  }

  return "";
}

function text(el) {
  return (el?.innerText || el?.textContent || "").trim();
}

// ═══════════════════════════════════════════════════════════════
// 6. PROMPT HANDLER WITH SIMPLE SERIAL QUEUE
// ═══════════════════════════════════════════════════════════════

let inFlight = false;
const promptQueue = [];

function enqueue(item) {
  promptQueue.push(item);
  drain();
}

function drain() {
  if (inFlight || promptQueue.length === 0) return;
  inFlight = true;
  const { id, text: promptText } = promptQueue.shift();

  handlePrompt(id, promptText).finally(() => {
    inFlight = false;
    drain();
  });
}

async function handlePrompt(id, promptText) {
  try {
    // Snapshot existing assistant messages so we only capture the NEW reply
    const msgsBefore = document.querySelectorAll('[data-message-author-role="assistant"]').length;
    console.log(`[Conduit] msgsBefore=${msgsBefore}, starting inject`);

    await injectPrompt(adapter, promptText);
    await submitPrompt(adapter);

    chrome.runtime.sendMessage({ type: "injected", id });

    const responseText = await waitForDone(msgsBefore);

    if (!responseText) {
      throw new Error("Response captured was empty — the page may not have generated a reply.");
    }

    chrome.runtime.sendMessage({ type: "response", id, text: responseText });
    console.log(`[Conduit] Request ${id} complete (${responseText.length} chars)`);
  } catch (err) {
    console.error(`[Conduit] Request ${id} failed:`, err.message);
    chrome.runtime.sendMessage({ type: "error", id, reason: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════
// 7. INITIALISATION
// ═══════════════════════════════════════════════════════════════

const adapter = (() => {
  const url = window.location.href;
  for (const a of Object.values(ADAPTERS)) {
    if (a.urlMatch.test(url)) return a;
  }
  return null;
})();

if (!adapter) {
  // Not a supported LLM site; script is a no-op
} else {
  console.log(`[Conduit] Detected provider: ${adapter.id}`);

  async function init() {
    // Warm the selector cache (best-effort; failures are fine here)
    await discoverSelector(adapter, "input").catch(() => {});

    chrome.runtime.sendMessage({ type: "register", provider: adapter.id }, () => {
      if (chrome.runtime.lastError) {
        console.warn("[Conduit] Registration failed:", chrome.runtime.lastError.message);
      } else {
        console.log(`[Conduit] Registered as "${adapter.id}"`);
      }
    });
  }

  // Listen for prompts from the background
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "prompt") {
      enqueue({ id: msg.id, text: msg.text });
      sendResponse({ ok: true });
    }
    return true;
  });

  // Unregister when the tab navigates away
  window.addEventListener("beforeunload", () => {
    chrome.runtime.sendMessage({ type: "unregister", provider: adapter.id });
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
}
