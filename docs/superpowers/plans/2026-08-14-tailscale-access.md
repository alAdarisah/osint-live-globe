# Tailscale Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the server's SSH door onto a private Tailscale network, enforce that connections only ever open from the PC toward the server, require manual approval before any new machine joins, and close port 22 to the internet.

**Architecture:** The server joins as a tagged node (`tag:server`) so its key never expires; this PC joins under your own identity with `--shields-up`. A policy file grants exactly one thing — your identity to `tag:server` on `tcp:22` — and names the server as a source of nothing, so the packet filter drops anything it originates. `ufw` then accepts port 22 only on `tailscale0`. Services keep their `127.0.0.1` bindings and the admin panel keeps arriving over `ssh -L`; only the path underneath changes.

**Tech Stack:** Tailscale (Ubuntu 24.04 apt repo, Windows via winget), ufw, existing OpenSSH keys, Windows batch scripts.

## Global Constraints

- Server is `root@37.27.38.223`, Ubuntu 24.04.4, project at `/opt/osint`.
- Tailscale is currently installed on **neither** machine. Nothing to uninstall or migrate.
- The server has **no host firewall today**: `ufw` inactive, iptables `INPUT` policy `ACCEPT`.
- Tailnet lock stays **off** — it is mutually exclusive with device approval, and device approval is the choice.
- Tailscale SSH stays **off** (`"ssh": []`). Authentication remains the existing sshd and key.
- The Cloudflare tunnel and the public `:8081` map are **not** touched. `cloudflared` is outbound-only and needs no inbound rule.
- No change to `docker-compose.yml`. Every service keeps its loopback binding.
- Ordering is the safety mechanism: **port 22 is closed only after the tailnet path is proven working.**

## Who does what

Some steps cannot be done by an agent and are marked **[YOU]**: anything requiring a login to the Tailscale admin console or the Hetzner Cloud console, and anything that generates or enters a credential. Auth keys are secrets — paste them into the server shell yourself rather than into this conversation.

---

### Task 1: Confirm the out-of-band escape hatch

Nothing is installed and nothing is changed in this task. Its only job is to prove that a lockout is recoverable before any step makes one possible. Do not skip it.

**Files:** none.

- [ ] **Step 1 [YOU]: Open the Hetzner Cloud console**

Log in at <https://console.hetzner.cloud/>, select the server, and open the **Console** tab (the noVNC window).

- [ ] **Step 2 [YOU]: Log in through it**

Type the root password at the VNC login prompt. If you do not have the root password, set one now while normal SSH still works:

```bash
ssh root@37.27.38.223 "passwd"
```

Expected: a root shell inside the browser console. This path does not depend on the network configuration, so it survives every step that follows.

- [ ] **Step 3: Record that it worked**

No command. If the console did not give you a shell, **stop here** — Task 7 is unsafe without it.

---

### Task 2: Write the policy file into the repository

The admin console is the authority, but the reviewable copy lives in git. This task produces that copy so later tasks paste from a file rather than from memory.

**Files:**
- Create: `ops/tailscale/policy.hujson`

**Interfaces:**
- Produces: the exact policy text pasted into the admin console in Task 5.

- [ ] **Step 1: Create the file**

```hujson
// Tailscale access policy for the OSINT stack.
//
// The authority is the admin console at
// https://login.tailscale.com/admin/acls -- this file is the reviewable
// copy of what is pasted there, and the record of why it says this.
//
// The whole point is in what is ABSENT: no grant names tag:server as a
// source. The packet filter is stateful, so replies inside a session the
// PC opened flow back, while a connection the server tries to open on its
// own matches no rule and is dropped.
{
  // tag:server is owned by the tailnet owner, so a tagged auth key can be
  // minted for the Hetzner box. A tagged node is owned by the tag rather
  // than a user, which means its key never expires -- and a node whose key
  // lapses while port 22 is firewalled is a lockout.
  "tagOwners": {
    "tag:server": ["autogroup:owner"],
  },

  "grants": [
    // The only permitted flow on the entire tailnet.
    //
    // src is autogroup:owner, not autogroup:member: a device approved later
    // under some other identity inherits nothing from this rule.
    //
    // ip is tcp:22 alone. Every service binds 127.0.0.1 on the server, so
    // the admin panel, Grafana and Prometheus keep arriving through
    // `ssh -L` -- that forward simply rides the tailnet now. Nothing else
    // needs to cross.
    {
      "src": ["autogroup:owner"],
      "dst": ["tag:server"],
      "ip":  ["tcp:22"],
    },
  ],

  // Tailscale SSH off. Authentication stays with the existing sshd and the
  // existing key; the tailnet's job is confined to being the network path.
  "ssh": [],
}
```

