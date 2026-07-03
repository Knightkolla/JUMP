/**
 * Conduit injector — runs in the page's MAIN world.
 *
 * Communicates with content.js (isolated world) via CustomEvents on document.
 */

"use strict";

const SUBMIT_SELECTORS = [
  '[data-testid="send-button"]',
  '[data-testid="composer-submit-button"]',
  '[data-testid*="send"]',
  'button[aria-label="Send prompt"]',
  'button[aria-label="Send Message"]',
  'button[aria-label="Send message"]',
  'button[aria-label*="Send"]',
  'button[aria-label*="send"]',
  'button[aria-label*="Submit"]',
  'button[title*="Send"]',
  'button[title*="send"]',
  'form button[type="submit"]',
  '#composer-submit-button',
];

const SKIP_BTN = /attach|file|image|upload|mic|voice|stop|record|cancel|close|emoji|gif|dictation|search/i;

// ─────────────────────────── Inject ───────────────────────────

document.addEventListener("conduit:inject", async (ev) => {
  const { requestId, selector, text } = ev.detail;
  let ok = false;
  let error = null;
  let method = null;

  try {
    const input = document.querySelector(selector);
    if (!input) throw new Error(`Element not found: ${selector}`);

    console.log(`[Conduit injector] Found input: tag=${input.tagName}, id=${input.id}, type=${input.getAttribute("type")}`);

    if (input.tagName === "TEXTAREA") {
      // Method 1: execCommand (most reliable for React-controlled textareas)
      input.focus();
      input.setSelectionRange(0, input.value.length);
      const cmdOk = document.execCommand("insertText", false, text);
      console.log(`[Conduit injector] execCommand result: ${cmdOk}, value="${input.value.slice(0, 50)}"`);

      if (cmdOk && input.value.trim().length > 0) {
        ok = true;
        method = "execCommand";
      } else {
        // Method 2: native setter + InputEvent
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        if (nativeSetter) nativeSetter.call(input, text);
        else input.value = text;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        console.log(`[Conduit injector] native setter, value="${input.value.slice(0, 50)}"`);
        ok = input.value.trim().length > 0;
        method = "native-setter";
      }
    } else {
      // contenteditable (Claude, Gemini)
      input.focus();
      document.execCommand("selectAll", false, null);
      document.execCommand("delete", false, null);
      document.execCommand("insertText", false, text);
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
      const actual = input.innerText || input.textContent || "";
      console.log(`[Conduit injector] contenteditable insert, content="${actual.slice(0, 50)}"`);
      ok = actual.trim().length > 0;
      method = "execCommand-contenteditable";
    }

    // Method 3 fallback: clipboard paste simulation
    if (!ok) {
      console.warn("[Conduit injector] Trying clipboard paste fallback");
      try {
        const dt = new DataTransfer();
        dt.setData("text/plain", text);
        input.focus();
        input.dispatchEvent(new ClipboardEvent("paste", {
          clipboardData: dt,
          bubbles: true,
          cancelable: true,
        }));
        await new Promise(r => setTimeout(r, 200));
        const afterPaste = input.tagName === "TEXTAREA" ? input.value : (input.innerText || "");
        ok = afterPaste.trim().length > 0;
        method = "clipboard-paste";
        console.log(`[Conduit injector] paste result: ok=${ok}, value="${afterPaste.slice(0, 50)}"`);
      } catch (e) {
        console.warn("[Conduit injector] Paste fallback failed:", e.message);
      }
    }

    if (!ok) error = "All injection methods failed — value is empty after injection";

  } catch (e) {
    error = e.message;
    console.error("[Conduit injector] Injection error:", e.message);
  }

  console.log(`[Conduit injector] Inject done: ok=${ok}, method=${method}`);
  document.dispatchEvent(new CustomEvent("conduit:inject:result", { detail: { requestId, ok, error, method } }));
});

// ─────────────────────────── Submit ───────────────────────────

function isEnabledBtn(b) {
  return !b.disabled && !b.hasAttribute("disabled") && b.getAttribute("aria-disabled") !== "true";
}

