# Contributing to FolioPeek

Thanks for the interest! This is a spare-time personal project, so review is
best-effort — small, focused changes land fastest.

## Running it

```sh
python3 server.py
```

That's the whole setup. Frontend is plain HTML/CSS/JS (no build step), the
server is one dependency-free Python file.

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
