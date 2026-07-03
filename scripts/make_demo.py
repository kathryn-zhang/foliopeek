#!/usr/bin/env python3
"""Generate the FolioPeek demo instance — an isolated copy of the app with a
realistic fake portfolio, for development, testing, and screenshots, without
ever touching real data.

Creates demo/ in the repo root:
  - copies server.py there, so the demo's backup file and history live in
    demo/ and can never collide with a real instance's data
  - symlinks the frontend (index.html, app.js, style.css, fonts) so code
    changes show up in the demo instantly (falls back to copying where
    symlinks aren't available)
  - writes three broker-style positions CSVs (Vanguard lot-level, E*Trade,
    Fidelity with cash sweep + disclaimer footer) to exercise the import flow
  - seeds demo/ledger_backup.json with the same 26 positions, a 5-ticker
    watchlist, and ~75 weekdays of value history ending at today's live
    total (prices from Yahoo via server.py's fetcher; falls back to cost
    basis if offline)

Usage:
    python3 scripts/make_demo.py [--force]
    python3 demo/server.py 8899        # then open http://127.0.0.1:8899

On first open, accept the restore prompt to load the seeded portfolio.
Run on a port your real instance doesn't use — a different port means a
different browser origin, so the demo's localStorage is fully separate.

--force regenerates the demo's data files. demo/screenshots/ and anything
else you put in demo/ are never touched.
"""

import json
import random
import shutil
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEMO = ROOT / "demo"

# ─────────────────────── The fake portfolio ───────────────────────
# Legitimate tickers across ~10 sectors, three "brokerage" sources. The CSVs
# and the seeded backup are both generated from these tables, so the import
# files and the pre-loaded state always agree.

VANGUARD_LOTS = [  # (symbol, fund name, shares, cost/share, date acquired)
    ("VTSAX", "Vanguard Total Stock Market Index Admiral", 400, 98.42, "03/15/2019"),
    ("VTSAX", "Vanguard Total Stock Market Index Admiral", 250, 112.75, "06/22/2021"),
    ("VTSAX", "Vanguard Total Stock Market Index Admiral", 200, 131.40, "01/10/2024"),
    ("VOO", "Vanguard S&P 500 ETF", 60, 385.20, "02/03/2022"),
    ("VOO", "Vanguard S&P 500 ETF", 60, 412.55, "11/17/2023"),
    ("BND", "Vanguard Total Bond Market ETF", 120, 74.85, "05/09/2022"),
    ("BND", "Vanguard Total Bond Market ETF", 80, 69.30, "10/26/2023"),
    ("VNQ", "Vanguard Real Estate ETF", 80, 84.30, "08/14/2023"),
]

ETRADE = [  # (symbol as E*Trade writes it, shares, price paid)
    ("AAPL", 150, 187.40), ("NVDA", 220, 45.18), ("MSFT", 90, 310.22),
    ("GOOGL", 100, 138.65), ("JPM", 60, 145.80), ("V", 45, 230.10),
    ("XOM", 110, 102.35), ("CAT", 30, 285.50), ("DIS", 120, 90.15),
    ("BRK.B", 25, 352.00), ("VOO", 20, 445.00),
]

FIDELITY = [  # (symbol, description, shares, avg cost basis)
    ("QQQ", "INVESCO QQQ TRUST", 85, 380.25),
    ("SCHD", "SCHWAB US DIVIDEND EQUITY ETF", 300, 74.60),
    ("LLY", "ELI LILLY AND CO", 40, 580.30),
    ("UNH", "UNITEDHEALTH GROUP INC", 35, 480.20),
    ("JNJ", "JOHNSON & JOHNSON", 90, 152.75),
    ("COST", "COSTCO WHOLESALE CORP", 25, 720.90),
    ("PG", "PROCTER & GAMBLE CO", 80, 148.30),
    ("NEE", "NEXTERA ENERGY INC", 150, 68.45),
    ("MCD", "MCDONALD'S CORP", 30, 265.80),
    ("UNP", "UNION PACIFIC CORP", 40, 220.10),
    ("KO", "COCA-COLA CO, THE", 200, 58.90),
]

WATCHLIST = ["AMD", "TSLA", "PLTR", "SBUX", "UBER"]

HISTORY_DAYS = 75  # weekdays of synthetic value history behind today


def dash(sym: str) -> str:
    """BRK.B (broker form) -> BRK-B (Yahoo form), as the app normalizes it."""
    return sym.replace(".", "-")


def build_portfolio():
    """One row per (symbol, source), Vanguard lots aggregated share-weighted."""
    rows = []
    agg = {}
    for sym, _name, sh, cost, _d in VANGUARD_LOTS:
        a = agg.setdefault(sym, [0.0, 0.0])
        a[0] += sh
        a[1] += sh * cost
    for sym, (sh, total) in agg.items():
        rows.append({"sym": sym, "shares": sh, "cost": round(total / sh, 4), "src": "Vanguard"})
    for sym, sh, cost in ETRADE:
        rows.append({"sym": dash(sym), "shares": sh, "cost": cost, "src": "E*Trade"})
    for sym, _desc, sh, cost in FIDELITY:
        rows.append({"sym": sym, "shares": sh, "cost": cost, "src": "Fidelity"})
    return rows


