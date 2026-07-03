# Contributing to FolioPeek

Thanks for the interest! This is a spare-time personal project, so review is
best-effort — small, focused changes land fastest.

## Running it

```sh
python3 server.py
```

That's the whole setup. Frontend is plain HTML/CSS/JS (no build step), the
server is one dependency-free Python file.

## Developing with fake data

Never test against your real portfolio. Instead:

```sh
python3 scripts/make_demo.py     # generates demo/ with a 26-position fake portfolio
python3 demo/server.py 8899     # isolated instance on its own port
```

The demo instance has its own backup file (inside `demo/`) and its own
browser origin (different port), so it can't touch a real instance's data.
It symlinks the frontend, so your code changes show up on reload. It also
writes three broker-style CSVs (`demo/*.csv`) that exercise the import flow
— lot aggregation, `BRK.B` normalization, cash-sweep and footer filtering —
and match the seeded portfolio exactly. Screenshots in the README come from
this instance.

## The most valuable contribution: broker CSV formats

If your broker's positions export isn't recognized, open an issue with the
CSV's **header row and one fake data row** — never real data rows, they
contain your holdings. Column-name hints live in `HEADER_HINTS` in `app.js`;
adding a broker is usually a one-line change plus a section in
`docs/BROKERS.md`.

## Scope

Out of scope by design: accounts, cloud sync, bank/broker API linking,
trading, and anything that requires user data to leave the machine.
Privacy-first is the product, not a feature.

## Licensing of contributions

FolioPeek is AGPL-3.0. By submitting a contribution you agree it's licensed
under the project's license (inbound = outbound).
