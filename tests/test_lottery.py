"""Unit tests for tax math and CA Lottery HTML parsing."""

from pathlib import Path
import sys

import httpx
import pytest
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "app"))

from lottery import (  # noqa: E402
    CALOTTERY_DRAW_GAMES_URL,
    INTEREST_COMBINED_TAX_RATE,
    USER_AGENT,
    after_tax_cash,
    annuity_schedule,
    build_jackpot_payload,
    parse_cash_value,
    parse_draw_games_html,
    parse_money_amount,
    yield_income,
)

FIXTURE = Path(__file__).parent / "fixtures" / "draw-games.html"


def test_after_tax_cash_basic():
    assert after_tax_cash(251_800_000) == 158_634_000
    assert after_tax_cash(323_400_000) == 203_742_000
    assert after_tax_cash(17_300_000) == 10_899_000
    assert after_tax_cash(0) == 0


def test_after_tax_cash_custom_rate():
    assert after_tax_cash(100, federal_rate=0.24) == 76


def test_after_tax_cash_rejects_bad_input():
    with pytest.raises(ValueError):
        after_tax_cash(-1)
    with pytest.raises(ValueError):
        after_tax_cash(100, federal_rate=1.0)


def test_yield_income_default_4_percent_with_interest_tax():
    # $10M at 4% → $400k pretax; after 50.3% tax → $198,800/yr
    y = yield_income(10_000_000)
    assert y.pretax_annual == 400_000
    assert y.pretax_monthly == 33_333
    keep = 1.0 - INTEREST_COMBINED_TAX_RATE
    assert y.after_tax_annual == int(round(10_000_000 * 0.04 * keep))
    assert y.after_tax_monthly == int(round(10_000_000 * 0.04 * keep / 12.0))
    assert y.after_tax_annual == 198_800

    # $100M at 4% → $4M pretax → ~$1.988M after tax
    y = yield_income(100_000_000)
    assert y.pretax_annual == 4_000_000
    assert y.pretax_monthly == 333_333
    assert y.after_tax_annual == 1_988_000


def test_yield_income_custom_rate_and_zero():
    y = yield_income(1_000_000, annual_rate=0.05)
    assert y.pretax_annual == 50_000
    assert y.pretax_monthly == 4167
    assert y.after_tax_annual == int(round(1_000_000 * 0.05 * (1 - INTEREST_COMBINED_TAX_RATE)))

    y0 = yield_income(0)
    assert y0 == yield_income(0)  # stable zeros
    assert y0.pretax_annual == 0 and y0.after_tax_annual == 0


def test_yield_income_rejects_bad_input():
    with pytest.raises(ValueError):
        yield_income(-1)
    with pytest.raises(ValueError):
        yield_income(100, annual_rate=-0.01)
    with pytest.raises(ValueError):
        yield_income(100, interest_tax_rate=1.0)


def test_annuity_schedule_graduated_30_payments():
    sched = annuity_schedule(100_000_000)
    assert len(sched) == 30
    assert [p.number for p in sched] == list(range(1, 31))
    # Pretax payments total the advertised jackpot exactly
    assert sum(p.pretax for p in sched) == 100_000_000
    # CA Lottery: first ≈ 1.5051%, last ≈ 6.1954% of the jackpot
    assert sched[0].pretax == 1_505_144
    assert abs(sched[-1].pretax - 6_195_400) < 100
    # Each payment ~5% larger than the previous
    for prev, cur in zip(sched, sched[1:]):
        assert cur.pretax == pytest.approx(prev.pretax * 1.05, abs=2)
    # 37% federal on each payment
    assert sched[0].after_tax == after_tax_cash(1_505_144)


def test_annuity_schedule_flat_and_zero():
    sched = annuity_schedule(1_000, payments=4, growth_rate=0.0)
    assert [p.pretax for p in sched] == [250, 250, 250, 250]
    assert all(p.pretax == 0 for p in annuity_schedule(0))


def test_annuity_schedule_rejects_bad_input():
    with pytest.raises(ValueError):
        annuity_schedule(-1)
    with pytest.raises(ValueError):
        annuity_schedule(100, payments=0)
    with pytest.raises(ValueError):
        annuity_schedule(100, growth_rate=-0.01)


@pytest.mark.parametrize(
    "text, expected",
    [
        ("$567 MILLION", 567_000_000),
        ("$567 MILLION*", 567_000_000),
        ("$1.2 BILLION", 1_200_000_000),
        ("$39 MILLION", 39_000_000),
        ("$251,800,000", 251_800_000),
        ("  $743 MILLION  ", 743_000_000),
    ],
)
def test_parse_money_amount(text, expected):
    assert parse_money_amount(text) == expected


