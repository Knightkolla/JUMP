"""
LLM-based calibration for discovering CSS selectors on chat UIs.

Sends a compressed DOM snapshot to an LLM and returns a validated SelectorSet
containing all critical selectors (input, send button, response container,
generating indicator) in a single API call.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Optional

from openai import AsyncOpenAI
from pydantic import ValidationError

from models import SelectorSet

logger = logging.getLogger(__name__)

_SYSTEM_PROMPT = """\
You are an advanced AI browser automation agent. You will receive a compressed \
DOM snapshot of an LLM chat UI. Your goal is to identify robust CSS selectors \
that describe functional concepts (the message input, the submit action, the \
assistant's response, the generating indicator).

Return ONLY a JSON object (no markdown fences, no commentary) with exactly these keys:
{
  "input_selector": "<CSS selector for the message input element>",
  "input_type": "textarea" | "contenteditable",
  "send_mechanism": {
    "type": "click" | "key",
    "selector": "<CSS selector of send button, or null>",
    "key": "<key name like 'Enter', or null>"
  },
  "response_container_selector": "<CSS selector for the last AI response>",
  "generating_indicator_selector": "<CSS selector for the stop/generating indicator, or null>"
}

CRITICAL RULES:
1. Only use selectors that exactly match elements present in the DOM snapshot. \
   Do not invent attributes.
2. For input: prefer elements with contenteditable="true", role="textbox", or <textarea>.
3. For send button: use its exact aria-label (e.g. [aria-label="Send message"]).
4. Use the SHORTEST, most direct attribute available. Never use long brittle chains.
5. Never use class names containing brackets like [...] as they break CSS selectors.
6. Only output JSON.
"""

_MAX_RETRIES = 2


async def calibrate_selectors(dom_snapshot: str, domain: str) -> SelectorSet:
    """Send a DOM snapshot to the LLM and return a validated SelectorSet.

    Raises:
        ValueError: If the LLM fails to return valid JSON after all retries.
        openai.OpenAIError: On upstream API errors.
    """
    api_key = os.getenv("LLM_API_KEY") or os.getenv("OPENAI_API_KEY", "")
    base_url = os.getenv("LLM_BASE_URL", "https://api.openai.com/v1")
    model = os.getenv("LLM_MODEL", "llama-3.3-70b-versatile")

    if not api_key:
        raise ValueError("LLM_API_KEY is not set — cannot run calibration")

    client = AsyncOpenAI(api_key=api_key, base_url=base_url)

    user_message = (
        f"Domain: {domain}\n\n"
        f"DOM Snapshot:\n```\n{dom_snapshot}\n```"
    )

    last_error: Optional[Exception] = None

    for attempt in range(1, _MAX_RETRIES + 2):
        logger.info("Calibration attempt %d/%d for domain=%s", attempt, _MAX_RETRIES + 1, domain)

        response = await client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": user_message},
            ],
            temperature=0.0,
        )

        raw = (response.choices[0].message.content or "").strip()
        logger.debug("LLM raw response: %s", raw)

        try:
            parsed = _parse_json(raw)
            selector_set = SelectorSet.model_validate(parsed)
            logger.info("Calibration succeeded for domain=%s", domain)
            return selector_set
        except (json.JSONDecodeError, ValidationError) as exc:
            last_error = exc
            logger.warning("Calibration attempt %d failed: %s", attempt, exc)

    raise ValueError(
        f"Calibration failed after {_MAX_RETRIES + 1} attempts for domain={domain}: {last_error}"
    )


def _parse_json(text: str) -> dict[str, Any]:
    """Strip markdown fences if present and parse JSON."""
    cleaned = text.strip()
    if cleaned.startswith("```"):
        first_newline = cleaned.index("\n")
        cleaned = cleaned[first_newline + 1:]
        if cleaned.endswith("```"):
            cleaned = cleaned[:-3].strip()
    return json.loads(cleaned)
