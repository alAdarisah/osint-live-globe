# cc — the command center

A terminal dashboard for the stack this repository defines. Runs on the server,
shows container state, source production, database health and the live log on
one screen, and can start, stop, restart and rebuild from the same keys.

```
 ✳ osint command center                        osint @ arch-box
┌ SERVICES ─────────────────┬ SOURCES ──────────────────────┐
│ ● postgres     healthy    │ ● acled     4,201     12m ago │
│ ● backend      healthy    │ ● firms     9,133      2m ago │
│ ▲ ingest       ×3 rst     │ ■ ais           —  aisstream… │
│ ● refine       up         │ ▲ redis     evicting          │
├ HOST ─────────────────────┴───────────────────────────────┤
│ cpu ▁▂▅▃▇ 34%   mem 61%   disk 44%   load 1.25            │
│ db 7.6G   conn 12/100   oldest xact 4s   scrape 3/3 up    │
├ LOGS [all] ───────────────────────────────────────────────┤
│ backend      served /api/ships 214 rows                   │
│ ingest       WARN aisstream backoff 30s                   │
└───────────────────────────────────────────────────────────┘
```

## Install (Arch Linux server)

```bash
sudo pacman -S --needed python docker docker-compose
./ops/cc/install.sh /opt/osint
cc
```

The user running `cc` must be in the `docker` group. No root, and no systemd
unit: this is a program you run, not a service.

## Keys

| Key | Does |
| --- | --- |
| `s` | `docker compose up -d` |
| `x` | `docker compose stop` (asks first) |
| `r` | restart the selected service (asks first for `ingest`) |
| `d` | `deploy.sh` — rebuild whatever is behind its source |
| `D` | `deploy.sh --ingest` — also rebuild ingest. Type `INGEST` to confirm; this re-polls every metered source |
| `l` | scope the log pane to the selected service |
| `/` | filter log lines |
| `f` | freeze log scrolling |
| `g`, `p` | print and copy the SSH tunnel command for Grafana or Prometheus |
| `q` | quit |

`--read-only` disables `s x r d D`. `--light` switches to the light theme.
`--compose-dir` points it at a checkout somewhere other than `/opt/osint`.

## What it reads

| Pane | Source | Interval |
| --- | --- | --- |
| SERVICES | `docker compose ps`, `docker inspect`, `docker stats` | 2 s / 5 s |
| SOURCES | `/api/health` — the registry plus the open alert rows | 10 s |
| HOST | psutil, and a fixed set of PromQL against `localhost:9090` | 5 s / 15 s |
| LOGS | `docker compose logs -f` | streaming |

A collector that fails leaves its pane holding the last good values, dimmed.
It never blanks, and never shows a zero it did not measure — during an outage
those two are the whole question.

Source health is *not* recomputed here. `backend/mirror.py` decides staleness
per source from that job's `expected_every`, and publishes it as `last_error`;
a threshold invented in this tool would disagree with the map the first time a
six-hourly source polled exactly on schedule.

## Development

```bash
python -m venv .venv && .venv/bin/pip install -r ops/cc/requirements-dev.txt
.venv/bin/python -m pytest ops/cc/tests
.venv/bin/python -m ops.cc --compose-dir .
```

Collectors import nothing from Textual, which is why the tests need no
terminal. Keep it that way: anything that needs a widget to be tested is
usually a row builder that wants extracting.

Design: `docs/superpowers/specs/2026-08-10-osint-command-center-design.md`
