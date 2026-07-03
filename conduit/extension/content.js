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
      webSearch: 'button[aria-label*="Search"], button[aria-label="Search the web"], button[data-testid*="search"]',
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
  webSearch: [
    'button[aria-label*="Search"]',
    'button[aria-label="Search the web"]',
    'button[data-testid*="search"]',
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

  // ── Step 4: LLM calibration fallback ──
  // One call returns ALL selectors for the page (faster than per-role requests).
  console.warn(`[Conduit] Falling back to LLM calibration for ${cacheKey}`);
  try {
    const domain = window.location.hostname;

    // 4a. Check chrome.storage.local for a previously cached full calibration
    let selSet = null;
    try {
      const stored = await chrome.storage.local.get(domain);
      if (stored[domain]?.selectors) {
        selSet = stored[domain].selectors;
        console.log(`[Conduit] Using stored calibration for ${domain}`);
      }
    } catch (e) {
      console.warn("[Conduit] Failed to read storage:", e.message);
    }

    // 4b. Run fresh calibration if nothing cached
    if (!selSet) {
      selSet = await runCalibration(domain);
      chrome.storage.local.set({ [domain]: { selectors: selSet, calibrated_at: Date.now() } })
        .catch(() => {});
    }

    // Populate in-memory cache for all roles at once
    populateCacheFromCalibration(adapter.id, selSet);

    const selector = selectorFromCalibration(selSet, role);
    if (selector) {
      const el = resolveSelector(selector, role);
      if (el) {
        selectorCache[cacheKey] = selector;
        console.log(`[Conduit] Calibrated selector for ${cacheKey}: ${selector}`);
        return { selector, element: el };
      }
    }
  } catch (e) {
    console.warn("[Conduit] Calibration fallback failed:", e.message);
  }

  console.error(`[Conduit] Could not find selector for ${cacheKey}`);
  return null;
}

// Tags stripped entirely during DOM compression
const _STRIP_TAGS = new Set(["SCRIPT","STYLE","SVG","LINK","META","NOSCRIPT","IFRAME","NAV","ASIDE"]);
// Attributes preserved during compression
const _KEEP_ATTRS = ["id","class","role","aria-label","placeholder","type","contenteditable","data-testid","name"];

/**
 * Walk the DOM and produce a compact semantic snapshot for LLM calibration.
 * Much more structured than innerHTML slicing — strips noise, keeps only
 * meaningful attributes, limits depth and total size.
 */
function compressDom(root = document.body, maxDepth = 45, maxChars = 80000) {
  const lines = [];
  let charCount = 0;
  let truncated = false;

  function walk(node, depth) {
    if (truncated || charCount >= maxChars || depth > maxDepth) { truncated = true; return; }

    if (node.nodeType === Node.TEXT_NODE) {
      const t = (node.textContent || "").trim();
      if (t) {
        const line = "  ".repeat(depth) + `"${t.length > 50 ? t.slice(0, 47) + "..." : t}"`;
        lines.push(line); charCount += line.length + 1;
      }
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node;
    if (_STRIP_TAGS.has(el.tagName)) return;

    let desc = el.tagName.toLowerCase();
    for (const attr of _KEEP_ATTRS) {
      const val = el.getAttribute(attr);
      if (!val) continue;
      if (attr === "id") desc += `#${val}`;
      else if (attr === "class") {
        const cls = val.trim().split(/\s+/).slice(0, 2).join(".");
        if (cls) desc += `.${cls}`;
      } else {
        desc += `[${attr}="${val.length > 30 ? val.slice(0, 27) + "..." : val}"]`;
      }
    }

    const line = "  ".repeat(depth) + desc;
    lines.push(line); charCount += line.length + 1;
    for (const child of el.childNodes) { if (truncated) break; walk(child, depth + 1); }
  }

  walk(root, 0);
  if (truncated) lines.push("... (truncated)");
  return lines.join("\n");
}

/**
 * Send the page's DOM snapshot to the backend for LLM calibration.
 * Returns a full SelectorSet: input, send, response container, indicator.
 */
async function runCalibration(domain) {
  console.log(`[Conduit] Running LLM calibration for ${domain}…`);
  const dom_snapshot = compressDom();
  console.log(`[Conduit] DOM snapshot: ${dom_snapshot.length} chars`);

  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "calibrate_request", domain, dom_snapshot }, (resp) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (resp?.ok && resp.selectors) resolve(resp.selectors);
      else reject(new Error(resp?.error || "Calibration failed"));
    });
  });
}

