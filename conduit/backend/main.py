"""
Conduit backend — FastAPI + WebSocket bridge between HTTP callers and the Chrome extension.
"""

import asyncio
import json
import logging
import os
import uuid
from contextlib import asynccontextmanager
from typing import Dict

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("conduit")


@asynccontextmanager
async def lifespan(app: FastAPI):
    asyncio.create_task(_ping_loop())
    yield


app = FastAPI(
    title="Conduit",
    version="1.0.0",
    description="Turn any LLM chat website into a programmable API",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# One WebSocket per provider (from the extension)
connected_extensions: Dict[str, WebSocket] = {}
# provider -> ready bool
provider_status: Dict[str, bool] = {}
# request_id -> asyncio.Future
pending_requests: Dict[str, asyncio.Future] = {}

# ────────────────────────────── Models ──────────────────────────────

class ChatRequest(BaseModel):
    provider: str
    prompt: str
    timeout: int = 120


class ChatResponse(BaseModel):
    id: str
    provider: str
    response: str
    status: str


class DeriveSelectorRequest(BaseModel):
    provider: str
    role: str  # input | submit | responseContainer | doneSignal
    dom: str


# ────────────────────────────── Routes ──────────────────────────────

@app.get("/")
async def root():
    return {"name": "Conduit", "version": "1.0.0", "docs": "/docs"}


@app.get("/v1/providers")
async def list_providers():
    return {
        "providers": [
            {"id": p, "ready": ready}
            for p, ready in provider_status.items()
        ]
    }


@app.post("/v1/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    if req.provider not in connected_extensions:
        raise HTTPException(503, f"No extension tab connected for provider '{req.provider}'. "
                                 f"Open the site in Chrome with the Conduit extension installed.")

    if not provider_status.get(req.provider, False):
        raise HTTPException(503, f"Provider '{req.provider}' is connected but not yet ready.")

    request_id = str(uuid.uuid4())
    loop = asyncio.get_event_loop()
    future: asyncio.Future = loop.create_future()
    pending_requests[request_id] = future

    ws = connected_extensions[req.provider]
    try:
        await ws.send_json({
            "type": "prompt",
            "id": request_id,
            "provider": req.provider,
            "text": req.prompt,
        })
    except Exception as exc:
        pending_requests.pop(request_id, None)
        raise HTTPException(503, f"Failed to reach extension: {exc}")

    try:
        result = await asyncio.wait_for(future, timeout=req.timeout)
        return ChatResponse(
            id=request_id,
            provider=req.provider,
            response=result["text"],
            status="success",
        )
    except asyncio.TimeoutError:
        pending_requests.pop(request_id, None)
        raise HTTPException(504, f"Timed out after {req.timeout}s waiting for '{req.provider}' to respond.")
    except Exception as exc:
        pending_requests.pop(request_id, None)
        raise HTTPException(500, str(exc))


@app.post("/v1/derive-selector")
async def derive_selector(req: DeriveSelectorRequest):
    """
    LLM fallback: given a trimmed DOM snapshot, return the CSS selector for the requested role.
    Requires OPENAI_API_KEY (or compatible) in .env.
    """
    api_key = os.getenv("LLM_API_KEY") or os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(503, "LLM fallback unavailable: set LLM_API_KEY in .env")

    base_url = os.getenv("LLM_BASE_URL", "https://api.openai.com/v1")
    model = os.getenv("LLM_MODEL", "llama-3.3-70b-versatile")

    role_descriptions = {
        "input": "the chat input box where the user types a message (textarea or contenteditable div)",
        "submit": "the send / submit button that submits the message",
        "responseContainer": "the container element that holds the assistant's reply messages",
        "doneSignal": "the send button when it is NOT disabled (i.e. when generation is complete)",
    }

    system = (
        "You are a DOM analysis assistant. Given an HTML snippet from an LLM chat site, "
        "return a valid CSS selector for the requested UI element. "
        'Respond with ONLY a raw JSON object on a single line, no markdown, no explanation: {"selector": "<css selector>"}'
    )
    user = (
        f"Provider: {req.provider}\n"
        f"Find: {role_descriptions.get(req.role, req.role)}\n\n"
        f"HTML (truncated):\n{req.dom[:6000]}"
    )

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{base_url}/chat/completions",
                headers={"Authorization": f"Bearer {api_key}"},
                json={
                    "model": model,
                    "messages": [
                        {"role": "system", "content": system},
                        {"role": "user", "content": user},
                    ],
                    "temperature": 0,
                },
            )
            resp.raise_for_status()
            content = resp.json()["choices"][0]["message"]["content"].strip()
            # Extract JSON even if the model wraps it in markdown fences
            if "```" in content:
                content = content.split("```")[1].lstrip("json").strip()
            parsed = json.loads(content)
            selector = parsed.get("selector", "")
            log.info(f"LLM derived selector for {req.provider}/{req.role}: {selector}")
            return {"selector": selector, "provider": req.provider, "role": req.role}
    except httpx.HTTPStatusError as exc:
        body = exc.response.text[:500]
        log.error(f"LLM selector derivation failed {exc.response.status_code}: {body}")
        raise HTTPException(500, f"LLM call failed ({exc.response.status_code}): {body}")
    except Exception as exc:
        log.error(f"LLM selector derivation failed: {exc}")
        raise HTTPException(500, f"LLM call failed: {exc}")


# ────────────────────────────── WebSocket ──────────────────────────────

@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket):
    await websocket.accept()
    log.info("Extension connected")
    # Track which providers this connection owns so we can clean up on disconnect
    owned_providers: set[str] = set()

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            msg_type = msg.get("type")

            if msg_type == "status":
                provider = msg.get("provider")
                ready = bool(msg.get("ready", False))
                if not provider:
                    continue
                provider_status[provider] = ready
                if ready:
                    connected_extensions[provider] = websocket
                    owned_providers.add(provider)
                    log.info(f"Provider '{provider}' ready")
                else:
                    connected_extensions.pop(provider, None)
                    owned_providers.discard(provider)
                    log.info(f"Provider '{provider}' unregistered")

            elif msg_type == "injected":
                log.info(f"Injected request {msg.get('id')}")

            elif msg_type == "response":
                req_id = msg.get("id")
                text = msg.get("text", "")
                fut = pending_requests.pop(req_id, None)
                if fut and not fut.done():
                    fut.set_result({"text": text})
                log.info(f"Response received for {req_id} ({len(text)} chars)")

            elif msg_type == "error":
                req_id = msg.get("id")
                reason = msg.get("reason", "unknown error from extension")
                fut = pending_requests.pop(req_id, None)
                if fut and not fut.done():
                    fut.set_exception(Exception(reason))
                log.warning(f"Extension error for {req_id}: {reason}")

            elif msg_type == "pong":
                pass  # keepalive acknowledged

    except WebSocketDisconnect:
        log.info("Extension disconnected")
    except Exception as exc:
        log.error(f"WebSocket error: {exc}")
    finally:
        for provider in owned_providers:
            if connected_extensions.get(provider) is websocket:
                del connected_extensions[provider]
            provider_status[provider] = False

        for req_id, fut in list(pending_requests.items()):
            if not fut.done():
                fut.set_exception(Exception("Extension disconnected mid-request"))
            pending_requests.pop(req_id, None)


# ────────────────────────────── Keepalive ──────────────────────────────

async def _ping_loop():
    while True:
        await asyncio.sleep(25)
        dead: list[str] = []
        for provider, ws in list(connected_extensions.items()):
            try:
                await ws.send_json({"type": "ping"})
            except Exception:
                dead.append(provider)
        for p in dead:
            connected_extensions.pop(p, None)
            provider_status[p] = False


# ────────────────────────────── Entrypoint ──────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8765, reload=True)
