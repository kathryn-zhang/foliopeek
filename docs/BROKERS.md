# Getting a positions CSV out of your broker

Ledger reads three things from a broker export: **ticker**, **share count**,
and (when present) **average cost per share**. Everything else — account
numbers, names, balances — is ignored, and the file itself is never stored or
uploaded. Column names vary by broker; Ledger recognizes each broker's
wording automatically, and the review screen always shows you exactly what
was read before anything is applied.

One general tip: export a **positions/holdings** file, not a *transactions*
or *order history* file. Transactions are individual buys and sells; Ledger
wants what you hold right now.

| Broker | Positions CSV? | Cost basis included? | Status |
|---|---|---|---|
| Vanguard | ✓ | ✓ (per lot, aggregated automatically) | ✅ tested |
| E*Trade | ✓ | ✓ | ✅ tested |
| Fidelity | ✓ | ✓ | expected to work |
| Charles Schwab | ✓ | partial (blank for IRAs) | expected to work |
| Merrill Edge | ✓ | ✓ ("Unit Cost") | expected to work |
| Interactive Brokers | ✓ (Flex Query) | ✓ | expected to work |
| Robinhood | ✗ no positions export | — | add positions manually |
| Webull | ✗ orders only, by email | — | add positions manually |

If your broker isn't listed, try the export anyway — Ledger looks for any
column resembling *Symbol/Ticker* and *Quantity/Shares*. If it isn't
recognized, open an issue with the CSV's **header row only** (never include
data rows — they contain your holdings).

## Vanguard ✅

1. Log in → **My Accounts → Cost basis** (or **Download center**).
2. Download the unrealized cost basis CSV.
3. Vanguard exports one row per tax lot; Ledger sums the shares and
   share-weights the cost automatically.

## E*Trade ✅

1. Log in → **Accounts → Portfolios**.
2. Use the download/export control on the positions view to save a CSV.
3. Note: E*Trade writes class shares as `BRK.B`; Ledger converts to Yahoo's
   `BRK-B` form automatically.

## Fidelity

1. Log in → select the account → **Positions**.
2. Switch the view to **Full View** first so cost-basis columns are included.
3. Click the **Download** icon at the upper right of the positions table.
4. The file includes `Symbol`, `Quantity`, and `Average Cost Basis` /
   `Cost Basis Per Share` — all recognized. Cash sweeps like `SPAXX**` and
   the disclaimer lines at the bottom of the file are skipped automatically.

## Charles Schwab

1. Log in → **Accounts → Positions**.
2. Pick the account from the dropdown, then click **Export** (upper right)
   and choose CSV.
3. Schwab's `Qty (Quantity)` column is recognized. Its `Cost Basis` column is
   a *total*, not per-share, so Ledger leaves avg cost blank rather than
   guessing wrong — click the dashed **avg cost** cell to fill it in if you
   want gain/loss. For IRAs Schwab often leaves cost basis blank entirely;
   that's expected.

## Merrill Edge

1. Log in → **Accounts → Holdings**.
2. Above the holdings table on the right, click **Export → Export as
   Comma-Separated Spreadsheet (.CSV)**.
3. Merrill's `Unit Cost` column is read as the per-share cost.

## Interactive Brokers

IBKR buries exports under **Flex Queries**, but it's a one-time setup:

1. Log in to Client Portal → **Performance & Reports → Flex Queries**.
2. Create a new **Activity Flex Query** with only the **Open Positions**
   section selected; include at least *Symbol*, *Quantity*, and
   *Cost Basis Price*. Format: CSV, include header row.
3. Save it once; re-running the query is two clicks on future updates.

## Robinhood

Robinhood has **no holdings CSV export** — its reports cover transaction
history only, and statements are PDF. Options:

- Add your positions manually in Ledger (source: give it a name like
  "Robinhood" so future edits stay organized). For a typical Robinhood
  account this is a few minutes, once — after that you only edit shares
  when you trade.
- Third-party statement converters exist, but sending your brokerage
  statement to a third party is exactly what Ledger exists to avoid.

## Webull

Webull emails order-history spreadsheets (Account → Orders → Export Orders,
one export per day) but has no positions export. As with Robinhood, add
holdings manually under a "Webull" source.

---

*Broker sites move things around. If a path above is stale, the constants
are: find the **positions/holdings** page, look for a download/export
control, choose CSV. Corrections welcome — open an issue.*