/** Map a calibrated SelectorSet to the selector for a given role. */
function selectorFromCalibration(selSet, role) {
  if (!selSet) return null;
  switch (role) {
    case "input":      return selSet.input_selector || null;
    case "submit":     return selSet.send_mechanism?.selector || null;
    case "doneSignal": return selSet.generating_indicator_selector || null;
    default:           return null;
  }
}

/** Populate the in-memory selectorCache from a calibrated SelectorSet. */
function populateCacheFromCalibration(adapterId, selSet) {
  if (!selSet) return;
  const map = {
    input:      selSet.input_selector,
    submit:     selSet.send_mechanism?.selector,
    doneSignal: selSet.generating_indicator_selector,
  };
  for (const [role, sel] of Object.entries(map)) {
    if (sel) selectorCache[`${adapterId}:${role}`] = sel;
  }
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
 * Waits for the LLM to finish generating and returns the captured response text.
 *
 * Phase 1 (≤15 s): poll until generationIsActive() = true (handles SPA navigation).
 * Phase 2: MutationObserver on document.body — reacts to DOM changes instantly
 *   instead of polling every 500 ms. On each mutation we check generationIsActive():
 *   when it returns false the stop button is gone and we capture immediately.
 *   An idle fallback fires if DOM goes quiet for 2 s without us detecting done.
 */
async function waitForDone(msgsBefore = 0, timeoutMs = 120_000) {
  const started = Date.now();

  // ── Phase 1: wait for generation to START (up to 15 s) ──
  const phase1End = started + 15_000;
  let generationStarted = false;
  while (!generationStarted && Date.now() < phase1End) {
    await sleep(200);
    if (generationIsActive()) generationStarted = true;
  }
  if (!generationStarted) {
    console.warn("[Conduit] Phase 1 timeout: proceeding to Phase 2");
  } else {
    console.log("[Conduit] Phase 1 done: generation is active");
  }

  // ── Phase 2: MutationObserver-based done detection ──
  return new Promise((resolve, reject) => {
    let settled = false;
    let idleTimer = null;

    async function finish(reason) {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      observer.disconnect();
      clearTimeout(safetyTimer);

      // Short grace period for the last tokens to render
      await sleep(800);
      let captured = captureResponse(msgsBefore);
      if (!captured) {
        console.warn("[Conduit] captureResponse empty, retrying in 1.5 s…");
        await sleep(1500);
        captured = captureResponse(msgsBefore);
      }
      console.log(`[Conduit] waitForDone(${reason}): ${captured.length} chars`);
      resolve(captured);
    }

    const remaining = timeoutMs - (Date.now() - started);
    const safetyTimer = setTimeout(() => {
      if (!settled) {
        observer.disconnect();
        reject(new Error(`Timeout after ${timeoutMs / 1000}s`));
      }
    }, remaining);

    function resetIdleTimer() {
      if (idleTimer) clearTimeout(idleTimer);
      // If DOM goes idle for 2 s and generation is done, capture
      idleTimer = setTimeout(() => {
        if (!settled && !generationIsActive()) finish("idle_timeout");
      }, 2000);
    }

    const observer = new MutationObserver(() => {
      if (settled) return;
      if (!generationIsActive()) {
        finish("indicator_gone");
      } else {
        // Still generating — reset idle sentinel
        resetIdleTimer();
      }
    });

    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    // Kick off initial idle timer (handles very fast responses before first mutation)
    resetIdleTimer();

    // If generation already finished during Phase 1 pause, don't wait for a mutation
    if (generationStarted && !generationIsActive()) finish("already_done");
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
    // ChatGPT: conversation turn containing an assistant role (only new turns)
    () => {
      const turns = Array.from(document.querySelectorAll('[data-testid^="conversation-turn"]'));
      const assistantTurns = turns.filter(t => t.querySelector('[data-message-author-role="assistant"]'));
      if (assistantTurns.length <= msgsBefore) return;
      const turn = assistantTurns[assistantTurns.length - 1];
      const prose = turn.querySelector('.markdown, [class*="prose"]');
      return text(prose || turn);
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
    // Generic: role=article, skip user turns (only new assistant articles)
    () => {
      const articles = Array.from(document.querySelectorAll('[role="article"]'));
      const assistantArticles = articles.filter(a => !a.querySelector('[data-message-author-role="user"]'));
      if (assistantArticles.length <= msgsBefore) return;
      const t = text(assistantArticles[assistantArticles.length - 1]);
      if (t.length > 10) return t;
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
  if (!el) return "";
  const a = (el.innerText || "").trim();
  if (a) return a;
  // innerText is layout-dependent and returns "" in background tabs;
  // textContent is layout-independent and always works.
  const clone = el.cloneNode(true);
  clone.querySelectorAll("script, style, noscript").forEach(n => n.remove());
  return (clone.textContent || "").trim();
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

async function toggleWebSearch(adapter, enable) {
  const found = await discoverSelector(adapter, "webSearch");
  if (!found) {
    console.warn("[Conduit] Web search button selector not found.");
    return;
  }
  const btn = found.element;
  const isPressed = btn.getAttribute("aria-pressed") === "true" ||
                    btn.classList.contains("active") ||
                    btn.getAttribute("aria-checked") === "true";
  
  if (enable !== isPressed) {
    console.log(`[Conduit] Toggling web search to: ${enable}`);
    btn.click();
    await sleep(600); // Give react state time to propagate/render
  } else {
    console.log(`[Conduit] Web search already in desired state: ${isPressed}`);
  }
}

/**
 * querySelectorAll that recursively pierces shadow roots.
 * Needed for Gemini's web components (model-response → img-gen-response → img).
 */
function querySelectorAllDeep(root, selector) {
  const results = [];
  function search(el) {
    try {
      results.push(...Array.from(el.querySelectorAll(selector)));
      el.querySelectorAll("*").forEach((child) => {
        if (child.shadowRoot) search(child.shadowRoot);
      });
    } catch (_) {}
  }
  search(root);
  return results;
}

function fetchImageViaBackground(url) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "fetchImage", url }, (resp) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (resp?.ok) resolve(resp.dataUrl);
      else reject(new Error(resp?.error || "fetchImage failed"));
    });
  });
}

