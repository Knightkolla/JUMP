"use strict";

// Known outlets, always shown so the path reads consistently.
// Active ones (returned by the backend) light up; the rest sit dim/unwired.
const KNOWN = [
  { id: "chatgpt", host: "chatgpt.com" },
  { id: "claude", host: "claude.ai" },
  { id: "gemini", host: "gemini.google.com" },
];

const ENDPOINT = "http://localhost:8765/v1/chat";

const curlFor = (provider) =>
  `curl -X POST ${ENDPOINT} \\\n  -H "Content-Type: application/json" \\\n  -d '{"provider":"${provider}","prompt":"Hello!"}'`;

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function render({ connected, providers }) {
  providers = providers || [];
  const active = new Set(providers);
  const wrap = document.getElementById("wrap");
  const pill = document.getElementById("pillLabel");
  const readout = document.getElementById("readout");
  const rail = document.getElementById("rail");

  // Merge known outlets with any extra active ones the backend reports.
  const outlets = KNOWN.slice();
  providers.forEach((p) => { if (!outlets.some((o) => o.id === p)) outlets.push({ id: p, host: p }); });

  // State: live = routing with outlets, idle = backend up but nothing wired, offline = backend down.
  let state;
  if (!connected) state = "offline";
  else if (active.size > 0) state = "live";
  else state = "idle";
  wrap.setAttribute("data-state", state);

  // Header pill + readout copy (direction, not mood).
  if (state === "live") {
    pill.textContent = "Live";
    const n = active.size;
    readout.innerHTML = `${n} outlet${n === 1 ? "" : "s"} wired &middot; core stable`;
  } else if (state === "idle") {
    pill.textContent = "Idle";
    readout.innerHTML = `Backend up on <b>:8765</b> &middot; open an LLM tab to wire an outlet`;
  } else {
    pill.textContent = "Offline";
    readout.innerHTML = `Backend down &middot; run <b>start.sh</b> to open the conduit`;
  }

  // Rebuild outlet rows.
  rail.innerHTML = "";
  outlets.forEach((o) => {
    const on = active.has(o.id);
    const row = document.createElement("div");
    row.className = "outlet " + (on ? "on" : "off");
    row.innerHTML =
      (on ? `<span class="track"></span>` : "") +
      `<span class="dot"></span>` +
      `<span class="name">${esc(o.id)}</span>` +
      `<span class="host">${esc(o.host)}</span>` +
      `<span class="tag">${on ? "wired" : "open"}</span>` +
      (on ? `<span class="flow"></span>` : "");
    // Stagger the flow pulse so wired outlets don't fire in lockstep.
    if (on) {
      const flow = row.querySelector(".flow");
      if (flow) flow.style.animationDelay = (providers.indexOf(o.id) % 3) * 1.0 + "s";
    }
    rail.appendChild(row);
  });

  // Quick-start curl targets the first live outlet, else a sensible default.
  const target = providers[0] || "chatgpt";
  const block = document.getElementById("curlBlock");
  block.innerHTML = curlFor(target)
    .replace(/^curl/, '<span class="k">curl</span>')
    .replace(/POST/, '<span class="k">POST</span>');
  block.dataset.copy = curlFor(target);
}

function copyText(str) {
  return navigator.clipboard.writeText(str);
}

// Endpoint chip: copy the bare URL, flash the hint to "copied".
const endpointEl = document.getElementById("endpoint");
const epHint = document.getElementById("epHint");
endpointEl.addEventListener("click", () => {
  copyText(ENDPOINT).then(() => {
    endpointEl.classList.add("ok");
    epHint.textContent = "copied";
    setTimeout(() => { endpointEl.classList.remove("ok"); epHint.textContent = "copy"; }, 1400);
  });
});

// Quick-start curl: copy the full command.
const curlBlock = document.getElementById("curlBlock");
function copyCurl() {
  copyText(curlBlock.dataset.copy || curlBlock.innerText);
  const hintEl = document.querySelector(".quick .eyebrow .hint");
  if (hintEl) { hintEl.textContent = "copied"; setTimeout(() => { hintEl.textContent = "click to copy"; }, 1400); }
}
curlBlock.addEventListener("click", copyCurl);
curlBlock.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); copyCurl(); } });

function fetchStatus() {
  // Inside the extension: ask the background worker. Outside it (preview/dev): demo state.
  // chrome.runtime.id is only set in a genuine extension context — a page-injected
  // chrome (e.g. a wallet extension) has sendMessage but no id, so we treat it as preview.
  const inExtension = typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id && chrome.runtime.sendMessage;
  if (!inExtension) {
    document.documentElement.style.width = "auto";
    document.body.style.minHeight = "100vh";
    document.body.style.padding = "56px 12px 24px";

    const switchEl = document.getElementById("switch");
    if (switchEl) switchEl.style.display = "flex";

    const STATES = {
      live: { connected: true, providers: ["chatgpt", "claude"] },
      idle: { connected: true, providers: [] },
      offline: { connected: false, providers: [] },
    };

    if (switchEl && !switchEl.dataset.wired) {
      switchEl.dataset.wired = "true";
      switchEl.addEventListener("click", (e) => {
        const b = e.target.closest("button");
        if (!b) return;
        document.querySelectorAll("#switch button").forEach((x) => x.classList.toggle("active", x === b));
        render(STATES[b.dataset.s]);
      });
    }

    render(STATES.live);
    return;
  }

  const switchEl = document.getElementById("switch");
  if (switchEl) switchEl.style.display = "none";

  try {
    chrome.runtime.sendMessage({ type: "getStatus" }, (resp) => {
      if (chrome.runtime.lastError || !resp) render({ connected: false, providers: [] });
      else render(resp);
    });
  } catch (e) {
    render({ connected: false, providers: [] });
  }
}

fetchStatus();
