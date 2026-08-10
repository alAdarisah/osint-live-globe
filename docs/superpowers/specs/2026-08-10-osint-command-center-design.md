# OSINT Command Center (`cc`) — design

A full-screen terminal dashboard that runs on the Arch Linux box hosting the
stack. It answers three questions without leaving the terminal: is everything
up, is the backend actually doing work, and is the database coping — and it can
start, stop and rebuild the stack from the same screen.

It replaces the habit of keeping four SSH sessions open (`docker compose ps`,
`docker compose logs -f backend`, `curl /api/health | jq`, and a browser tunnel
to Grafana) with one screen that shows all four at once.

## Context

The stack is defined by `docker-compose.yml` at the repository root and runs
from `/opt/osint` on the server. It has eleven services; the ones this tool
watches are `postgres`, `redis`, `backend`, `ingest`, `refine`, `cache-worker`,
`frontend`, `postgres-exporter`, `prometheus` and `grafana`. The `migrate`
service sits behind a compose profile and is out of scope.

Three data surfaces already exist and are reused rather than duplicated:

- `GET localhost:8080/api/health` — per-source status from the in-memory
  registry, plus the open rows of the alerts table (`backend/app.py`).
- `localhost:9090` — Prometheus, scraping `postgres-exporter` and the backend's
  own `/metrics` endpoint (`backend/metrics.py`).
- `docker compose ps` / `docker stats` — container state, health, restart count
  and resource use.

The backend's `/metrics` is deliberately not published to the host; Prometheus
reaches it over the compose network. The command center therefore reads
application metrics *through* Prometheus rather than scraping the backend
directly, and no change to `docker-compose.yml` is required by this project.

## Decisions taken during design

- **Runs on the server, not on a workstation.** The Arch box is the machine the
  stack runs on, so every collector talks to localhost and the Docker CLI. There
  is no SSH transport and no remote mode.
- **Terminal UI, not a web page or desktop app.** It has to work over a bare SSH
  session on a headless server.
- **Python and Textual, not Go or shell.** The repository is already Python, so
  panels stay editable in the language everything else speaks and the collectors
  test under the existing pytest setup. Shell was rejected because streaming
  logs and live sparklines in `watch` loops do not survive contact with two
  panes updating at once.
- **Controls are enabled, with a `--read-only` flag.** The requirement asked for
  both one-button launch and a read-only dashboard; the flag reconciles them.
- **`cc` never reimplements deploy logic.** Rebuilds shell out to the existing
  `deploy.sh`, so there remains exactly one definition of which images are stale.
- **Styled on the Anthropic palette**, in colour and glyphs only — see *Visual
  theme*. A terminal's font belongs to whoever opened it.

## Layout

```
 ✳ osint command center                        osint @ arch-box
┌ SERVICES ─────────────────┬ SOURCES ──────────────────────┐
│ ● postgres     healthy    │ ● acled     4,201     12m ago │
│ ● backend      healthy    │ ● firms     9,133      2m ago │
│ ▲ ingest       ×3 rst     │ ▲ ais           —     47m STALE│
│ ● refine       up         │ ▲ 2 alerts: redis evicting    │
├ HOST ─────────────────────┴───────────────────────────────┤
│ cpu ▁▂▅▃▇ 34%   mem 61%   disk 44%   pgdata 8.1G          │
│ conn 12/100   oldest xact 4s   scrape 3/3 up              │
├ LOGS  [all ▾]  filter: ───────────────────────────────────┤
│ 12:03:11 backend  INFO  served /api/ships 214 rows        │
│ 12:03:12 ingest   WARN  aisstream backoff 30s             │
└───────────────────────────────────────────────────────────┘
 s up  x stop  r restart  d deploy  D deploy+ingest  / filter  g grafana  q quit
```

Four panes, always visible, no tab switching: the reason for the tool is seeing
container state, source production and log output at the same moment, because
the interesting failures are the ones where two of the three disagree.

Services and Sources are selectable lists. Selecting a service scopes both the
log pane and the restart key to it; selecting a source jumps the log filter to
that source's name, which is how a stale source is traced to the log line that
explains it.

## Modules

Collectors are plain async functions that import nothing from Textual and return
frozen dataclasses. That boundary is what makes them testable without a
terminal, and it keeps every subprocess and HTTP call out of the widget code.

