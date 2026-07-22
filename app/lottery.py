"""Fetch and parse California Lottery jackpot estimates; apply federal tax."""

from __future__ import annotations

import asyncio
import logging
import re
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Any

import httpx
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

FEDERAL_TAX_RATE = 0.37
STATE_TAX_RATE = 0.0  # California does not tax CA Lottery prizes

CALOTTERY_DRAW_GAMES_URL = "https://www.calottery.com/en/draw-games"
USER_AGENT = (
    "CALotteryAfterTax/1.0 (+https://github.com/local/ca-lottery-aftertax; "
    "self-hosted personal dashboard)"
)
CACHE_TTL_SECONDS = 20 * 60  # 20 minutes
REQUEST_TIMEOUT = 20.0

# CSS class on calottery draw cards → our game id / display name
GAME_SELECTORS: dict[str, tuple[str, str]] = {
    "powerball": ("powerball", "Powerball"),
    "megamillions": ("mega-millions", "Mega Millions"),
    "superlotto": ("superlotto-plus", "SuperLotto Plus"),
}

_MONEY_RE = re.compile(
    r"\$\s*([\d,]+(?:\.\d+)?)\s*(BILLION|MILLION|THOUSAND)?",
    re.IGNORECASE,
)
_CASH_RE = re.compile(
    r"Estimated\s+Cash\s+Value\s+\$\s*([\d,]+(?:\.\d+)?)",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class GameJackpot:
    id: str
    name: str
    jackpot_annuity: int
    cash_value: int
    after_tax_cash: int
    next_draw: str | None
    last_draw: str | None
    source: str = "calottery"


def after_tax_cash(cash_value: int, federal_rate: float = FEDERAL_TAX_RATE) -> int:
    """Return estimated take-home after max federal tax (whole dollars)."""
    if cash_value < 0:
        raise ValueError("cash_value must be non-negative")
    if not 0 <= federal_rate < 1:
        raise ValueError("federal_rate must be in [0, 1)")
    return int(round(cash_value * (1.0 - federal_rate)))


def parse_money_amount(text: str) -> int | None:
    """Parse strings like '$567 MILLION' or '$251,800,000' into whole dollars."""
    if not text:
        return None
    cleaned = " ".join(text.split())
    match = _MONEY_RE.search(cleaned)
    if not match:
        return None
    number = float(match.group(1).replace(",", ""))
    unit = (match.group(2) or "").upper()
    multipliers = {
        "BILLION": 1_000_000_000,
        "MILLION": 1_000_000,
        "THOUSAND": 1_000,
        "": 1,
    }
    return int(round(number * multipliers[unit]))


def parse_cash_value(text: str) -> int | None:
    """Parse 'Estimated Cash Value $251,800,000'."""
    if not text:
        return None
    match = _CASH_RE.search(text)
    if match:
        return int(round(float(match.group(1).replace(",", ""))))
    return parse_money_amount(text)


def _strong_text(el) -> str | None:
    if el is None:
        return None
    strong = el.find("strong")
    if strong and strong.get_text(strip=True):
        return strong.get_text(strip=True)
    text = el.get_text(" ", strip=True)
    # "Next Draw: WED/JUL 22, 2026"
    if ":" in text:
        return text.split(":", 1)[1].strip() or None
    return text or None


def parse_draw_games_html(html: str) -> list[GameJackpot]:
    """Extract Powerball, Mega Millions, SuperLotto Plus from draw-games page HTML."""
    soup = BeautifulSoup(html, "lxml")
    games: list[GameJackpot] = []

    for css_class, (game_id, game_name) in GAME_SELECTORS.items():
        card = soup.select_one(f"div.card.{css_class}")
        if card is None:
            logger.warning("Missing card for game class %s", css_class)
            continue

        amount_el = card.select_one(".draw-cards--lottery-amount")
        cash_el = card.select_one(".draw-cards--cash-value")
        next_el = card.select_one(".draw-cards--next-draw-date")
        last_el = card.select_one(".draw-cards--last-draw-date")

        annuity = parse_money_amount(amount_el.get_text(" ", strip=True) if amount_el else "")
        cash = parse_cash_value(cash_el.get_text(" ", strip=True) if cash_el else "")

        if annuity is None or cash is None:
            logger.warning(
                "Could not parse amounts for %s (annuity=%s cash=%s)",
                game_id,
                amount_el.get_text(strip=True) if amount_el else None,
                cash_el.get_text(strip=True) if cash_el else None,
            )
            continue

        games.append(
            GameJackpot(
                id=game_id,
                name=game_name,
                jackpot_annuity=annuity,
                cash_value=cash,
                after_tax_cash=after_tax_cash(cash),
                next_draw=_strong_text(next_el),
                last_draw=_strong_text(last_el),
                source="calottery",
            )
        )

    return games


class JackpotCache:
    """In-memory TTL cache with stale-on-error behavior."""

    def __init__(self, ttl_seconds: int = CACHE_TTL_SECONDS) -> None:
        self.ttl_seconds = ttl_seconds
        self._payload: dict[str, Any] | None = None
        self._fetched_mono: float | None = None
        self._lock = asyncio.Lock()
        self._last_force_refresh: float = 0.0

    def _is_fresh(self) -> bool:
        if self._payload is None or self._fetched_mono is None:
            return False
        return (time.monotonic() - self._fetched_mono) < self.ttl_seconds

    def _age_seconds(self) -> float | None:
        if self._fetched_mono is None:
            return None
        return time.monotonic() - self._fetched_mono

    async def get(self, force: bool = False) -> dict[str, Any]:
        async with self._lock:
            if not force and self._is_fresh() and self._payload is not None:
                return {**self._payload, "stale": False, "cache_hit": True}

            try:
                payload = await self._fetch_live()
                self._payload = payload
                self._fetched_mono = time.monotonic()
                return {**payload, "stale": False, "cache_hit": False}
            except Exception as exc:
                logger.exception("Live jackpot fetch failed: %s", exc)
                if self._payload is not None:
                    return {
                        **self._payload,
                        "stale": True,
                        "cache_hit": True,
                        "error": str(exc),
                    }
                raise

    async def force_refresh(self, min_interval: float = 60.0) -> dict[str, Any]:
        now = time.monotonic()
        if now - self._last_force_refresh < min_interval and self._payload is not None:
            return {
                **self._payload,
                "stale": not self._is_fresh(),
                "cache_hit": True,
                "rate_limited": True,
            }
        self._last_force_refresh = now
        return await self.get(force=True)

    async def _fetch_live(self) -> dict[str, Any]:
        html = await fetch_draw_games_html()
        games = parse_draw_games_html(html)
        if len(games) < 3:
            raise RuntimeError(
                f"Expected 3 jackpot games, parsed {len(games)}: "
                f"{[g.id for g in games]}"
            )
        fetched_at = datetime.now(timezone.utc).isoformat()
        return {
            "fetched_at": fetched_at,
            "source_url": CALOTTERY_DRAW_GAMES_URL,
            "tax": {
                "federal_rate": FEDERAL_TAX_RATE,
                "state_rate": STATE_TAX_RATE,
                "note": (
                    "After-tax cash = cash value × (1 − 0.37). "
                    "California does not tax California Lottery prizes. "
                    "Estimate only; not tax advice."
                ),
            },
            "games": [asdict(g) for g in games],
        }


async def fetch_draw_games_html() -> str:
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
    }
    async with httpx.AsyncClient(
        timeout=REQUEST_TIMEOUT,
        follow_redirects=True,
        headers=headers,
    ) as client:
        response = await client.get(CALOTTERY_DRAW_GAMES_URL)
        response.raise_for_status()
        return response.text


# Module-level singleton used by the API
cache = JackpotCache()
