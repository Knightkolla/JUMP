"""Pydantic models for the calibration pipeline."""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field


class SendMechanism(BaseModel):
    type: Literal["click", "key"]
    selector: Optional[str] = None
    key: Optional[str] = None


class SelectorSet(BaseModel):
    input_selector: str
    input_type: Literal["textarea", "contenteditable"]
    send_mechanism: SendMechanism
    response_container_selector: str
    generating_indicator_selector: Optional[str] = Field(default=None)


class CalibrateRequest(BaseModel):
    domain: str = Field(..., description="Website domain being calibrated")
    dom_snapshot: str = Field(..., description="Compressed DOM snapshot of the page")