| Module | Responsibility | Interval |
| --- | --- | --- |
| `ops/cc/collectors/compose.py` | `docker compose ps --format json` → `ServiceState` per container: state, health, restart count | 2 s |
| `ops/cc/collectors/stats.py` | `docker stats --no-stream --format json` → CPU and memory per container, merged into `ServiceState` | 5 s |
| `ops/cc/collectors/host.py` | CPU, memory, disk, load average and the size of the `pgdata` volume via psutil → `HostState` | 5 s |
| `ops/cc/collectors/health.py` | `GET /api/health` → `SourceState` per source plus the `alerts` list | 10 s |
| `ops/cc/collectors/prom.py` | A fixed set of PromQL instant queries plus `query_range` for the sparklines → `MetricState` | 15 s |
| `ops/cc/collectors/logs.py` | `docker compose logs -f --tail 200` as an async subprocess, yielding parsed `LogLine`s | streaming |
| `ops/cc/actions.py` | The mutating commands: up, stop, restart, `deploy.sh`, `deploy.sh --ingest`. Streams stdout to the log pane. | on demand |
| `ops/cc/state.py` | The single `State` object every collector writes into and every widget reads | — |
| `ops/cc/theme.py` | The two Textual themes and the semantic colour tokens every widget refers to | — |
| `ops/cc/app.py` | The Textual `App`: layout, key bindings, task supervision | — |
| `ops/cc/widgets/` | One file per pane: `services.py`, `sources.py`, `host.py`, `logs.py` | — |

The split between `compose.py` and `stats.py` exists because `docker stats`
costs an order of magnitude more than `docker compose ps` — it samples every
container — and state changes are what you want to see promptly, not a CPU
percentage. Running them on one interval would mean either sluggish state or a
process that is itself a visible load on the box it is monitoring.

Docker is read through the CLI rather than the socket API because
`docker compose ps` already resolves the project name, the health state and the
restart count, and it keeps working if the compose file gains a service.

### PromQL read by the host pane

Instant queries for the numbers, `query_range` over 15 minutes for the
sparklines. The set is fixed in `prom.py` rather than configurable, because a
dashboard whose contents are a config file is a worse Grafana:

- `pg_database_size_bytes{datname="osint"}` — pgdata growth
- `pg_connection_budget_used` against `pg_connection_budget_limit_ordinary` —
  connections as a fraction of what the server will allow, which is the form the
  number is actually read in
- `pg_long_running_max_transaction_seconds` — the age of the oldest open
  transaction, from the custom queries in
  `monitoring/postgres-exporter/queries.yaml`
- `up` — scrape health, rendered as "n/m up"
- `osint_alerts_active` — cross-check against the `/api/health` alerts block
- `rate(osint_http_requests_total[5m])` — backend request rate, the sparkline
  that shows the backend is serving

Every metric name above already appears in `monitoring/grafana/dashboards/` or
`monitoring/postgres-exporter/queries.yaml`, so the panes and the Grafana
dashboards cannot drift apart in what they claim to measure.

## Visual theme

The dashboard is styled on Anthropic's brand palette. A terminal owns its own
font, so typography is not something this tool can set — the theme is carried
entirely by colour, glyphs and spacing.

Colours are registered as a Textual theme in `theme.py`, and widgets refer only
to semantic tokens (`ok`, `warn`, `down`, `idle`, `value`, `muted`). No widget
names a hex value, so retheming is a one-file change.

| Token | Colour | Where it appears |
| --- | --- | --- |
| background | `#141413` | The screen |
| surface | `#1f1e1d` | Pane bodies, one step off the background so borders read without a stroke |
| foreground | `#faf9f5` | Primary text |
| muted | `#b0aea5` | Labels, units, timestamps, inactive key hints |
| border | `#e8e6dc` at 20% | Pane rules; full strength on the focused pane |
| accent / warn | `#d97757` | Focused pane title, selection bar, `WARN` lines, stale sources, the `✳` mark |
| value | `#6a9bcc` | Numbers and sparklines in the host pane |
| ok | `#788c5d` | Healthy containers, producing sources, exit code 0 |

`#1f1e1d` and the 20 % border are the only values not taken directly from the
brand palette; both are derived from the dark base because a four-pane layout
needs two surface levels and one rule weight that the palette does not name.

There is no red. The palette does not have one, and inventing a hue for the most
important state on the screen would be the wrong way to solve it: **failure is
shown by inverting the accent** — dark text on an orange block — so a stopped
container or a dead scrape reads as a solid bar rather than one more coloured
word among coloured words. Severity is carried by form, and the palette stays
closed.

The header is `✳ osint command center` with the mark in accent orange and the
compose project and hostname in muted grey on the right. `--light` swaps the
base pair (`#faf9f5` background, `#141413` text), keeps all three accents, and
darkens the muted grey to `#6b6a63` for contrast on the light ground; it exists
because a light terminal profile otherwise renders the whole dashboard as a dark
rectangle pasted into a light window.