def test_parse_cash_value():
    assert parse_cash_value("Estimated Cash Value $251,800,000") == 251_800_000
    assert parse_cash_value("Estimated Cash Value $17,300,000") == 17_300_000


def test_parse_draw_games_fixture():
    html = FIXTURE.read_text(encoding="utf-8")
    games = parse_draw_games_html(html)
    assert len(games) == 3

    by_id = {g.id: g for g in games}
    assert set(by_id) == {"powerball", "mega-millions", "superlotto-plus"}

    pb = by_id["powerball"]
    assert pb.jackpot_annuity == 567_000_000
    assert pb.cash_value == 251_800_000
    assert pb.after_tax_cash == 158_634_000
    assert pb.yield_annual_pretax == 6_345_360  # 158_634_000 × 0.04
    assert pb.yield_monthly_pretax == 528_780
    keep = 1.0 - INTEREST_COMBINED_TAX_RATE
    assert pb.yield_annual_income == int(round(158_634_000 * 0.04 * keep))
    assert pb.yield_monthly_income == int(round(158_634_000 * 0.04 * keep / 12.0))
    assert pb.next_draw == "WED/JUL 22, 2026"
    assert pb.last_draw == "MON/JUL 20, 2026"
    assert pb.source == "calottery"
    assert len(pb.annuity_schedule) == 30
    assert sum(p.pretax for p in pb.annuity_schedule) == 567_000_000
    assert pb.annuity_after_tax_total == sum(p.after_tax for p in pb.annuity_schedule)

    mm = by_id["mega-millions"]
    assert mm.jackpot_annuity == 743_000_000
    assert mm.cash_value == 323_400_000
    assert mm.after_tax_cash == 203_742_000
    assert mm.yield_annual_pretax == 8_149_680
    assert mm.yield_annual_income == int(round(203_742_000 * 0.04 * keep))

    sl = by_id["superlotto-plus"]
    assert sl.jackpot_annuity == 39_000_000
    assert sl.cash_value == 17_300_000
    assert sl.after_tax_cash == 10_899_000
    assert sl.yield_annual_pretax == 435_960
    assert sl.yield_annual_income == int(round(10_899_000 * 0.04 * keep))


def test_parse_skips_game_without_cash_value():
    soup = BeautifulSoup(FIXTURE.read_text(encoding="utf-8"), "lxml")
    cash_el = soup.select_one("div.card.superlotto .draw-cards--cash-value")
    assert cash_el is not None
    cash_el.decompose()

    games = parse_draw_games_html(str(soup))
    assert {game.id for game in games} == {"powerball", "mega-millions"}


def test_build_payload_keeps_partial_parse():
    soup = BeautifulSoup(FIXTURE.read_text(encoding="utf-8"), "lxml")
    card = soup.select_one("div.card.superlotto")
    assert card is not None
    card.decompose()

    games = parse_draw_games_html(str(soup))
    payload = build_jackpot_payload(games, fetched_at="2026-08-12T00:00:00+00:00")

    assert [game["id"] for game in payload["games"]] == ["powerball", "mega-millions"]
    assert payload["missing_games"] == [
        {"id": "superlotto-plus", "name": "SuperLotto Plus"}
    ]
    assert payload["games"][0]["after_tax_cash"] == 158_634_000
    assert payload["games"][1]["after_tax_cash"] == 203_742_000


def test_build_payload_full_fixture_has_no_missing():
    games = parse_draw_games_html(FIXTURE.read_text(encoding="utf-8"))
    payload = build_jackpot_payload(games)
    assert payload["missing_games"] == []
    assert {game["id"] for game in payload["games"]} == {
        "powerball",
        "mega-millions",
        "superlotto-plus",
    }


def test_build_payload_rejects_empty():
    with pytest.raises(RuntimeError, match="parsed 0"):
        build_jackpot_payload([])


@pytest.mark.network
def test_live_calottery_page_still_parses_three_games():
    try:
        with httpx.Client(
            timeout=20.0,
            follow_redirects=True,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "text/html,application/xhtml+xml",
            },
        ) as client:
            response = client.get(CALOTTERY_DRAW_GAMES_URL)
            response.raise_for_status()
            html = response.text
    except httpx.HTTPError as exc:
        pytest.skip(f"calottery.com unreachable: {exc}")

    games = parse_draw_games_html(html)
    assert {game.id for game in games} == {
        "powerball",
        "mega-millions",
        "superlotto-plus",
    }
    for game in games:
        assert game.cash_value > 0
        assert game.jackpot_annuity > 0
        assert game.after_tax_cash == int(round(game.cash_value * 0.63))