/**
 * Fetch any image URL and return a base64 data URL.
 *
 * blob: → delegate to injector.js (MAIN world) via CustomEvent bridge.
 *          Blob URLs are owned by the page's MAIN world JS context;
 *          the isolated-world content script cannot fetch them at all.
 * data: → already encoded, return as-is.
 * https: → route through background SW to bypass CORS.
 */
async function fetchImageAsDataUrl(url) {
  if (url.startsWith("data:")) return url;

  if (url.startsWith("blob:")) {
    console.log(`[Conduit] Fetching blob via MAIN world: ${url.slice(0, 70)}`);
    const result = await mainWorldCall(
      "conduit:fetchBlob", "conduit:fetchBlob:result", { url }, 30_000
    );
    if (!result.ok) throw new Error(result.error || "MAIN world blob fetch failed");
    return result.dataUrl;
  }

  return fetchImageViaBackground(url);
}

/**
 * Snapshot every <img> src currently on the page (including inside shadow DOM).
 * Called BEFORE injection so we can diff afterwards to find only NEW images.
 */
function snapshotImageSrcs() {
  const srcs = new Set();
  querySelectorAllDeep(document.body, "img").forEach((img) => {
    const url = img.currentSrc || img.src;
    if (url && url !== window.location.href) srcs.add(url);
  });
  return srcs;
}

/**
 * Find images that appeared AFTER the snapshot — independent of container
 * selectors, class names, or shadow-root depth. Works even if the page
 * structure changes completely between Gemini / ChatGPT / Claude updates.
 */
