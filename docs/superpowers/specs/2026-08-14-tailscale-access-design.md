# Tailscale access — design

Put the server's SSH door behind a private network, make the connection
one-directional by policy rather than by convention, and require an explicit
approval before any new machine can join.

## Where things stand

Tailscale is installed nowhere. Not on this PC, not on `37.27.38.223` —
`tailscaled` reports `inactive` and there is no binary. There is no tailnet
configuration in this repository. So this is a first installation, not a repair.

The server runs Ubuntu 24.04.4 with **no host firewall**: `ufw` is inactive and
the iptables `INPUT` policy is `ACCEPT`, carrying only Docker's own chains. Port
22 is currently reachable from the entire internet, protected by key
authentication alone. That is the fact this design is aimed at.

Everything else about the access model stays as `docs/security.md` describes it:
Docker publishes each service on `127.0.0.1`, the public map is served through an
outbound Cloudflare tunnel, and the admin panel arrives over an SSH port-forward.

## The shape of the change

A third door, and one door bricked up:

| Door | Before | After |
|------|--------|-------|
| `:8081`, Cloudflare tunnel | public, read-only | unchanged |
| `:8080` admin, via `ssh -L` | SSH over the public internet | SSH over the tailnet |
| port 22 from the internet | open | dropped |

The tailnet carries SSH and nothing else. The services keep their loopback
bindings, and the admin panel keeps arriving through
`ssh -L 8080:localhost:8080` — that forward simply rides the tailnet now. No
change to `docker-compose.yml`, no service rebound, no new listener.

## Nodes

Two, with deliberately asymmetric roles.

**The server** joins as a tagged node, `tag:server`, using a pre-authorized
tagged auth key generated in the admin console. Tagging matters for two reasons.
A tagged node is owned by the tag rather than by a user, so its key never
expires — and a node whose key lapses while port 22 is firewalled is a lockout.
It also gives the policy file a stable name to write rules against, one that
survives reinstalling the machine.

The server advertises no routes and no exit node, and does not accept routes.

**This Windows PC** joins interactively under your own identity, with
`--shields-up`.

## Enforcing the direction

Three layers, each sufficient on its own, which is the point of having three.

**The policy file.** Tailscale's default policy is allow-all between every node;
it gets replaced with:

```json
{
  "tagOwners": {
    "tag:server": ["autogroup:owner"]
  },

  "grants": [
    {
      "src": ["autogroup:owner"],
      "dst": ["tag:server"],
      "ip":  ["tcp:22"]
    }
  ],

  "ssh": []
}
```

No grant names `tag:server` as a source, so the packet filter drops anything the
server originates toward the PC. The filter is stateful: replies inside an SSH
session you opened flow back normally, while a connection the server tries to
open on its own has no rule permitting it.

`src` is `autogroup:owner` rather than `autogroup:member`, so a node later
approved under a different identity inherits nothing.

`"ssh": []` leaves Tailscale SSH off. Authentication stays with the existing
sshd and your existing key, and the tailnet's job is confined to being the
network path.

**The client.** `--shields-up` makes the PC's own daemon refuse all inbound
connections regardless of what the policy file says. It is the layer that
survives a future careless edit in the admin console.

**The host firewall.** Port 22 accepted only on the `tailscale0` interface, so
even a policy mistake cannot expose it to the internet.

One honest caveat: both machines still reach Tailscale's coordination servers
and exchange NAT-traversal packets with each other. That is the transport, below
the filter. "The server never initiates" is a statement about connections, which
is the layer that carries anything.

## Requiring approval for new nodes

Device approval, enabled in the admin console under Device management. A new
machine can authenticate but is quarantined with no access to anything until
approved by hand. It is a toggle, reversible, with nothing to lose by turning it
on.

This rules out tailnet lock — Tailscale treats the two as mutually exclusive.
Lock is the stronger control, cryptographic rather than administrative, and
would protect even against a compromised Tailscale control plane. It also wants
two or more signing nodes and hands you ten disablement secrets that make the
tailnet unrecoverable if lost. With a single client device, that trade is not
worth taking. If a second permanent machine joins later, lock becomes worth
revisiting.

## The firewall step

**This is the step that can lock you out.** With one client device, restricting
port 22 to the tailnet means a dead or reinstalled PC leaves no SSH path to the
server. The fallback is the Hetzner Cloud console — VNC and rescue mode, out of
band, independent of the network configuration entirely. Confirm you can open it
and log in *before* running this step, not after.

Rules, on the server:

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow in on tailscale0 to any port 22 proto tcp
ufw allow in 41641/udp
ufw --force enable
```

Run these from the tailnet SSH session, not the public one — the last line drops
the public session mid-command. `--force` is needed because `ufw enable` asks
"command may disrupt existing ssh connections, proceed?" and there is no terminal
to answer it.

`41641/udp` is Tailscale's direct-connection port. Without it the two nodes still
connect, but relayed through a DERP server rather than directly; with a public IP
on the server there is no reason to accept the relay.

Two things this does not do, both worth knowing rather than fixing:

Docker's DNAT rules run ahead of ufw's chains, so `ufw` does not govern
container-published ports. Here that is moot — every published port binds
`127.0.0.1` already, which no external packet can reach.

The Cloudflare tunnel is an outbound connection from `cloudflared`, so it needs
no inbound rule and is unaffected by `default deny incoming`. The public map link
keeps working.

## Order of operations

The sequence is the safety mechanism; each step is verified before the next one
removes a fallback.

1. Confirm the Hetzner Cloud console opens and accepts a login.
2. Install Tailscale on the server from the official apt repository, join with
   the tagged auth key, and disable key expiry for that node in the console.
3. Install on the PC, join with `--shields-up`.
4. Apply the policy file in the admin console.
5. Enable device approval.
6. Verify SSH over the tailnet address works, and that the admin panel loads
   through the forward.
7. Only now, apply the ufw rules.
8. Verify from an outside network that port 22 is gone and the map still loads.

## Verification

Each claim this design makes, and the command that proves it:

| Claim | Check |
|-------|-------|
| The tailnet path works | `ssh root@<server-tailnet-ip>` from the PC |
| The admin door still opens | `ssh -L 8080:localhost:8080 root@<server-tailnet-ip>`, then `http://localhost:8080` |
| The server cannot reach back | on the server, `nc -vz <pc-tailnet-ip> 3389` and `nc -vz <pc-tailnet-ip> 22` both fail |
| Public SSH is closed | from an unrelated network, `nc -vz 37.27.38.223 22` fails |
| The public map is unharmed | the Cloudflare link loads and renders |
| Containers still reach out | `docker compose logs --tail=20 ingest` shows fresh fetches, not connection errors — ufw sets a `FORWARD` drop policy and Docker's egress is worth confirming rather than assuming |
| New nodes need approval | join a throwaway node; it appears unapproved and reaches nothing |

The third row is the one that answers the actual requirement, and it is the one
easiest to forget to run.

## What lands in the repository

`ops/tailscale/policy.hujson` — the policy file, commented, kept in version
control as the reviewable copy of what is pasted into the admin console. The
console remains the authority; this is the record of intent and the thing a diff
can be read against.

A Tailscale section appended to `docs/security.md`, describing the third door and
correcting the table there, which currently says SSH arrives over the public
internet.
