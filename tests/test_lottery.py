"""Unit tests for tax math and CA Lottery HTML parsing."""

from pathlib import Path
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "app"))

from lottery import (  # noqa: E402
    after_tax_cash,
    parse_cash_value,
    parse_draw_games_html,
    parse_money_amount,
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
    assert pb.next_draw == "WED/JUL 22, 2026"
    assert pb.last_draw == "MON/JUL 20, 2026"
    assert pb.source == "calottery"

    mm = by_id["mega-millions"]
    assert mm.jackpot_annuity == 743_000_000
    assert mm.cash_value == 323_400_000
    assert mm.after_tax_cash == 203_742_000

    sl = by_id["superlotto-plus"]
    assert sl.jackpot_annuity == 39_000_000
    assert sl.cash_value == 17_300_000
    assert sl.after_tax_cash == 10_899_000