document.addEventListener("conduit:submit", (ev) => {
  const { requestId, inputSelector } = ev.detail;
  let ok = false;
  let method = null;
  let html = null;

  // Attempt 1: known send-button selectors (enabled only)
  for (const sel of SUBMIT_SELECTORS) {
    try {
      const btn = document.querySelector(sel);
      if (btn && isEnabledBtn(btn)) {
        console.log(`[Conduit injector] Submit via selector: ${sel}`);
        btn.click();
        ok = true; method = `selector:${sel}`; html = btn.outerHTML.slice(0, 120);
        break;
      }
    } catch { /* ignore */ }
  }

  // Attempt 2: find an enabled button inside the same composer/form as the input
  if (!ok && inputSelector) {
    const input = document.querySelector(inputSelector);
    if (input) {
      let container = null;
      let el = input;
      for (let i = 0; i < 6 && el; i++) {
        el = el.parentElement;
        if (el && (el.tagName === "FORM" || el.getAttribute("role") === "form")) {
          container = el;
          break;
        }
      }
      if (!container) {
        container = input.parentElement?.parentElement?.parentElement?.parentElement || input.parentElement;
      }

      if (container) {
        const btns = Array.from(container.querySelectorAll("button, [role='button']")).filter((b) => {
          if (!isEnabledBtn(b)) return false;
          const lbl = b.getAttribute("aria-label") || b.getAttribute("title") || "";
          return !SKIP_BTN.test(lbl);
        });

        console.log(`[Conduit injector] Container buttons (${btns.length}):`,
          btns.map(b => ({ label: b.getAttribute("aria-label"), testId: b.getAttribute("data-testid"), html: b.outerHTML.slice(0, 60) })));

        const labeled = btns.find((b) =>
          /send|submit/i.test(b.getAttribute("aria-label") || b.getAttribute("title") || b.getAttribute("data-testid") || "")
        );
        const target = labeled || btns[btns.length - 1];

        if (target) {
          console.log(`[Conduit injector] Submit via container-relative:`, target.getAttribute("aria-label"), target.outerHTML.slice(0, 80));
          target.click();
          ok = true; method = "container-relative"; html = target.outerHTML.slice(0, 120);
        }
      }
    }
  }

  // Attempt 3: viewport positional heuristic
  if (!ok) {
    const all = Array.from(document.querySelectorAll("button, [role='button']")).filter((b) => {
      if (!isEnabledBtn(b)) return false;
      const r = b.getBoundingClientRect();
      if (!r.height || !r.width || r.bottom < window.innerHeight * 0.5) return false;
      const lbl = b.getAttribute("aria-label") || b.getAttribute("title") || "";
      return !SKIP_BTN.test(lbl);
    });

    const labeled = all.find((b) =>
      /send|submit/i.test(b.getAttribute("aria-label") || b.getAttribute("title") || b.getAttribute("data-testid") || "")
    );
    const sorted = all.slice().sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return (rb.bottom - ra.bottom) || (rb.right - ra.right);
    });
    const target = labeled || sorted[0];

    if (target) {
      console.log("[Conduit injector] Submit via heuristic:", target.getAttribute("aria-label"), target.outerHTML.slice(0, 80));
      target.click();
      ok = true; method = "heuristic"; html = target.outerHTML.slice(0, 120);
    }
  }

  // Attempt 4: Enter key on the input element
  if (!ok && inputSelector) {
    const input = document.querySelector(inputSelector);
    if (input) {
      console.log("[Conduit injector] Submit via Enter key");
      input.dispatchEvent(new KeyboardEvent("keydown",  { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13 }));
      input.dispatchEvent(new KeyboardEvent("keypress", { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13 }));
      input.dispatchEvent(new KeyboardEvent("keyup",    { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13 }));
      ok = true; method = "enter-key";
    }
  }

  if (!ok) console.error("[Conduit injector] All submit attempts failed");
  document.dispatchEvent(new CustomEvent("conduit:submit:result", { detail: { requestId, ok, method, html } }));
});
