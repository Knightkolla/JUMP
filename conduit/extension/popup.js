"use strict";

const PROVIDER_META = {
  chatgpt: { icon: "🤖", host: "chatgpt.com" },
  claude:  { icon: "🧠", host: "claude.ai" },
  gemini:  { icon: "✨", host: "gemini.google.com" },
};

const CURL_EXAMPLE = (provider) =>
  `curl -X POST http://localhost:8765/v1/chat \\\n  -H "Content-Type: application/json" \\\n  -d '{"provider":"${provider}","prompt":"Hello!"}'`;

function render({ connected, providers }) {
  const dot = document.getElementById("statusDot");
  const text = document.getElementById("statusText");
  const list = document.getElementById("providerList");

  // Status bar
  if (connected) {
    dot.className = "dot green";
    text.textContent = "Backend connected · localhost:8765";
  } else {
    dot.className = "dot red pulse";
    text.textContent = "Backend offline — run start.sh";
  }

  // Provider list
  if (providers && providers.length > 0) {
    list.innerHTML = providers.map((p) => {
      const meta = PROVIDER_META[p] || { icon: "🔗", host: p };
      return `<div class="provider-card">
        <span class="provider-icon">${meta.icon}</span>
        <span class="provider-name">${p}</span>
        <span class="provider-url">${meta.host}</span>
        <div class="dot green"></div>
      </div>`;
    }).join("");

    // Update curl example with first active provider
    const ex = document.getElementById("curlBlock");
    const hint = ex.querySelector(".curl-copy-hint");
    const newText = CURL_EXAMPLE(providers[0]);
    ex.textContent = newText;
    ex.appendChild(hint);
  } else {
    list.innerHTML = `<div class="no-providers">No LLM tabs open<br>Open ChatGPT, Claude, or Gemini</div>`;
  }
}

function copyText(str, btn) {
  navigator.clipboard.writeText(str).then(() => {
    if (btn) {
      btn.classList.add("copied");
      btn.textContent = "✓";
      setTimeout(() => { btn.classList.remove("copied"); btn.textContent = "⎘"; }, 1500);
    }
  });
}

function fetchStatus() {
  chrome.runtime.sendMessage({ type: "getStatus" }, (resp) => {
    if (chrome.runtime.lastError || !resp) {
      render({ connected: false, providers: [] });
    } else {
      render(resp);
    }
  });
}

// Endpoint copy
document.getElementById("copyEndpoint").addEventListener("click", (e) => {
  copyText("http://localhost:8765/v1/chat", e.currentTarget);
});

// Curl block copy
document.getElementById("curlBlock").addEventListener("click", () => {
  const block = document.getElementById("curlBlock");
  copyText(block.innerText.replace("click to copy", "").trim());
  const hint = block.querySelector(".curl-copy-hint");
  if (hint) { hint.textContent = "copied!"; setTimeout(() => { hint.textContent = "click to copy"; }, 1500); }
});

// Refresh button
document.getElementById("refreshBtn").addEventListener("click", fetchStatus);

fetchStatus();