- [ ] **Step 2: Commit**

```bash
git add ops/tailscale/policy.hujson
git commit -m "Write down the one flow the tailnet is allowed to carry"
```

---

### Task 3: Join the server to the tailnet

**Files:** none in the repo — this task changes the server.

**Interfaces:**
- Produces: the server's tailnet IP and MagicDNS name, used by Tasks 4, 6, 7 and 8.

- [ ] **Step 1 [YOU]: Create the tailnet and mint a tagged auth key**

Sign in at <https://login.tailscale.com/>. Then, at <https://login.tailscale.com/admin/settings/keys>, **Generate auth key** with:

- **Reusable:** off
- **Ephemeral:** off
- **Pre-approved:** on — otherwise the server lands in the approval queue you are about to enable, and Task 5 quarantines it
- **Tags:** `tag:server`

If `tag:server` is not offered, the tag does not exist yet: paste `ops/tailscale/policy.hujson` into <https://login.tailscale.com/admin/acls> first (that is Task 5, Step 1 — doing it early is fine), then come back.

Copy the key. It starts `tskey-auth-`. Keep it out of this conversation.

- [ ] **Step 2: Install Tailscale from the official apt repository**

Run on the server. These two URLs were verified to return HTTP 200:

```bash
ssh root@37.27.38.223 "curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg -o /usr/share/keyrings/tailscale-archive-keyring.gpg && curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.tailscale-keyring.list -o /etc/apt/sources.list.d/tailscale.list && apt-get update -qq && apt-get install -y tailscale"
```

Expected: `tailscale` and `tailscaled` install, and the unit starts.

- [ ] **Step 3: Verify the daemon is running**

```bash
ssh root@37.27.38.223 "systemctl is-active tailscaled && tailscale version"
```

Expected: `active`, then a version at or above `1.46.1`.

- [ ] **Step 4 [YOU]: Join, with the auth key**

Open your own SSH session so the key is not typed into an agent transcript:

```bash
ssh root@37.27.38.223
```

Then, inside that session, substituting the key from Step 1:

```bash
tailscale up --auth-key=tskey-auth-XXXX --hostname=osint-server --accept-routes=false --advertise-routes= --advertise-exit-node=false
```

Expected: the command returns silently. `--accept-routes=false` keeps the server from picking up routes any future node advertises; the two `--advertise-*` flags state explicitly that it offers none.

- [ ] **Step 5: Read back the node's identity**

```bash
ssh root@37.27.38.223 "tailscale status --self --peers=false; tailscale ip -4"
```

Expected: one line showing `osint-server` tagged `tag:server`, and a `100.x.y.z` address. **Write that address down** — later tasks need it.

- [ ] **Step 6 [YOU]: Disable key expiry on this node**

At <https://login.tailscale.com/admin/machines>, open `osint-server` → the `...` menu → **Disable key expiry**.

This is not cosmetic. A tagged node's key does not expire by default, but confirm the machine list says **Expiry disabled** rather than a date. A server whose key lapses after Task 7 is a server you reach only through the Hetzner console.

---

### Task 4: Join this PC

**Files:** none in the repo.

**Interfaces:**
- Consumes: the tailnet from Task 3.
- Produces: the PC's tailnet IP, used by Task 6 to prove the reverse direction is dead.

- [ ] **Step 1: Install Tailscale**

```powershell
winget install --id Tailscale.Tailscale --accept-package-agreements --accept-source-agreements
```

Expected: install succeeds and a Tailscale tray icon appears.

- [ ] **Step 2 [YOU]: Log in**

Open the tray icon → **Log in**, and complete the browser sign-in as the same account that owns the tailnet. Do not use an auth key here; this node should carry your user identity, which is what `autogroup:owner` in the policy matches.

- [ ] **Step 3: Turn on shields-up**

```powershell
& "$env:ProgramFiles\Tailscale\tailscale.exe" up --shields-up --accept-routes=false
```

Expected: returns silently. This makes the PC's own daemon refuse all inbound connections regardless of what the policy file says — the layer that survives a careless console edit later.

- [ ] **Step 4: Verify both nodes see each other**

```powershell
& "$env:ProgramFiles\Tailscale\tailscale.exe" status
```

Expected: two lines, `osint-server` and this PC. Note the PC's `100.x.y.z` address.

---

### Task 5: Apply the policy and require approval for new nodes

**Files:**
- Reference: `ops/tailscale/policy.hujson` (created in Task 2)

- [ ] **Step 1 [YOU]: Paste the policy file**

Open <https://login.tailscale.com/admin/acls>, select the whole editor contents, replace with the contents of `ops/tailscale/policy.hujson`, and **Save**.

