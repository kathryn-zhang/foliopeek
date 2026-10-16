#!/usr/bin/env python3
"""FolioPeek — local stocks tracker.

Serves the static frontend and proxies quote requests to Yahoo Finance,
because Yahoo blocks cross-origin requests from browsers. Everything runs
on your machine; portfolio data never leaves the browser's localStorage.

Usage:  python3 server.py  [port]
"""

import json
import re
import sys
import threading
import time
import urllib.parse
import urllib.request
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8742
ROOT = Path(__file__).resolve().parent

YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart/{sym}?range=1d&interval=1d"
YAHOO_HISTORY = ("https://query1.finance.yahoo.com/v8/finance/chart/{sym}"
                 "?range=10y&interval=1mo")
YAHOO_DAILY = ("https://query1.finance.yahoo.com/v8/finance/chart/{sym}"
               "?period1={start}&period2={end}&interval=1d&events=split")
USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"

CACHE_TTL = 30  # seconds; be polite to Yahoo, quotes don't move faster than this matters
_cache: dict[str, tuple[float, dict]] = {}
_cache_lock = threading.Lock()

# Long-run returns move slowly; a few hours of caching keeps Overview cheap.
HISTORY_TTL = 6 * 3600
_history: dict[str, tuple[float, dict]] = {}
_history_lock = threading.Lock()

# The browser's localStorage is the primary store but fragile (clearing site
# data wipes it); the frontend mirrors every change here so it can be restored.
BACKUP_FILE = ROOT / "ledger_backup.json"
BACKUP_DIR = ROOT / "backups"  # one dated snapshot per day, last 7 kept
_backup_lock = threading.Lock()


def _rotate_backup():
    """Snapshot the existing backup once per day before overwriting it.

    Protects against the wipe scenario: cleared localStorage + declined
    restore + one edit would otherwise replace the only copy on disk with
    near-empty state.  Caller holds _backup_lock.
    """
    if not BACKUP_FILE.exists():
        return
    try:
        BACKUP_DIR.mkdir(exist_ok=True)
        snap = BACKUP_DIR / f"ledger_backup-{time.strftime('%Y-%m-%d')}.json"
        if not snap.exists():
            snap.write_bytes(BACKUP_FILE.read_bytes())
            for old in sorted(BACKUP_DIR.glob("ledger_backup-*.json"))[:-7]:
                old.unlink(missing_ok=True)
    except OSError:
        pass  # rotation is best-effort; the live backup still gets written

# Company profiles (sector/industry) need Yahoo's cookie+crumb handshake and
# essentially never change, so they're cached on disk across runs.
PROFILE_CACHE_FILE = ROOT / "sector_cache.json"
_profiles: dict[str, dict] = {}
_profiles_lock = threading.Lock()
_auth = {"cookie": "", "crumb": ""}
_auth_lock = threading.Lock()

try:
    _profiles.update(json.loads(PROFILE_CACHE_FILE.read_text()))
except (OSError, ValueError):
    pass


def _yahoo_auth(force=False):
    with _auth_lock:
        if _auth["crumb"] and not force:
            return dict(_auth)
        try:  # fc.yahoo.com 404s but sets the session cookie we need
            urllib.request.urlopen(
                urllib.request.Request("https://fc.yahoo.com", headers={"User-Agent": USER_AGENT}),
                timeout=10)
            cookie = ""
        except urllib.error.HTTPError as e:
            cookie = (e.headers.get("Set-Cookie") or "").split(";")[0]
        req = urllib.request.Request(
            "https://query1.finance.yahoo.com/v1/test/getcrumb",
            headers={"User-Agent": USER_AGENT, "Cookie": cookie})
        with urllib.request.urlopen(req, timeout=10) as resp:
            crumb = resp.read().decode().strip()
        _auth.update(cookie=cookie, crumb=crumb)
        return dict(_auth)


def fetch_profile(symbol: str) -> dict:
    with _profiles_lock:
        if symbol in _profiles:
            return _profiles[symbol]
    profile = {"symbol": symbol, "sector": None, "industry": None}
    persist = False
    for attempt in (0, 1):  # retry once with fresh auth on 401/403
        try:
            auth = _yahoo_auth(force=attempt > 0)
            url = ("https://query1.finance.yahoo.com/v10/finance/quoteSummary/"
                   f"{urllib.parse.quote(symbol)}?modules=assetProfile"
                   f"&crumb={urllib.parse.quote(auth['crumb'])}")
            req = urllib.request.Request(
                url, headers={"User-Agent": USER_AGENT, "Cookie": auth["cookie"]})
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.load(resp)
            p = data["quoteSummary"]["result"][0]["assetProfile"]
            profile.update(sector=p.get("sector"), industry=p.get("industry"))
            persist = True
            break
        except urllib.error.HTTPError as e:
            if e.code in (401, 403) and attempt == 0:
                continue
            persist = e.code == 404  # symbol has no profile; remember that
            break
        except Exception:  # noqa: BLE001 - network errors are retried next request
            break
    if persist:
        with _profiles_lock:
            _profiles[symbol] = profile
            try:
                PROFILE_CACHE_FILE.write_text(json.dumps(_profiles, indent=0))
            except OSError:
                pass
    return profile


