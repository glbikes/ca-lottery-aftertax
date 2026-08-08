"""California Lottery after-tax jackpot viewer API + static UI."""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from lottery import (
    DEFAULT_YIELD_RATE,
    FEDERAL_TAX_RATE,
    INTEREST_COMBINED_TAX_RATE,
    STATE_TAX_RATE,
    cache,
)

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)

STATIC_DIR = Path(__file__).resolve().parent / "static"

app = FastAPI(
    title="CA Lottery After-Tax Cash",
    description="California Lottery jackpot cash values adjusted for max federal tax (37%).",
    version="1.0.0",
)

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/health")
async def health() -> dict:
    return {
        "status": "ok",
        "federal_tax_rate": FEDERAL_TAX_RATE,
        "state_tax_rate": STATE_TAX_RATE,
        "yield_rate": DEFAULT_YIELD_RATE,
        "interest_tax_rate": INTEREST_COMBINED_TAX_RATE,
    }


@app.get("/api/jackpots")
async def jackpots() -> dict:
    try:
        return await cache.get(force=False)
    except Exception as exc:
        logger.exception("jackpots endpoint failed")
        raise HTTPException(
            status_code=502,
            detail=f"Unable to load jackpot data: {exc}",
        ) from exc


@app.post("/api/refresh")
async def refresh() -> dict:
    try:
        return await cache.force_refresh(min_interval=60.0)
    except Exception as exc:
        logger.exception("refresh endpoint failed")
        raise HTTPException(
            status_code=502,
            detail=f"Unable to refresh jackpot data: {exc}",
        ) from exc