Health states use both colour and shape, so the screen still parses on a
monochrome terminal or for a red-green colour-blind reader: `●` healthy, `◐`
starting, `▲` degraded or stale, inverted `■` down.

## Controls

| Key | Action | Guard |
| --- | --- | --- |
| `s` | `docker compose up -d` | none |
| `x` | `docker compose stop` | confirm dialog |
| `r` | `docker compose restart <selected>` | confirm only when the selection is `ingest` |
| `d` | `deploy.sh` | none |
| `D` | `deploy.sh --ingest` | typed confirmation: the word `INGEST` |
| `l` | scope the log pane to the selected service | — |
| `/` | filter log lines by substring | — |
| `f` | freeze log scrolling | — |
| `g`, `p` | print and copy the SSH tunnel command for Grafana or Prometheus | — |
| `q` | quit | — |

`D` is the only typed confirmation because it is the only key that costs money:
restarting `ingest` re-polls every metered source. `x` gets a plain confirm
because it stops collection; everything else is recoverable by pressing `s`.

Running under `--read-only` disables `s`, `x`, `r`, `d` and `D`, and shows them
struck through in the footer. No other behaviour changes.

`g` and `p` print a command rather than opening a browser: the server is
headless, so the useful output is
`ssh -L 3000:localhost:3000 <host>`, copied to the clipboard when one is
available and printed regardless.

## Failure handling

The dashboard is what you look at when things are broken, so no collector
failure may take the screen with it.

- Each collector runs in its own supervised asyncio task with a 5 s timeout. An
  exception is caught, logged to the log pane, and the task restarts on its next
  interval.
- A pane whose collector last failed keeps its most recent values, dims them,
  and shows `stale 40s`. It never blanks and never shows zeros, because a zero
  that means "not measured" is indistinguishable from a zero that means "no
  requests" and would send you debugging the wrong process.
- Prometheus or the backend being down is an expected state, not an error: the
  respective pane says `unreachable` and the rest of the screen keeps updating.
  This is the normal state during a cold start, before `s` has been pressed.
- The log subprocess is restarted with backoff if `docker compose logs` exits,
  which happens whenever the stack is stopped and started again.
- An action that exits non-zero leaves its output in the log pane and shows the
  exit code in the footer. The tool does not attempt recovery.

## Testing

Collectors are tested directly, with no terminal involved, using pytest as the
rest of the repository does. The parsing layer is where the bugs are, so that is
what gets covered:

- `compose.py` against recorded `docker compose ps --format json` output,
  including a container that is restarting, one that is unhealthy, and one that
  is missing entirely.
- `health.py` against a recorded `/api/health` body, including a stale source, a
  source with a zero item count, and a body carrying alerts.
- `prom.py` against recorded Prometheus responses, including an empty result set
  and a query error, both of which must produce "unreachable" rather than raise.
- `logs.py` against a fixture stream, checking level parsing and the service
  prefix split.
- `actions.py` with the command runner stubbed, asserting the exact argv for
  each key, that `--read-only` refuses every mutating action, and that `D`
  without the typed word does not invoke `deploy.sh`.

Widget rendering is covered by Textual's snapshot testing for the four panes at
one representative state each. This is deliberately shallow: the value is in the
collectors, and pinning exact terminal output would make every layout tweak a
test failure.

`theme.py` gets one real test rather than a snapshot: every semantic token
resolves in both the dark and the light theme, and the two themes define the
same token set. A token that exists in one theme only is the failure that shows
up as an invisible pane on somebody else's terminal.

## Installation on the Arch box

`ops/cc/requirements.txt` holds `textual` and `psutil` only; they stay out of
the backend images, which have no reason to carry a TUI.

```
python -m venv /opt/osint/ops/cc/.venv
/opt/osint/ops/cc/.venv/bin/pip install -r /opt/osint/ops/cc/requirements.txt
```

`/usr/local/bin/cc` is a wrapper that `cd`s to `/opt/osint` and runs
`ops/cc/.venv/bin/python -m ops.cc "$@"`, so `cc` works from any directory. The
compose project directory is `/opt/osint` by default and overridable with
`--compose-dir`, which is what makes the tool runnable from a checkout on
another machine.

The user running `cc` must be in the `docker` group. No systemd unit and no
elevated privileges: this is a program you run, not a service.

## Out of scope

- Remote operation over SSH. The tool runs on the box it manages.
- Editing Admin Mode configuration, which belongs to the web UI.
- Alerting or notification. The cache worker already owns that, including the
  webhook.
- Anything that writes to Postgres. The command center is a reader of the
  database and a driver of Docker, nothing else.
- Replacing the Grafana dashboards. The host pane shows the half-dozen numbers
  worth glancing at; the graphs stay in Grafana.
