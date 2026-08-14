# Security

What protects this deployment, where the boundaries actually are, and the
credential rotations that are still yours to do.

## The shape of the thing

Two doors into the same app, and they are the whole access model:

| Door | Reached by | Who gets it | Can write |
|------|-----------|-------------|-----------|
| `:8080` → nginx `:80` | `ssh -L 8080:localhost:8080` **over the tailnet** | whoever holds the server's SSH key **and a node you approved** | yes, admin panel included |
| `:8081` | the Cloudflare tunnel, public URL | anyone with the link | no |

Everything else published by `docker-compose.yml` — Postgres 5432, the replica
5433, the backend 8000, Prometheus 9090, Grafana 3000 — binds `127.0.0.1` on the
server. Reaching any of them already requires an SSH session, which is the same
key that gets the admin door. So the honest summary is: **SSH access to the
server is total access**, and every credential below is a second lock inside a
house you have to already be inside.

Which is why, since 2026-08-14, reaching SSH at all requires being on the
tailnet — see [The tailnet](#the-tailnet) below. The key is no longer the first
thing an attacker meets; the network is.

The public door is the one exposed to the internet, and it is where the
hardening below is aimed.

## What is in place

**Writes are refused on the public listener.** `POST`/`PUT /api/admin-config` is
the only write endpoint in the API and it has no authentication of its own;
`frontend/nginx.conf` answers 403 to anything but `GET`/`HEAD` on that path on
`:8081`. This stops curl exactly as readily as it stops the panel.

**Response headers** (`frontend/security-headers.conf`) on both listeners:

- `Content-Security-Policy` with `script-src 'self'` — no third-party origin can
  supply code. `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`
  and `form-action 'self'` close the classic ways injected markup takes over a
  page. `connect-src` names the one external host the app fetches from.
- `X-Content-Type-Options: nosniff` — the API returns feed data as JSON, and a
  browser that sniffs a record containing markup as HTML would execute it in our
  origin.
- `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`,
  `Permissions-Policy` denying geolocation, camera, microphone, payment and USB.

The include is repeated inside every `location` that sets a header of its own:
nginx replaces rather than merges `add_header` between levels, so a location
with its own `Cache-Control` and no include would ship with no security headers
at all.

**Rate and connection limits on the public door.** 20 requests/second with a
burst of 60, and 30 concurrent connections, per client. Per *client* rather than
per source address is the point of the `real_ip` block: every request arrives
from cloudflared, so without it the limit would be one shared bucket and the
first busy reader would throttle everyone. `CF-Connecting-IP` is only trusted
from loopback and docker ranges, which is all that can reach a port published on
`127.0.0.1`.

**Third-party map libraries are vendored**, not fetched from unpkg at page load
— see `frontend/public/vendor/README.md`. This is what lets the CSP say
`script-src 'self'` and mean it.

**Links built from feed data go through `safeUrl`** (`frontend/src/utils/format.js`).
Escaping alone does not help against `javascript:` — it contains none of the
characters escaping touches — so the scheme is checked against an allowlist and
anything else renders as text with no anchor. Every URL the map displays comes
from a publisher we do not control.

**Containers** run with `no-new-privileges`, and the four Python services with
`cap_drop: ALL`. They bind no privileged port and change no file ownership, so
they need no Linux capability at all.

**Dependency floors.** `starlette>=0.40.0` and `h11>=0.16.0` are pinned in
`requirements.txt` for the CVEs named there, rather than left to whatever pip
resolved on the day the image was built.

## The tailnet

Before 2026-08-14 port 22 answered the entire internet, protected by key
authentication alone — `ufw` was inactive and the iptables `INPUT` policy was
`ACCEPT`. The server now sits on a Tailscale network and SSH arrives over that.

Two nodes, deliberately unequal:

| Node | Identity | Notes |
|------|----------|-------|
| `osint-server` | `tag:server` | tagged, so it is owned by the tag rather than a user and **its key never expires** — a node whose key lapses behind a firewalled port 22 is a lockout |
| `aladarisah` | the tailnet owner | joined interactively, `--shields-up` |

**The connection only ever opens from the PC toward the server.** Three
independent layers say so:

*The policy* (`ops/tailscale/policy.hujson`, applied at
<https://login.tailscale.com/admin/acls>) contains exactly one grant —
`autogroup:owner` → `tag:server` on `tcp:22` — and names `tag:server` as the
source of nothing. The filter is stateful, so replies inside a session the PC
opened flow back, while a connection the server tries to open on its own matches
no rule. What the server actually receives from the control plane is a single
inbound rule: the PC's address, this server's address, port 22, TCP.

*The client* runs with `ShieldsUp: true`, so the PC's own daemon refuses all
inbound connections whatever the policy says. This is the layer that survives a
careless edit in the admin console.

*The host firewall* accepts port 22 only on `tailscale0`, so a policy mistake
cannot re-expose it to the internet.

One honest limit: both machines still reach Tailscale's coordination servers and
exchange NAT-traversal packets with each other — `tailscale ping` between them
succeeds in both directions. That is the transport, below the filter. "The
server never initiates" is a claim about connections, which is the layer that
carries anything.

**New nodes need approval.** Device approval is on, so a new machine can
authenticate but is quarantined with access to nothing until approved by hand.
Tailnet lock — the cryptographic version, which would also defend against a
compromised Tailscale control plane — is deliberately off: the two are mutually
exclusive, and lock wants two or more signing nodes plus ten disablement secrets
that make the tailnet unrecoverable if lost. With one client device that trade
is not worth taking. Worth revisiting if a second permanent machine joins.

**If you lose the tailnet, the way back in is the Hetzner Cloud console** —
noVNC and rescue mode, out of band, independent of the network configuration.
It wants the root password, which is not the SSH key. Confirm it works *before*
anything closes port 22, not after.

Two things the firewall deliberately does not do. Docker's DNAT rules run ahead
of ufw's chains, so ufw does not govern container-published ports — moot here,
since every published port binds `127.0.0.1` already. And the Cloudflare tunnel
is an outbound connection from `cloudflared`, so `default deny incoming` never
touches it and the public map is unaffected.

### Verified 2026-08-14

Each claim above, and what was actually observed:

| Claim | Observed |
|-------|----------|
| The policy is enforcing, not just saved | the server's netmap carries exactly one inbound rule: `Srcs 100.77.142.79/32`, `Dsts 100.74.206.20/32:22`, `IPProto 6` |
| Shields-up is on | `tailscale debug prefs` → `"ShieldsUp": true`, `"RouteAll": false` |
| The server's key cannot lapse | `tailscale status --json` → `Self.KeyExpiry` absent; tags `['tag:server']` |
| The server cannot reach back | from the server, TCP 22, 445, 3389 and 5985 to the PC all blocked |
| …but the transport still works | `tailscale ping` → `pong from aladarisah via DERP(par)`, which is the expected limit of the claim |
| Public SSH is closed | from the PC over the public path, `37.27.38.223:22` unreachable; `100.74.206.20:22` reachable |
| The admin door still writes | over the forward, `GET /` 200 and `POST /api/admin-config` 400 — a bad request, not a refusal |
| The public door still refuses writes | `POST /api/admin-config` on the tunnel URL → 403, `GET /` → 200 |
| Container egress survived ufw | `ingest` logged 8305 aircraft from OpenSky after the firewall came up |

Device approval was tested the same day with a throwaway node — a second
`tailscaled` on the server itself, in userspace networking mode with its own
`--statedir` and `--socket`, so the real node's state was never touched. Joined
with an untagged, ephemeral, not-pre-approved key, measured before approval and
again after:

| | Before approval | After approval |
|---|---|---|
| `BackendState` | `NeedsMachineAuth` | `Running` |
| peers it can see | 0 | 2 |
| server's filter `Srcs` | throwaway absent | `100.65.85.114/32` present |
| TCP to `osint-server:22` | `Machine is not yet approved by tailnet admin.` | connects, exit 0 |
| TCP to the PC, 22 and 3389 | same refusal | times out — the policy grants nothing toward the PC, approved or not |

So an unapproved node is not merely blocked from connecting: it is not told the
other machines exist, and no other machine is told about it. Quarantine is in
the netmap, not in a firewall rule.

The line to read carefully is the last one. Approval is the **only** gate in
front of a new device of yours — once approved, it matches `autogroup:owner` and
receives the `tcp:22` grant automatically. That is intended, and it is why
approval matters: it is what stands between a compromised account session and an
SSH-capable node.

The firewall was enabled behind a five-minute `ufw --force disable` watchdog,
cancelled once a *new* SSH session — not the established one — was confirmed to
come through. Worth repeating that trick on any future rule change: an
established session survives a bad rule and tells you nothing.

## Rotating the credentials

Three passwords still fall back to a built-in default when the variable is unset:
`POSTGRES_PASSWORD` (`osint`), `REPLICATION_PASSWORD` (`replicator`) and
`GRAFANA_ADMIN_PASSWORD` (`admin`).

All three at once, which is what `ops/rotate-credentials.sh` does — it generates
the values, changes them in the right order, recreates the services that hold
them, and greps the logs for authentication failures afterwards:

```bash
ssh root@osint-server.tailee11c0.ts.net 'bash /opt/osint/ops/rotate-credentials.sh'
```

The rest of this section is what that script does, for when you want to do one
of them by hand or need to understand a step that went wrong.

Generate values with something you did not choose by hand:

```bash
openssl rand -base64 24
```

### Grafana — the easy one

Grafana applies `GF_SECURITY_ADMIN_PASSWORD` on every start, so there is nothing
to change inside the container. On the server, in `/opt/osint/.env`:

```bash
GRAFANA_ADMIN_USER=admin
GRAFANA_ADMIN_PASSWORD=<the generated value>
```

Then:

```bash
docker compose up -d grafana
```

Log in at `http://localhost:3000` over the SSH tunnel with the new password. If
you had already changed it through the UI, the env value wins from now on.

### Postgres — change it in the database first

The password lives in the database, not in the compose file: `POSTGRES_PASSWORD`
only sets it when the volume is first initialised, and this volume was
initialised long ago. Changing `.env` alone would leave every service unable to
authenticate.

So, in order:

```bash
# 1. change it in the running database
docker compose exec postgres psql -U osint -d osint \
  -c "ALTER ROLE osint WITH PASSWORD '<the generated value>';"

# 2. write the same value into /opt/osint/.env
#    POSTGRES_PASSWORD=<the generated value>

# 3. recreate everything that holds a DATABASE_URL
docker compose up -d backend ingest refine cache-worker \
  postgres-exporter postgres-exporter-replica
```

Existing connections are not dropped by `ALTER ROLE`, so there is no window
where a service is running against the old password — they pick up the new one
when they reconnect, which step 3 forces.

Check afterwards that nothing is failing to authenticate:

```bash
docker compose logs --tail=40 backend ingest refine cache-worker | grep -i "password\|authentication"
```

### The replication role — same shape, plus the standby

```bash
# 1. in the primary
docker compose exec postgres psql -U osint -d osint \
  -c "ALTER ROLE replicator WITH PASSWORD '<the generated value>';"

# 2. REPLICATION_PASSWORD=<the generated value> in /opt/osint/.env

# 3. the standby authenticates with PGPASSWORD from its environment,
#    so it needs recreating rather than restarting
docker compose up -d postgres-replica
```

The standby is streaming again when this stops rising:

```bash
docker compose exec postgres psql -U osint -d osint \
  -c "SELECT client_addr, state, sent_lsn, replay_lsn FROM pg_stat_replication;"
```

An empty result means it has not reconnected — check
`docker compose logs --tail=40 postgres-replica` for an authentication failure
before assuming it is still seeding.

### Making them required

Once all three are set in `.env`, the defaults in `docker-compose.yml` can be
turned into hard requirements so the stack refuses to start rather than silently
falling back:

```yaml
POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}
```

Worth doing, and worth doing when you are watching: an unset variable then takes
the map down instead of quietly using `osint`.

## Known residual risks

**The admin write endpoint has no authentication of its own.** nginx's method
split is the entire boundary. Anything that can reach the backend on port 8000
directly — that is, any process on the server — can write the configuration.
That is the same trust level as SSH, so the boundary is consistent; it is worth
knowing rather than fixing.

**`/api/health` is public.** It lists every source name and whether its key is
configured. Operational detail, not map data, and readable by anyone with the
link.

**Two dev-only npm advisories** remain in the vite/esbuild chain (`npm audit`
reports them; `npm audit --omit=dev` reports zero). They affect the dev server,
which binds localhost and never runs in the deployed stack. Clearing them needs
a vite 5 → 8 major upgrade, which is a build change and not a deployment one.

## Verifying a deploy

`nginx -t` runs inside the frontend image, so a config mistake shows up as a
container that will not start. Check it deliberately after any change to
`nginx.conf`, `api-proxy.conf` or `security-headers.conf`:

```bash
docker compose exec frontend nginx -t
```

And confirm the headers are actually on the public door:

```bash
curl -sI http://localhost:8081/ | grep -i "content-security-policy\|x-content-type\|referrer-policy"
```

A `curl -X POST http://localhost:8081/api/admin-config` must answer 403. If it
answers anything else, the public listener is not the one being served.