The default policy you are replacing is allow-all between every node. If the editor refuses to save, it will name the line — the usual cause is a stray trailing character, since HuJSON tolerates trailing commas and comments but not much else.

- [ ] **Step 2: Confirm the PC can still reach the server**

```powershell
ssh root@<server-tailnet-ip>
```

Expected: a root shell. If this fails immediately after saving the policy, the grant is wrong — fix it before continuing, because Task 7 depends on this path.

- [ ] **Step 3 [YOU]: Enable device approval**

At <https://login.tailscale.com/admin/settings/device-management>, turn on **Device approval**.

Existing nodes stay approved. From now on a new machine can authenticate but is quarantined with access to nothing until you approve it by hand.

- [ ] **Step 4 [YOU]: Confirm tailnet lock is off**

At <https://login.tailscale.com/admin/settings/tailnet-lock>, confirm it reads **Disabled**. The two features are mutually exclusive, and lock is deliberately not the choice here — it wants two or more signing nodes, and this tailnet has one client.

---

### Task 6: Prove the direction is one-way

This is the task that verifies the actual requirement, and it is the one easiest to skip. Run it before the firewall step, so a failure here is diagnosed while public SSH still works.

**Files:** none.

- [ ] **Step 1: Confirm the forward direction carries the admin panel**

```powershell
ssh -L 8090:localhost:8080 root@<server-tailnet-ip>
```

Leave it open and load <http://localhost:8090> in a browser.
Expected: the map with Admin Mode present. Port 8090 rather than 8080 matches what `Open Map - Admin.bat` already uses, so this does not collide with the legacy local stack.

- [ ] **Step 2: Confirm the reverse direction is dead**

On the server, substituting the PC's tailnet address:

```bash
ssh root@<server-tailnet-ip> "nc -vz -w 5 <pc-tailnet-ip> 22; nc -vz -w 5 <pc-tailnet-ip> 3389; nc -vz -w 5 <pc-tailnet-ip> 445"
```

Expected: all three time out or are refused. **A success on any of them means the policy did not take** — check that no grant in the console names `tag:server` as a source, and that Task 4 Step 3 actually applied.

If `nc` is missing: `ssh root@37.27.38.223 "apt-get install -y netcat-openbsd"`.

- [ ] **Step 3: Confirm a new node is quarantined**

Install Tailscale on a phone or any spare machine and log in with the same account. At <https://login.tailscale.com/admin/machines> it appears marked **Needs approval**, and it can reach nothing.

Then remove it from the machine list — it was a test, and this tailnet is meant to have two nodes.

---

### Task 7: Close port 22 to the internet

**This is the step that can lock you out.** With one client device, restricting port 22 to the tailnet means a dead or reinstalled PC leaves no SSH path in. Task 1 exists so that the Hetzner Cloud console is the answer to that. Do not run this task if Task 1 did not give you a shell.

Run every command in this task **through the tailnet address**, not `37.27.38.223`. The last command drops the public session mid-flight.

**Files:** none in the repo.

- [ ] **Step 1: Open a tailnet session and stay in it**

```powershell
ssh root@<server-tailnet-ip>
```

Every remaining step in this task is typed into this session.