def fetch_quote(symbol: str) -> dict:
    """Fetch one symbol from Yahoo's chart endpoint (no auth crumb needed)."""
    now = time.time()
    with _cache_lock:
        hit = _cache.get(symbol)
        if hit and now - hit[0] < CACHE_TTL:
            return hit[1]

    url = YAHOO_CHART.format(sym=urllib.parse.quote(symbol))
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            payload = json.load(resp)
        result = payload["chart"]["result"][0]
        meta = result["meta"]
    except Exception as exc:  # noqa: BLE001 - report per-symbol failure to the client
        quote = {"symbol": symbol, "error": str(exc)[:200]}
        with _cache_lock:  # negative-cache: don't re-hit Yahoo for a dead ticker every batch
            _cache[symbol] = (now, quote)
        return quote

    price = meta.get("regularMarketPrice")
    prev = meta.get("previousClose") or meta.get("chartPreviousClose")
    change = change_pct = None
    if price is not None and prev:
        change = price - prev
        change_pct = change / prev * 100

    # Market state: inside today's regular trading window?
    market_open = False
    try:
        regular = meta["currentTradingPeriod"]["regular"]
        market_open = regular["start"] <= int(now) < regular["end"]
    except (KeyError, TypeError):
        pass

    quote = {
        "symbol": meta.get("symbol", symbol),
        "name": meta.get("longName") or meta.get("shortName") or symbol,
        "price": price,
        "previousClose": prev,
        "change": change,
        "changePct": change_pct,
        "currency": meta.get("currency", "USD"),
        "quoteType": meta.get("instrumentType"),
        "fiftyTwoWeekLow": meta.get("fiftyTwoWeekLow"),
        "fiftyTwoWeekHigh": meta.get("fiftyTwoWeekHigh"),
        "marketOpen": market_open,
        "marketTime": meta.get("regularMarketTime"),
    }
    with _cache_lock:
        _cache[symbol] = (now, quote)
    return quote


def fetch_history_return(symbol: str) -> dict:
    """Annualized total return over up to 10 years of monthly dividend-adjusted closes."""
    now = time.time()
    with _history_lock:
        hit = _history.get(symbol)
        if hit and now - hit[0] < HISTORY_TTL:
            return hit[1]

    url = YAHOO_HISTORY.format(sym=urllib.parse.quote(symbol))
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            result = json.load(resp)["chart"]["result"][0]
        points = [(t, c) for t, c in zip(result["timestamp"],
                                         result["indicators"]["adjclose"][0]["adjclose"])
                  if c]
        (t0, c0), (t1, c1) = points[0], points[-1]
        years = (t1 - t0) / (365.25 * 86400)
        # Under three years is too short to call a long-run return.
        cagr = (c1 / c0) ** (1 / years) - 1 if years >= 3 else None
        out = {"symbol": symbol, "cagr": cagr, "years": round(years, 1)}
    except Exception as exc:  # noqa: BLE001 - report per-symbol failure to the client
        out = {"symbol": symbol, "error": str(exc)[:200]}
    with _history_lock:
        _history[symbol] = (now, out)
    return out