function findImageCandidates(imgSrcsBefore) {
  const allImgs = querySelectorAllDeep(document.body, "img");

  return allImgs.filter((img) => {
    // Use currentSrc (resolves srcset/lazy) over src; both may be blob: URLs
    const src = img.currentSrc || img.src;
    if (!src || src === window.location.href) return false;

    // Attach the resolved src so callers can use img._resolvedSrc
    img._resolvedSrc = src;

    // Skip anything that was already on the page before we sent the prompt
    if (imgSrcsBefore.has(src)) return false;

    // Skip avatars — check the img element itself, not ancestors
    const isAvatar = img.classList.contains("avatar") ||
                     /avatar|profile|user/i.test(img.alt || "") ||
                     /avatar|profile|user/i.test(img.className || "");
    if (isAvatar) return false;

    // Accept if size unknown (not loaded yet) or >= 120 px
    return (img.naturalWidth === 0 || img.naturalWidth >= 120) &&
           (img.width === 0 || img.width >= 120);
  });
}

async function captureImages(imgSrcsBefore, pollForLateImages = false) {
  await sleep(600);

  let candidates = findImageCandidates(imgSrcsBefore);

  // Two-phase generation (e.g. Gemini Imagen): text done signal fires before
  // the image renders. Poll up to 20s when the response text was very short.
  if (candidates.length === 0 && pollForLateImages) {
    console.log("[Conduit] No new images yet — polling up to 20s for late-rendering images…");
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      await sleep(500);
      candidates = findImageCandidates(imgSrcsBefore);
      if (candidates.length > 0) {
        console.log(`[Conduit] New image appeared. Encoding…`);
        break;
      }
    }
  }

  const base64Images = [];
  for (const img of candidates) {
    const url = img._resolvedSrc || img.currentSrc || img.src;
    try {
      console.log(`[Conduit] Fetching: ${url.slice(0, 80)}`);
      const dataUrl = await fetchImageAsDataUrl(url);
      base64Images.push(dataUrl);
      console.log(`[Conduit] Encoded. Size: ${dataUrl.length} chars`);
    } catch (e) {
      console.warn(`[Conduit] Failed: ${url.slice(0, 80)} — ${e.message}`);
    }
  }
  return base64Images;
}

function drain() {
  if (inFlight || promptQueue.length === 0) return;
  inFlight = true;
  const { id, text: promptText, web_search, timeout } = promptQueue.shift();

  handlePrompt(id, promptText, web_search, timeout).finally(() => {
    inFlight = false;
    drain();
  });
}

async function handlePrompt(id, promptText, web_search, timeout) {
  try {
    // Snapshot state BEFORE injection so we can diff afterwards
    const msgsBefore = document.querySelectorAll('[data-message-author-role="assistant"]').length;
    const imgSrcsBefore = snapshotImageSrcs();
    console.log(`[Conduit] msgsBefore=${msgsBefore}, imgSrcsBefore=${imgSrcsBefore.size}`);

    // Toggle web search if requested
    await toggleWebSearch(adapter, !!web_search);

    await injectPrompt(adapter, promptText);
    await submitPrompt(adapter);

    chrome.runtime.sendMessage({ type: "injected", id });

    // Use custom timeout if provided by the backend, else 120s
    const timeoutMs = timeout ? timeout * 1000 : 120_000;
    const responseText = await waitForDone(msgsBefore, timeoutMs);
    // Short response (<= 200 chars) likely means image generation — poll for
    // the image that renders after the text phase (Gemini two-phase generation)
    const pollForLateImages = responseText.length <= 500;
    const images = await captureImages(imgSrcsBefore, pollForLateImages);

    if (!responseText && images.length === 0) {
      throw new Error("Response captured was empty — the page may not have generated a reply.");
    }

    chrome.runtime.sendMessage({ type: "response", id, text: responseText, images });
    console.log(`[Conduit] Request ${id} complete (${responseText.length} chars, ${images.length} images)`);
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
      enqueue({ id: msg.id, text: msg.text, web_search: msg.web_search, timeout: msg.timeout });
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
