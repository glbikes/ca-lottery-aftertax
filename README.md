# CA Lottery After-Tax Cash

Self-hosted dashboard for **Powerball**, **Mega Millions**, and **SuperLotto Plus** that shows the estimated **cash option** and an **after-tax** figure using the top federal marginal rate.

| Assumption | Value |
|------------|-------|
| Federal tax | **37%** (max marginal rate) |
| California state tax | **0%** on California Lottery prizes |
| Formula | `after_tax_cash = cash_value × 0.63` |
| Illustrative yield | **4% APY** on prize after-tax cash (money-market ballpark) |
| Interest income tax | **37%** federal + **13.3%** CA ≈ **50.3%** combined on fully taxable interest |

Data is fetched server-side from [calottery.com draw games](https://www.calottery.com/en/draw-games) and cached for 20 minutes.

> **Not tax advice.** Your actual federal tax depends on total income, filing status, deductions, and law changes. IRS withholding on large prizes is often 24%, which is not the same as your final rate.

## Quick start (Docker)

```bash
cd ca-lottery-aftertax
docker compose up --build -d
```

Open: [http://localhost:8742](http://localhost:8742)

| Endpoint | Description |
|----------|-------------|
| `GET /` | Dashboard |
| `GET /api/jackpots` | JSON jackpots + after-tax. If one game’s markup fails, the others are still returned and `missing_games` lists the gap. |
| `POST /api/refresh` | Force refresh (rate-limited to 1/min) |
| `GET /api/health` | Health check |

## Local development (no Docker)

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
pip install pytest
cd app && uvicorn main:app --reload --port 8742
```

Tests:

```bash
source .venv/bin/activate
pytest -q                 # includes a live calottery.com check; skipped if offline
pytest -q -m "not network"  # fixture + tax math only
```

## What each number means

| Label | Meaning |
|-------|---------|
| **After-tax cash** | Estimated take-home if you take the cash option and pay 37% federal tax |
| **Cash value (pre-tax)** | Lottery’s estimated lump-sum cash option |
| **Advertised jackpot** | Annuity jackpot estimate (paid over many years if chosen) |
| **Est. interest @ ~4% (after tax)** | Simple interest on prize after-tax cash, then reduced by ~50.3% ordinary tax on fully taxable interest (37% federal + 13.3% CA). Pretax interest is shown for comparison. US Treasuries are often CA-exempt; NIIT may also apply. |

## Project layout

```
ca-lottery-aftertax/
  app/
    main.py          # FastAPI
    lottery.py       # fetch, parse, tax, cache
    static/          # dashboard UI
  tests/
  Dockerfile
  docker-compose.yml
  requirements.txt
```

## License

Personal / self-hosted use. Jackpot data belongs to the California Lottery / multi-state games; this app only displays estimates for personal viewing.
