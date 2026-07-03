<div align="center">
  <img src="docs/banner.png" alt="Conduit" width="100%" />
  <br/><br/>
  <p><b>Your browser session, turned into an HTTP API.</b></p>
  <p>No scraping. No unofficial keys. No rate-limit games.</p>
  <br/>

  [![Python 3.11+](https://img.shields.io/badge/python-3.11+-3776AB?style=flat-square&logo=python&logoColor=white)](https://python.org)
  [![FastAPI](https://img.shields.io/badge/FastAPI-0.111+-009688?style=flat-square&logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com)
  [![Chrome MV3](https://img.shields.io/badge/Chrome-MV3-4285F4?style=flat-square&logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/)
  [![License: MIT](https://img.shields.io/badge/license-MIT-22c55e?style=flat-square)](LICENSE)
  [![PRs Welcome](https://img.shields.io/badge/PRs-welcome-a855f7?style=flat-square)](https://github.com/Knightkolla/JUMP/pulls)

</div>

---

Conduit is a Chrome extension + local FastAPI server that bridges your **authenticated browser session** to a clean REST endpoint. Open ChatGPT, Claude, or Gemini in a tab — Conduit wires it up. You send a prompt over HTTP, it types it, waits for the reply, and hands you the full response as JSON. Images included.

```bash
curl -s -X POST http://localhost:8765/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"provider":"gemini","prompt":"Generate a photo of a rainy Tokyo alley"}'
```

```json
{
  "id": "3d7a9f01",
  "provider": "gemini",
  "response": "Here's the image you requested.",
  "image_urls": ["http://localhost:8765/v1/images/3d7a9f01"],
  "status": "success"
}
```

---

## How it works

```
curl / your script
      │
      ▼ POST /v1/chat
┌─────────────────────┐
│  FastAPI  :8765     │  stores images to /tmp/conduit_images/
└──────┬──────────────┘
       │ WebSocket
┌──────▼──────────────────────────────────────┐
│  Chrome Extension (MV3)                     │
│                                             │
│  background.js   — WebSocket owner,         │
│                    routes prompts to tabs   │
│                                             │
│  content.js      — self-healing selectors,  │
│  (isolated world)  done-detection,          │
│                    image snapshot diff      │
│                                             │
│  injector.js     — React-safe text entry,  │
│  (MAIN world)      canvas blob export      │
└──────┬──────────────────────────────────────┘
       │ DOM + CustomEvents
┌──────▼──────────────────────────────────────┐
│  ChatGPT · Claude · Gemini  (browser tab)   │
└─────────────────────────────────────────────┘
```

The extension lives in the MAIN world (same JS context as the page) for text injection and image capture, and the isolated world for the selector engine and WebSocket relay — so it survives React's synthetic event system and Gemini's blob-URL CSP restrictions without any page-level hacks.

---

## Quick start

### Backend

```bash
cd conduit/backend
python3.11 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # optional — only needed for LLM calibration
python main.py
# Uvicorn running on http://0.0.0.0:8765
```

### Extension

1. Go to `chrome://extensions`, enable **Developer mode**
2. Click **Load unpacked** → select `conduit/extension`
3. Pin Conduit to your toolbar

### Wire a provider

Open any supported tab. The popup turns **Live** within a few seconds.

| Provider | URL |
|---|---|
| ChatGPT | `https://chatgpt.com` |
| Claude | `https://claude.ai` |
| Gemini | `https://gemini.google.com` |

---

## API

### `POST /v1/chat`

```json
{
  "provider": "gemini",
  "prompt": "Explain RLHF in two sentences",
  "timeout": 120,
  "web_search": false
}
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `provider` | string | — | `chatgpt` · `claude` · `gemini` |
| `prompt` | string | — | |
| `timeout` | int | `120` | seconds |
| `web_search` | bool | `false` | toggles the provider's built-in search |

**Response**

```json
{
  "id": "fd93cc20",
  "provider": "gemini",
  "response": "RLHF stands for...",
  "images": [],
  "image_urls": [],
  "status": "success"
}
```

`images` contains raw base64 data URLs. `image_urls` are short `localhost` links you can open directly in a browser — persisted to disk, survive backend restarts.

---

### `GET /v1/images/:id`

Serves a captured image from `/tmp/conduit_images/`. Useful for piping into scripts or opening in a browser without decoding base64.

---

### `GET /v1/providers`

Returns which providers are currently connected and ready.

---

### `POST /v1/calibrate`

Sends a compressed DOM snapshot to your configured LLM and returns a fresh `SelectorSet`. The extension calls this automatically on a cache miss — you rarely need to trigger it manually.

---

## Image capture

Capturing generated images is harder than it sounds. Here's what Conduit does:

| Problem | Solution |
|---|---|
| Gemini serves images as `blob:` URLs scoped to the page's MAIN world | `injector.js` draws the blob into a `<canvas>` via `Image()` — no `fetch()`, no CSP violation |
| Images appear after the text stream ends | `pollForLateImages` runs up to 20 s when the text response is short |
| UI icons and avatars pollute the image set | Snapshot diff: only elements that appear *after* the prompt fires are captured |
| CDN image URLs block content-script fetch | Routed through the background service worker, which has no CORS restrictions |

---

## Selector engine

Conduit doesn't hardcode CSS selectors. It walks a 4-rung ladder:

```
1. In-memory cache          instant, no DOM access
        ↓ miss
2. Adapter defaults         known-good selectors per provider
        ↓ miss
3. Stable anchor scan       ~20 heuristic candidates tried in order
        ↓ miss
4. LLM calibration          compressed DOM → your LLM → SelectorSet
                            result written to chrome.storage.local
```

When a provider ships a redesign the cache entry invalidates on first miss and the ladder re-runs — no extension update required.

---

## Configuration

All fields are optional. You only need an LLM key if you want the calibration fallback.

```dotenv
# conduit/backend/.env

LLM_API_KEY=sk-...
LLM_BASE_URL=https://api.openai.com/v1   # or Groq, Together, Ollama
LLM_MODEL=gpt-4o-mini
```

**Groq (free tier, very fast):**
```dotenv
LLM_API_KEY=gsk_...
LLM_BASE_URL=https://api.groq.com/openai/v1
LLM_MODEL=llama-3.3-70b-versatile
```

**Local Ollama:**
```dotenv
LLM_API_KEY=ollama
LLM_BASE_URL=http://localhost:11434/v1
LLM_MODEL=mistral
```

---

## Project structure

```
conduit/
├── backend/
│   ├── main.py           # FastAPI — HTTP routes, WebSocket bridge, image store
│   ├── calibration.py    # LLM-powered selector calibration
│   ├── models.py         # Pydantic models
│   ├── requirements.txt
│   └── .env.example
├── extension/
│   ├── manifest.json
│   ├── background.js     # Service worker — WebSocket owner, prompt router
│   ├── content.js        # Isolated world — selector engine, done-detection, images
│   ├── injector.js       # MAIN world — text injection, canvas blob export
│   ├── popup.html
│   └── popup.js
└── docs/
    └── banner.png
```

---

## Provider support

| Provider | Text | Images | Web search |
|---|:---:|:---:|:---:|
| ChatGPT | ✓ | ✓ DALL·E | ✓ |
| Claude | ✓ | — | — |
| Gemini | ✓ | ✓ Imagen | ✓ |

---

## Contributing

Issues and PRs are welcome. For anything bigger than a bug fix, open an issue first so we can align on direction.

```bash
git clone https://github.com/Knightkolla/JUMP.git
cd JUMP/conduit/backend
python3.11 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

**Adding a provider:**

1. Add an entry to `ADAPTERS` in `content.js` with the hostname and default selectors
2. Add the host to `manifest.json` under both `matches` and `host_permissions`
3. Extend `captureResponse` in `content.js` if the markup differs significantly
4. Open a PR with a short description of what changed and why

---

## License

MIT — see [LICENSE](LICENSE).