def fetch_factors(symbol: str, since: str) -> dict:
    """Distribution factors and splits since a date, for telling growth from new money.

    `factors` is adjclose/close per trading day, emitted only where it changes:
    the ratio steps up across every dividend or fund capital-gain distribution
    (Yahoo folds both into adjclose), so factor(b)/factor(a) is the payout
    reinvested between two dates. `splits` are (date, ratio) pairs.
    """
    key = f"{symbol}@{since}"
    now = time.time()
    with _history_lock:
        hit = _history.get(key)
        if hit and now - hit[0] < HISTORY_TTL:
            return hit[1]

    try:
        start = int(time.mktime(time.strptime(since, "%Y-%m-%d"))) - 7 * 86400
        url = YAHOO_DAILY.format(sym=urllib.parse.quote(symbol), start=start, end=int(now) + 86400)
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=10) as resp:
            result = json.load(resp)["chart"]["result"][0]
        day = lambda ts: time.strftime("%Y-%m-%d", time.gmtime(ts))  # noqa: E731
        factors, last = [], None
        for t, c, a in zip(result.get("timestamp") or [],
                           result["indicators"]["quote"][0]["close"],
                           result["indicators"]["adjclose"][0]["adjclose"]):
            if not c or not a:
                continue
            f = round(a / c, 6)
            if last is None or abs(f / last - 1) > 2e-5:  # skip float jitter between bars
                factors.append([day(t), f])
                last = f
        splits = [[day(int(sp["date"])), sp["numerator"] / sp["denominator"]]
                  for sp in (result.get("events", {}).get("splits") or {}).values()]
        out = {"symbol": symbol, "factors": factors, "splits": sorted(splits)}
    except Exception as exc:  # noqa: BLE001 - report per-symbol failure to the client
        out = {"symbol": symbol, "error": str(exc)[:200]}
    with _history_lock:
        _history[key] = (now, out)
    return out


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def _local_host(self) -> bool:
        """Reject requests whose Host header isn't this machine.

        Blocks DNS-rebinding: a hostile page pointing evil.com at 127.0.0.1
        would reach us with Host: evil.com and could otherwise read the
        backup (holdings) cross-origin.
        """
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]").lower()
        return host in ("127.0.0.1", "localhost", "::1")

    def do_GET(self):  # noqa: N802 - http.server API
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.startswith("/api/") and not self._local_host():
            self.send_json({"error": "forbidden"}, status=403)
            return
        if parsed.path == "/api/quotes":
            self.handle_symbols(parsed, fetch_quote)
        elif parsed.path == "/api/sectors":
            self.handle_symbols(parsed, fetch_profile)
        elif parsed.path == "/api/returns":
            self.handle_symbols(parsed, fetch_history_return)
        elif parsed.path == "/api/factors":
            since = urllib.parse.parse_qs(parsed.query).get("since", [""])[0]
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", since):
                self.send_json({"error": "since must be YYYY-MM-DD"}, status=400)
                return
            self.handle_symbols(parsed, lambda sym: fetch_factors(sym, since))
        elif parsed.path == "/api/backup":
            try:
                body = BACKUP_FILE.read_bytes()
            except OSError:
                self.send_json({"error": "no backup"}, status=404)
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            super().do_GET()

    def end_headers(self):
        # Local-only dev tool: never let the browser cache static files, or an
        # updated index.html will be paired with a stale app.js (column drift).
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_POST(self):  # noqa: N802 - http.server API
        if urllib.parse.urlparse(self.path).path != "/api/backup":
            self.send_json({"error": "not found"}, status=404)
            return
        if not self._local_host():
            self.send_json({"error": "forbidden"}, status=403)
            return
        # A hostile web page can fire a no-cors POST at 127.0.0.1 with our
        # own Host header, but no-cors requests can't set application/json —
        # requiring it means only same-origin (our frontend) writes land.
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if ctype != "application/json":
            self.send_json({"error": "expected application/json"}, status=415)
            return
        length = int(self.headers.get("Content-Length") or 0)
        if not 0 < length <= 5_000_000:
            self.send_json({"error": "bad length"}, status=400)
            return
        raw = self.rfile.read(length)
        try:
            json.loads(raw)  # only well-formed JSON gets persisted
        except ValueError:
            self.send_json({"error": "invalid json"}, status=400)
            return
        with _backup_lock:
            _rotate_backup()
            tmp = BACKUP_FILE.with_suffix(".tmp")
            tmp.write_bytes(raw)
            tmp.replace(BACKUP_FILE)  # atomic: never leaves a half-written backup
        self.send_json({"ok": True})

    def handle_symbols(self, parsed, fetcher):
        params = urllib.parse.parse_qs(parsed.query)
        raw = params.get("symbols", [""])[0]
        symbols = [s.strip().upper() for s in raw.split(",") if s.strip()][:60]
        if not symbols:
            self.send_json({"error": "no symbols"}, status=400)
            return
        with ThreadPoolExecutor(max_workers=min(8, len(symbols))) as pool:
            results = list(pool.map(fetcher, symbols))
        self.send_json({"quotes": results})

    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        # Quiet console: only echo API traffic. Render args defensively —
        # error paths pass non-string values like HTTPStatus.
        try:
            msg = fmt % args
        except (TypeError, ValueError):
            msg = f"{fmt} {args}"
        if "/api/" in msg:
            sys.stderr.write(f"{msg}\n")


def main():
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    url = f"http://127.0.0.1:{PORT}"
    print(f"FolioPeek running at {url}  (Ctrl-C to stop)")
    threading.Timer(0.5, webbrowser.open, [url]).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