def write_csvs(stamp: str):
    van = [f"Cost basis as of {stamp} for account ending in 5678",
           "Unrealized gains and losses - individual lots", "",
           "Symbol,Investment Name,Shares,Cost per Share,Total Cost,Date Acquired"]
    for sym, name, sh, cost, d in VANGUARD_LOTS:
        van.append(f"{sym},{name},{sh:.4f},{cost:.4f},{sh * cost:.2f},{d}")

    et = [f"Positions,Account: Individual Brokerage -9012,As of {stamp}", "",
          "Symbol,Quantity,Price Paid $,Total Gain $,Value $"]
    for sym, sh, cost in ETRADE:
        et.append(f"{sym},{sh},{cost:.2f},+{sh * cost * 0.31:.2f},{sh * cost * 1.31:.2f}")

    fid = ["Account Number,Account Name,Symbol,Description,Quantity,Last Price,"
           "Average Cost Basis,Cost Basis Total,Type",
           "X12-345678,ROTH IRA,SPAXX**,FIDELITY GOVERNMENT MONEY MARKET,12345.67,1.00,,,Cash"]
    for sym, desc, sh, cost in FIDELITY:
        d = f'"{desc}"' if "," in desc else desc
        fid.append(f"X12-345678,ROTH IRA,{sym},{d},{sh},,{cost:.2f},{sh * cost:.2f},Cash")
    fid += ["", '"The data and information in this spreadsheet is provided to you'
            ' for your fidelity account records."', f'"Date downloaded {stamp}"']

    for name, lines in [("vanguard_costbasis.csv", van),
                        ("etrade_positions.csv", et),
                        ("fidelity_positions.csv", fid)]:
        (DEMO / name).write_text("\n".join(lines) + "\n")


def fetch_prices(symbols):
    """Live prices via server.py's own fetcher; {} if offline."""
    # server.py parses sys.argv at import time — hide our args from it.
    argv, sys.argv = sys.argv, [sys.argv[0]]
    sys.path.insert(0, str(ROOT))
    try:
        import server  # noqa: PLC0415 - deliberate late import, see above
    finally:
        sys.argv = argv
    try:
        with ThreadPoolExecutor(max_workers=8) as pool:
            quotes = list(pool.map(server.fetch_quote, symbols))
        return {q["symbol"]: q["price"] for q in quotes if q.get("price")}
    except Exception:
        return {}


def make_history(total: float):
    """~75 weekdays of plausible value history ending at today's total."""
    random.seed(42)  # deterministic: re-running yields the same chart
    hist, v, d = [], total, date.today()
    for _ in range(HISTORY_DAYS):
        while d.weekday() > 4:
            d -= timedelta(days=1)
        hist.append({"d": d.isoformat(), "total": round(v, 2), "cats": {}})
        v /= 1 + random.gauss(0.0011, 0.007)  # invert one day's return
        d -= timedelta(days=1)
    hist.reverse()
    return hist


def link_frontend():
    (DEMO / "server.py").write_bytes((ROOT / "server.py").read_bytes())
    for name in ["index.html", "app.js", "style.css", "fonts.css",
                 "fonts", "sample_positions.csv"]:
        dst = DEMO / name
        if dst.is_symlink():
            continue  # already pointing at the repo file
        if dst.exists():
            shutil.rmtree(dst) if dst.is_dir() else dst.unlink()
        try:
            dst.symlink_to(Path("..") / name)
        except OSError:  # e.g. Windows without developer mode
            src = ROOT / name
            shutil.copytree(src, dst) if src.is_dir() else shutil.copy2(src, dst)


def main():
    force = "--force" in sys.argv
    backup_file = DEMO / "ledger_backup.json"
    if backup_file.exists() and not force:
        sys.exit(f"{backup_file} already exists — re-run with --force to regenerate.\n"
                 "(demo/screenshots/ and other extra files are never touched.)")

    DEMO.mkdir(exist_ok=True)
    link_frontend()
    stamp = date.today().strftime("%m/%d/%Y")
    write_csvs(stamp)

    portfolio = build_portfolio()
    prices = fetch_prices(sorted({p["sym"] for p in portfolio} | set(WATCHLIST)))
    if prices:
        total = sum(p["shares"] * prices[p["sym"]] for p in portfolio if p["sym"] in prices)
        src = "live Yahoo prices"
    else:  # offline: pretend everything is up 25% from cost
        total = sum(p["shares"] * p["cost"] * 1.25 for p in portfolio)
        src = "cost basis (offline fallback)"

    backup_file.write_text(json.dumps({
        "savedAt": f"{date.today().isoformat()}T12:00:00.000Z",
        "portfolio": portfolio,
        "watchlist": WATCHLIST,
        "history": make_history(total),
    }, indent=1))

    print(f"demo/ ready — {len(portfolio)} positions, {len(WATCHLIST)} watched, "
          f"{HISTORY_DAYS} days of history ending at ${total:,.0f} ({src}).")
    print("\nNext:  python3 demo/server.py 8899   then open http://127.0.0.1:8899")
    print("(accept the restore prompt on first open; import the demo/*.csv files")
    print(" to exercise the import flow — they match the seeded portfolio)")


if __name__ == "__main__":
    main()