- [ ] **Step 2: Set the rules without activating them**

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow in on tailscale0 to any port 22 proto tcp
ufw allow in 41641/udp
```

`41641/udp` is Tailscale's direct-connection port. Without it the nodes still connect, but relayed through a DERP server instead of directly; with a public IP on this box there is no reason to accept the relay.

Note what is deliberately absent: no global `ufw allow 22`. That single line would undo the entire task.

- [ ] **Step 3: Read the rules back before arming them**

```bash
ufw show added
```

Expected: exactly the four rules above. If a global port 22 allow appears, delete it now: `ufw delete allow 22`.

- [ ] **Step 4: Enable**

```bash
ufw --force enable
```

`--force` is required because plain `ufw enable` prompts "command may disrupt existing ssh connections, proceed?" and a non-interactive shell has no way to answer.

Expected: `Firewall is active and enabled on system startup`, and **your tailnet session stays alive**. If it drops, the tailscale0 rule is wrong — recover through the Hetzner console and run `ufw disable`.

- [ ] **Step 5: Confirm the containers still reach out**

```bash
cd /opt/osint && docker compose logs --tail=20 ingest
```

Expected: fresh fetches, not connection errors. `ufw` sets a `FORWARD` drop policy and Docker's egress is worth confirming rather than assuming.

Note for the record: Docker's DNAT rules run ahead of ufw's chains, so `ufw` does not govern container-published ports at all. Here that is moot — every published port already binds `127.0.0.1`, which no external packet reaches.

---

### Task 8: Point the batch scripts at the tailnet and correct the docs

Six batch files hardcode `root@37.27.38.223`. After Task 7 every one of them is broken. This task was not in the spec; it is the part of the spec's consequences that lands in this repository.

**Files:**
- Modify: `Deploy Code to Server.bat:22`
- Modify: `Download Backups.bat:21`
- Modify: `Open Map - Admin.bat:23`
- Modify: `Open Map - Public View.bat:21`
- Modify: `Show Public Link.bat:18,21`
- Modify: `Watch the Stack - This PC.bat:9`
- Modify: `README.md:1201`
- Modify: `docs/security.md` — the door table near line 10, and the rotation command at line 86
- Modify: `ops/rotate-credentials.sh:6`

- [ ] **Step 1: Read the server's MagicDNS name**

```powershell
& "$env:ProgramFiles\Tailscale\tailscale.exe" status --json | ConvertFrom-Json | ForEach-Object { $_.Peer.PSObject.Properties.Value.DNSName }
```

Expected: something like `osint-server.tailXXXX.ts.net.`. Use the name without the trailing dot. Use this rather than the raw `100.x.y.z` — MagicDNS survives a node re-registering with a different address.

- [ ] **Step 2: Replace the address in every `set SERVER=` line**

In `Deploy Code to Server.bat`, `Download Backups.bat`, `Open Map - Admin.bat`, `Open Map - Public View.bat` and `Show Public Link.bat`, change:

```bat
set SERVER=root@37.27.38.223
```

to:

```bat
REM The tailnet name, not the public address: port 22 is firewalled to the
REM tailscale0 interface, so this only resolves and only connects while
REM Tailscale is up on this PC. See docs/superpowers/specs/2026-08-14-tailscale-access-design.md
set SERVER=root@osint-server.tailXXXX.ts.net
```

- [ ] **Step 3: Fix the comment lines that quote an ssh command**

`Show Public Link.bat:18` and `Watch the Stack - This PC.bat:9` name the old address inside REM comments. Replace `root@37.27.38.223` with the tailnet name in both, so nobody copies a command that cannot connect.

- [ ] **Step 4: Fix the same address in the docs and the rotation script**

`README.md:1201`, `docs/security.md:86` and `ops/rotate-credentials.sh:6` each carry `ssh root@37.27.38.223 'bash /opt/osint/ops/rotate-credentials.sh'`. Replace the host in all three.

- [ ] **Step 5: Correct the door table in `docs/security.md`**

The table near line 10 says the admin door is reached by `ssh -L 8080:localhost:8080` and describes a two-door model. Rewrite that row and add a short section describing the third door: SSH now arrives over the tailnet, port 22 is dropped from the internet, one policy grant carries `tcp:22` from your identity to `tag:server` and nothing carries anything back, new nodes need manual approval, and the recovery path is the Hetzner console. Point at `ops/tailscale/policy.hujson` for the policy itself.

Also amend the sentence "SSH access to the server is total access" — still true, and now qualified by the fact that reaching SSH at all requires a node you approved.

- [ ] **Step 6: Verify a script actually works end to end**

```powershell
& ".\Show Public Link.bat"
```

Expected: it prints the current Cloudflare link. That proves the tailnet name resolves, SSH connects over it, and the public tunnel is unaffected.

- [ ] **Step 7: Commit**

```bash
git add "Deploy Code to Server.bat" "Download Backups.bat" "Open Map - Admin.bat" "Open Map - Public View.bat" "Show Public Link.bat" "Watch the Stack - This PC.bat" README.md docs/security.md ops/rotate-credentials.sh
git commit -m "Send every script through the tailnet, since the public door is shut"
```

---

### Task 9: Verify from outside

**Files:** none.

- [ ] **Step 1: Confirm port 22 is gone from the internet**

From a network that is not on the tailnet — a phone on cellular with Tailscale off is the easiest:

```bash
nc -vz -w 5 37.27.38.223 22
```

Expected: timeout. A refusal or a banner means the firewall did not take.

- [ ] **Step 2: Confirm the public map is unharmed**

Run `Show Public Link.bat`, open the link on that same off-tailnet device.
Expected: the map loads and renders. The Cloudflare tunnel is outbound, so `default deny incoming` never touched it.

- [ ] **Step 3: Confirm the write refusal still holds**

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://<public-link>/api/admin-config
```

Expected: `403`. Nothing in this work should have changed it, which is exactly why it is worth confirming.

- [ ] **Step 4: Record the outcome**

Append a short "verified on 2026-08-14" note to the Tailscale section of `docs/security.md` listing what was checked, then commit.

```bash
git add docs/security.md
git commit -m "Record what was actually checked after the door moved"
```
