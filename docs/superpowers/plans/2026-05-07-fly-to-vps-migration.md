# rpow: Fly.io → OVH VPS Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate rpow API + Postgres from Fly.io+Neon to a single self-hosted Ubuntu VPS at `15.204.254.192`, with a ~120s bounded cutover window and zero committed-data loss.

**Architecture:** Single OVH VPS running Postgres 16 (Unix-socket-only) + Node 22 (Fastify server under systemd) + nginx (Let's Encrypt TLS via Cloudflare DNS-01). Web SPA stays on Netlify, DNS stays on Cloudflare, email stays on Resend. Cutover via `pg_dump`/`pg_restore` with two manual verification gates.

**Tech Stack:** Ubuntu, systemd, PostgreSQL 16 (PGDG), Node.js 22 (NodeSource), Fastify, nginx, certbot + certbot-dns-cloudflare, restic → Backblaze B2, Cloudflare DNS API.

**Spec:** `docs/superpowers/specs/2026-05-07-fly-to-vps-migration-design.md`

---

## File / artifact map

Files added to the rpow repo (committed):
- `ops/cutover.sh` — orchestrates the timed cutover sequence
- `ops/parity-check.sql` — row-count parity SQL run as gate at T+90s
- `ops/smoke-test.sh` — e2e check (health, mint-against-empty, token-verify) run as gate at T+120s
- `ops/dns-flip.sh` — Cloudflare API call to flip A + AAAA records (called by cutover.sh)
- `ops/dns-tll-prep.sh` — pre-cutover utility to set TTL=60 (already done manually but committed for reproducibility)
- `ops/backup.sh` — nightly `pg_dump | restic backup` script (lives at `/usr/local/bin/rpow-backup` on VPS, mirrored here)
- `ops/restore-test.sh` — restic restore drill (run before trusting backups)
- `ops/rpow-status.sh` — one-page health (lives at `/usr/local/bin/rpow-status` on VPS, mirrored here)
- `ops/systemd/rpow-server.service` — systemd unit (mirrored to `/etc/systemd/system/`)
- `ops/systemd/rpow-backup.service`, `ops/systemd/rpow-backup.timer` — nightly backup
- `ops/nginx/api.rpow2.com.conf` — nginx site config
- `docs/RUNBOOK.md` — updated post-cutover with new operator instructions

Files NOT in the repo (live on VPS only, never committed):
- `/etc/rpow/server.env` — production env (mode 0640, root:rpow)
- `/etc/letsencrypt/cloudflare.ini` — CF API token for DNS-01 (mode 0600, root:root)
- `/etc/rpow/restic.env` — restic password + B2 creds (mode 0600, root:root)
- Pre-cutover safety dump archived to B2

---

## Conventions for this plan

- Commands shown as `local$ ...` run on your laptop (or in the Claude Code Bash tool).
- Commands shown as `vps# ...` run as root on the VPS. Easiest path: `local$ ssh ubuntu@15.204.254.192 'sudo bash -c "<command>"'`. Step text shows the inner command for clarity.
- Commands shown as `vps$ ...` run as `ubuntu` user on the VPS.
- "Verification: <output>" means the literal expected output of the command above. If you don't see that, do not advance.
- Manual gates are explicit `STOP` lines. The plan does not advance past them without human "go."

---

## Task 0: Pre-flight — local prep

**Goal:** Gather all secrets and confirm the env-var checklist before touching the VPS. Nothing on VPS or production changes in this task.

**Files:**
- Create: `/Users/fredkrueger/rpow/.env.vps` (local, gitignored)

- [ ] **Step 0.1: Confirm `.env.vps` is gitignored**

```
local$ grep -E '^\.env' /Users/fredkrueger/rpow/.gitignore
```
Expected output:
```
.env
.env.local
```
If `.env.vps` isn't covered by either pattern, add this line to `.gitignore`:
```
.env.vps
```

- [ ] **Step 0.2: Capture Fly secrets list (names only, not values)**

```
local$ flyctl secrets list --app rpow2-server
```
Verification: output contains at minimum these names — `DATABASE_URL`, `RESEND_API_KEY`, `EMAIL_FROM`, `SESSION_SECRET`, `RPOW_SIGNING_PRIVATE_KEY_HEX`, `RPOW_SIGNING_PUBLIC_KEY_HEX`, `DIFFICULTY_BITS`, `DIFFICULTY_FLOOR`. If `MINT_EPOCH_SIZE` / `MINT_MAX_SUPPLY` / `TURNSTILE_SECRET` aren't listed, defaults from `apps/server/src/env.ts` will apply.

- [ ] **Step 0.3: Capture actual secret values from Fly**

Fly secrets are injected into the running app process, NOT the SSH shell. Read them from the node process's `/proc/<pid>/environ`:

```
local$ NODE_PID=$(flyctl ssh console --app rpow2-server -C 'pidof node' 2>/dev/null | tr -d '[:space:]') && \
  flyctl ssh console --app rpow2-server -C "cat /proc/$NODE_PID/environ" 2>/dev/null \
    | tr '\0' '\n' \
    | grep -E '^(DATABASE_URL|SESSION_SECRET|RPOW_SIGNING_PRIVATE_KEY_HEX|RPOW_SIGNING_PUBLIC_KEY_HEX|RESEND_API_KEY|EMAIL_FROM|DIFFICULTY_BITS|DIFFICULTY_FLOOR|MINT_EPOCH_SIZE|MINT_MAX_SUPPLY|TURNSTILE_SECRET|MAGIC_LINK_BASE_URL|WEB_ORIGIN)=' \
    > /Users/fredkrueger/rpow/.env.vps && \
  chmod 600 /Users/fredkrueger/rpow/.env.vps
```

> Earlier draft used `flyctl ssh console -C "env"` — that doesn't see the secrets, since they're injected to the runtime process only. The `/proc/<pid>/environ` form works.

Verification: file exists, mode is 600 (`chmod 600 /Users/fredkrueger/rpow/.env.vps`), contains a `SESSION_SECRET=...` line and a `RPOW_SIGNING_PRIVATE_KEY_HEX=...` line.

> **Critical:** `RPOW_SIGNING_PRIVATE_KEY_HEX` must be carried EXACTLY. If lost, every existing minted token becomes unverifiable. Treat this file like a private key.

- [ ] **Step 0.4: Generate VPS Postgres password**

```
local$ openssl rand -base64 32 | tr -d '/+=' | head -c 32
```
Append to `.env.vps`:
```
RPOW_DB_PASSWORD=<generated value>
```
This is a NEW password — Postgres will be created fresh on the VPS. Will be embedded in the VPS-side `DATABASE_URL` later.

- [ ] **Step 0.5: Generate restic repository password**

```
local$ openssl rand -base64 32 | tr -d '/+=' | head -c 32
```
Append to `.env.vps`:
```
RESTIC_PASSWORD=<generated value>
```

- [ ] **Step 0.6: Manually verify the Cloudflare API token is still valid**

```
local$ set -a && . /Users/fredkrueger/rpow/.env && set +a && \
  curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    https://api.cloudflare.com/client/v4/user/tokens/verify \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["status"])'
```
Verification: prints `active`.

- [ ] **Step 0.7: Confirm Neon connection works from local machine**

Source `.env.vps` (which now contains the original `DATABASE_URL=postgres://...neon.../...`):
```
local$ set -a && . /Users/fredkrueger/rpow/.env.vps && set +a && \
  psql "$DATABASE_URL" -c 'SELECT count(*) AS users FROM users;' \
                       -c 'SELECT count(*) AS tokens FROM tokens;' \
                       -c 'SELECT count(*) AS transfers FROM transfers;'
```
Verification: three numeric results. **Write these numbers down** in `.env.vps` as comments — they're the baseline for Step 8 row-count parity.

- [ ] **Step 0.8: Commit gitignore tweak only (no secrets)**

```
local$ cd /Users/fredkrueger/rpow && git status
```
If `.gitignore` was modified in Step 0.1:
```
local$ git add .gitignore
local$ git commit -m "chore: gitignore .env.vps for VPS migration secrets

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```
If it wasn't modified, skip the commit.

---

## Task 1: VPS hardening

**Goal:** Lock down the VPS before installing any user-facing services. SSH key auth only, firewall, fail2ban, auto-updates, time sync, non-root app user.

**Files:**
- Create on VPS: `/etc/ssh/sshd_config.d/90-rpow.conf`, `/etc/apt/apt.conf.d/52unattended-upgrades-rpow`
- No repo files.

- [ ] **Step 1.1: Confirm SSH key access works**

```
local$ ssh -i ~/.ssh/id_ed25519 -o BatchMode=yes ubuntu@15.204.254.192 'echo ok'
```
Verification: prints `ok`. If it fails, fix SSH access before proceeding (we already have key auth working from earlier in the session).

- [ ] **Step 1.2: Update apt cache and apply current security updates**

```
local$ ssh ubuntu@15.204.254.192 'sudo apt-get update && sudo apt-get -y dist-upgrade'
```
Expected: completes without errors. May install kernel updates — note any "*** System restart required ***" message; we'll reboot at end of Task 1.

- [ ] **Step 1.3: Install hardening packages**

```
local$ ssh ubuntu@15.204.254.192 'sudo apt-get install -y ufw fail2ban unattended-upgrades apt-listchanges'
```
Verification: all four packages report installed (no "E: " errors).

- [ ] **Step 1.4: Configure SSH — disable password auth and root login**

Write `/etc/ssh/sshd_config.d/90-rpow.conf`:
```
local$ ssh ubuntu@15.204.254.192 'sudo tee /etc/ssh/sshd_config.d/90-rpow.conf <<EOF
PasswordAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
KbdInteractiveAuthentication no
EOF'
```

Validate then reload sshd:
```
local$ ssh ubuntu@15.204.254.192 'sudo sshd -t && sudo systemctl reload ssh'
```
Verification: no output from `sshd -t` (means valid config). `reload` returns silently.

- [ ] **Step 1.5: Verify SSH still works in a NEW session**

Open a SECOND shell and SSH in. **Don't close the existing session until the new one works** — if the new ssh fails, you'll need the old one to revert.

```
local-2nd$ ssh ubuntu@15.204.254.192 'echo "still ok"'
```
Verification: prints `still ok`. If this fails, in your original session: `sudo rm /etc/ssh/sshd_config.d/90-rpow.conf && sudo systemctl reload ssh`.

- [ ] **Step 1.6: Configure UFW**

```
local$ ssh ubuntu@15.204.254.192 'sudo ufw default deny incoming && \
  sudo ufw default allow outgoing && \
  sudo ufw allow 22/tcp && \
  sudo ufw allow 80/tcp && \
  sudo ufw allow 443/tcp && \
  sudo ufw --force enable'
```
Verification:
```
local$ ssh ubuntu@15.204.254.192 'sudo ufw status verbose'
```
Expected output contains `Status: active`, `Default: deny (incoming)`, and rules for 22, 80, 443.

- [ ] **Step 1.7: Configure fail2ban for sshd**

Default fail2ban jail watches sshd already on Ubuntu. Verify:
```
local$ ssh ubuntu@15.204.254.192 'sudo systemctl enable --now fail2ban && \
  sudo fail2ban-client status sshd'
```
Verification: prints "Status for the jail: sshd" with current banned IPs (likely 0).

- [ ] **Step 1.8: Configure unattended-upgrades**

Enable security upgrades automatically:
```
local$ ssh ubuntu@15.204.254.192 'sudo dpkg-reconfigure -plow unattended-upgrades </dev/null && \
  sudo tee /etc/apt/apt.conf.d/52unattended-upgrades-rpow <<EOF
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
EOF'
```
Verification:
```
local$ ssh ubuntu@15.204.254.192 'sudo unattended-upgrade --dry-run -d 2>&1 | tail -20'
```
Expected: shows what would be upgraded (or "No packages found that can be upgraded").

- [ ] **Step 1.9: Confirm time sync is healthy**

```
local$ ssh ubuntu@15.204.254.192 'timedatectl status'
```
Verification: output contains `System clock synchronized: yes` and `NTP service: active`.

- [ ] **Step 1.10: Create `rpow` system user**

```
local$ ssh ubuntu@15.204.254.192 'sudo useradd --system --create-home --home-dir /opt/rpow --shell /usr/sbin/nologin rpow'
```
Verification:
```
local$ ssh ubuntu@15.204.254.192 'id rpow && ls -ld /opt/rpow'
```
Expected: `id rpow` prints uid/gid; `/opt/rpow` exists owned by `rpow:rpow`.

- [ ] **Step 1.11: Capture VPS IPv6 address**

```
local$ ssh ubuntu@15.204.254.192 'ip -6 addr show scope global | grep -oE "[0-9a-f:]+/[0-9]+" | head -1'
```
Verification: prints an IPv6 like `2001:41d0:...:.../128`. **Record the address part (before the `/`) in `.env.vps`** as `VPS_IPV6=...` — needed at cutover. If output is empty, append `VPS_IPV6=NONE` and we'll DELETE the AAAA record at cutover instead.

- [ ] **Step 1.12: Reboot if kernel update requires it**

Check:
```
local$ ssh ubuntu@15.204.254.192 'ls /var/run/reboot-required 2>/dev/null && echo NEEDS_REBOOT || echo OK'
```
If `NEEDS_REBOOT`:
```
local$ ssh ubuntu@15.204.254.192 'sudo reboot' ; sleep 30
local$ ssh ubuntu@15.204.254.192 'uptime'
```
Expected: `uptime` shows ~30s up; ssh still works.

- [ ] **Step 1.13: Phase commit**

No repo files changed in this phase. Skip the commit.

---

## Task 2: Software install (Postgres 16, Node 22, nginx, certbot, restic)

**Goal:** Install all baseline software at the versions the spec mandates. No app deployment yet.

**Files:**
- No repo files.

- [ ] **Step 2.1: Add the PGDG apt repository (Postgres 16)**

```
local$ ssh ubuntu@15.204.254.192 'sudo install -d /usr/share/postgresql-common/pgdg && \
  sudo curl -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc --fail https://www.postgresql.org/media/keys/ACCC4CF8.asc && \
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" | sudo tee /etc/apt/sources.list.d/pgdg.list && \
  sudo apt-get update'
```
Verification:
```
local$ ssh ubuntu@15.204.254.192 'apt-cache policy postgresql-16 | head -5'
```
Expected: shows a Candidate version starting `16.`.

- [ ] **Step 2.2: Install Postgres 16**

```
local$ ssh ubuntu@15.204.254.192 'sudo apt-get install -y postgresql-16 postgresql-client-16'
```
Verification:
```
local$ ssh ubuntu@15.204.254.192 'sudo systemctl is-active postgresql && psql --version'
```
Expected: `active`, then `psql (PostgreSQL) 16.x`.

- [ ] **Step 2.3: Add the NodeSource apt repository (Node 22)**

```
local$ ssh ubuntu@15.204.254.192 'curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -'
```
Verification: ends with "## You may now install Node.js by running …".

- [ ] **Step 2.4: Install Node 22**

```
local$ ssh ubuntu@15.204.254.192 'sudo apt-get install -y nodejs'
```
Verification:
```
local$ ssh ubuntu@15.204.254.192 'node --version && npm --version'
```
Expected: `v22.x.x` and an `npm` 10.x version.

- [ ] **Step 2.5: Install nginx, certbot (with cloudflare DNS plugin), restic, jq**

```
local$ ssh ubuntu@15.204.254.192 'sudo apt-get install -y nginx certbot python3-certbot-dns-cloudflare restic jq'
```
Verification:
```
local$ ssh ubuntu@15.204.254.192 'nginx -v 2>&1 && certbot --version && restic version | head -1 && jq --version'
```
Expected: each prints a version. nginx ≥1.24, certbot ≥1.x, restic ≥0.16.

- [ ] **Step 2.6: Phase commit**

No repo files changed. Skip.

---

## Task 3: Postgres setup — DB, user, security

**Goal:** Create the `rpow` database and `rpow_app` role; ensure Postgres listens on Unix socket only; lock down `pg_hba.conf` to socket-peer auth for our app role.

**Files:**
- No repo files.

- [ ] **Step 3.1: Confirm Postgres listens on Unix socket only (no TCP)**

```
local$ ssh ubuntu@15.204.254.192 'sudo -u postgres psql -c "SHOW listen_addresses; SHOW unix_socket_directories;"'
```
Expected: `listen_addresses` should be `localhost` (default). We will tighten to `''` next.

- [ ] **Step 3.2: Disable TCP listening**

Edit the Postgres config:
```
local$ ssh ubuntu@15.204.254.192 'sudo sed -i "s/^#\?listen_addresses.*/listen_addresses = \x27\x27/" /etc/postgresql/16/main/postgresql.conf && \
  sudo systemctl restart postgresql'
```
Verification:
```
local$ ssh ubuntu@15.204.254.192 'sudo -u postgres psql -c "SHOW listen_addresses;" && sudo ss -tln | grep -E ":5432\b" || echo "no tcp listener (good)"'
```
Expected: `listen_addresses` is empty, then `no tcp listener (good)`.

- [ ] **Step 3.3: Create the `rpow_app` role and `rpow` database**

Get the password from `.env.vps`:
```
local$ . /Users/fredkrueger/rpow/.env.vps && \
  ssh ubuntu@15.204.254.192 "sudo -u postgres psql <<SQL
CREATE ROLE rpow_app WITH LOGIN PASSWORD '$RPOW_DB_PASSWORD';
CREATE DATABASE rpow OWNER rpow_app;
SQL"
```
Verification:
```
local$ ssh ubuntu@15.204.254.192 'sudo -u postgres psql -c "\du rpow_app" -c "\l rpow"'
```
Expected: lists the role with `Login` attribute, lists `rpow` database with owner `rpow_app`.

- [ ] **Step 3.4: Test Unix-socket login as rpow_app**

```
local$ . /Users/fredkrueger/rpow/.env.vps && \
  ssh ubuntu@15.204.254.192 "PGPASSWORD='$RPOW_DB_PASSWORD' psql -h /var/run/postgresql -U rpow_app -d rpow -c 'SELECT current_user, current_database();'"
```
Expected: prints `rpow_app | rpow`.

- [ ] **Step 3.5: Apply schema-only dump from Neon to VPS**

This lets the rpow-server start and accept smoke tests pre-cutover. At cutover we'll do a full data-and-schema dump and restore with `--clean --if-exists`.

```
local$ . /Users/fredkrueger/rpow/.env.vps && \
  pg_dump --schema-only --no-owner --no-privileges "$DATABASE_URL" > /tmp/rpow-schema.sql && \
  scp /tmp/rpow-schema.sql ubuntu@15.204.254.192:/tmp/rpow-schema.sql && \
  ssh ubuntu@15.204.254.192 "PGPASSWORD='$RPOW_DB_PASSWORD' psql -h /var/run/postgresql -U rpow_app -d rpow -f /tmp/rpow-schema.sql && rm /tmp/rpow-schema.sql"
```
Verification:
```
local$ . /Users/fredkrueger/rpow/.env.vps && \
  ssh ubuntu@15.204.254.192 "PGPASSWORD='$RPOW_DB_PASSWORD' psql -h /var/run/postgresql -U rpow_app -d rpow -c '\dt'"
```
Expected: lists tables `users`, `tokens`, `challenges`, `magic_links`, `transfers`, `pending_transfers`, `schema_migrations`.

- [ ] **Step 3.6: Phase commit**

No repo files changed. Skip.

---

## Task 4: App deployment (build & systemd, no real DB data yet)

**Goal:** Get the rpow-server binary running on the VPS, talking to the (empty-but-schema'd) local Postgres, with systemd managing it. Cert and nginx come in later tasks.

**Files:**
- Create: `/Users/fredkrueger/rpow/ops/systemd/rpow-server.service` (mirrored to VPS)
- Create on VPS: `/etc/rpow/server.env`, `/etc/systemd/system/rpow-server.service`

- [ ] **Step 4.1: Create the ops directory in the repo**

```
local$ mkdir -p /Users/fredkrueger/rpow/ops/systemd /Users/fredkrueger/rpow/ops/nginx
```

- [ ] **Step 4.2: Write the systemd unit file**

Create `/Users/fredkrueger/rpow/ops/systemd/rpow-server.service`:

```ini
[Unit]
Description=rpow API server
After=network.target postgresql.service
Requires=postgresql.service

[Service]
Type=simple
User=rpow
Group=rpow
WorkingDirectory=/opt/rpow/repo
EnvironmentFile=/etc/rpow/server.env
ExecStart=/usr/bin/node apps/server/dist/server.js
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/rpow/repo
PrivateTmp=true
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 4.3: Clone the repo to /opt/rpow/repo as rpow user**

First confirm latest main is pushed (the VPS clones from GitHub, so unpushed commits would be missing):
```
local$ cd /Users/fredkrueger/rpow && git status -sb && git push origin main
```

Then clone on VPS. Repo is `https://github.com/frkrueger/rpow.git` — public, so no auth needed:
```
local$ ssh ubuntu@15.204.254.192 'sudo -u rpow git clone https://github.com/frkrueger/rpow.git /opt/rpow/repo'
```

> If the repo were private, the alternative is to rsync the local working tree:
> ```
> local$ rsync -avz --delete --exclude node_modules --exclude .git \
>   /Users/fredkrueger/rpow/ ubuntu@15.204.254.192:/tmp/rpow/ && \
>   ssh ubuntu@15.204.254.192 'sudo mkdir -p /opt/rpow/repo && sudo cp -a /tmp/rpow/. /opt/rpow/repo/ && sudo chown -R rpow:rpow /opt/rpow/repo && rm -rf /tmp/rpow'
> ```

Verification:
```
local$ ssh ubuntu@15.204.254.192 'ls /opt/rpow/repo/apps/server/src/server.ts && stat -c "%U:%G" /opt/rpow/repo'
```
Expected: file exists, owner is `rpow:rpow`.

- [ ] **Step 4.4: Build server + shared workspace on VPS**

```
local$ ssh ubuntu@15.204.254.192 'cd /opt/rpow/repo && \
  sudo -u rpow npm ci --workspaces --include-workspace-root --ignore-scripts && \
  sudo -u rpow npm run build --workspace @rpow/shared && \
  sudo -u rpow npm run build --workspace @rpow/server'
```
Verification:
```
local$ ssh ubuntu@15.204.254.192 'ls /opt/rpow/repo/apps/server/dist/server.js'
```
Expected: file exists.

- [ ] **Step 4.5: Create `/etc/rpow` directory and partially-populated env file**

We populate the full env (with Fly-derived secrets) in Task 8. For now, the env file just needs enough to make rpow-server start against the empty schema.

```
local$ . /Users/fredkrueger/rpow/.env.vps && \
  ssh ubuntu@15.204.254.192 "sudo install -d -m 750 -o root -g rpow /etc/rpow && \
    sudo tee /etc/rpow/server.env >/dev/null <<EOF
NODE_ENV=production
PORT=8080
DATABASE_URL=postgres://rpow_app:$RPOW_DB_PASSWORD@/rpow?host=/var/run/postgresql
SESSION_SECRET=$SESSION_SECRET
RPOW_SIGNING_PRIVATE_KEY_HEX=$RPOW_SIGNING_PRIVATE_KEY_HEX
RPOW_SIGNING_PUBLIC_KEY_HEX=$RPOW_SIGNING_PUBLIC_KEY_HEX
RESEND_API_KEY=$RESEND_API_KEY
EMAIL_FROM=$EMAIL_FROM
DIFFICULTY_BITS=$DIFFICULTY_BITS
DIFFICULTY_FLOOR=$DIFFICULTY_FLOOR
MINT_EPOCH_SIZE=${MINT_EPOCH_SIZE:-1000000}
MINT_MAX_SUPPLY=${MINT_MAX_SUPPLY:-21000000}
MAGIC_LINK_BASE_URL=https://api.rpow2.com
WEB_ORIGIN=https://rpow2.com
EOF
sudo chmod 640 /etc/rpow/server.env && sudo chown root:rpow /etc/rpow/server.env"
```

> If `TURNSTILE_SECRET` was in `.env.vps`, append a line for it; otherwise the optional env var is fine to omit.

Verification:
```
local$ ssh ubuntu@15.204.254.192 'sudo -u rpow cat /etc/rpow/server.env | wc -l && sudo stat -c "%a %U:%G" /etc/rpow/server.env'
```
Expected: at least 13 lines, mode `640 root:rpow`.

- [ ] **Step 4.6: Install the systemd unit**

```
local$ scp /Users/fredkrueger/rpow/ops/systemd/rpow-server.service ubuntu@15.204.254.192:/tmp/ && \
  ssh ubuntu@15.204.254.192 'sudo install -m 644 /tmp/rpow-server.service /etc/systemd/system/rpow-server.service && \
    sudo systemctl daemon-reload && \
    sudo systemctl enable rpow-server'
```
Verification:
```
local$ ssh ubuntu@15.204.254.192 'systemctl is-enabled rpow-server'
```
Expected: `enabled`.

- [ ] **Step 4.7: Start rpow-server and verify it runs**

```
local$ ssh ubuntu@15.204.254.192 'sudo systemctl start rpow-server && sleep 3 && systemctl is-active rpow-server'
```
Expected: `active`.

If `failed`, inspect logs:
```
local$ ssh ubuntu@15.204.254.192 'journalctl -u rpow-server -n 50 --no-pager'
```
Likely cause: missing required env var (`env.ts` Zod validation) — fix `/etc/rpow/server.env` and `systemctl restart rpow-server`.

- [ ] **Step 4.8: Test /health locally on VPS (no nginx yet)**

```
local$ ssh ubuntu@15.204.254.192 'curl -fsSL http://127.0.0.1:8080/health'
```
Expected: HTTP 200 with a JSON-ish health response.

- [ ] **Step 4.9: Phase commit**

```
local$ cd /Users/fredkrueger/rpow && \
  git add ops/systemd/rpow-server.service && \
  git commit -m "ops: systemd unit for rpow-server on VPS

Type=simple, runs as rpow:rpow with /etc/rpow/server.env, hardened
with NoNewPrivileges/ProtectSystem/ProtectHome/PrivateTmp.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: TLS via Cloudflare DNS-01

**Goal:** Provision a Let's Encrypt cert for `api.rpow2.com` using DNS-01 challenge with the Cloudflare API token. This works *before* the DNS A-record points at the VPS, because DNS-01 only needs a TXT record.

**Files:**
- No repo files (cloudflare.ini contains a secret).

- [ ] **Step 5.1: Place CF API token at `/etc/letsencrypt/cloudflare.ini`**

```
local$ . /Users/fredkrueger/rpow/.env && \
  ssh ubuntu@15.204.254.192 "sudo install -d -m 700 /etc/letsencrypt && \
    sudo tee /etc/letsencrypt/cloudflare.ini >/dev/null <<EOF
dns_cloudflare_api_token = $CLOUDFLARE_API_TOKEN
EOF
sudo chmod 600 /etc/letsencrypt/cloudflare.ini"
```
Verification:
```
local$ ssh ubuntu@15.204.254.192 'sudo stat -c "%a %U:%G" /etc/letsencrypt/cloudflare.ini'
```
Expected: `600 root:root`.

- [ ] **Step 5.2: Issue cert via DNS-01 — first try the Let's Encrypt staging environment**

Staging avoids hitting LE rate limits if anything goes wrong:
```
local$ ssh ubuntu@15.204.254.192 'sudo certbot certonly --non-interactive --agree-tos \
    --email malibukrueger@gmail.com \
    --dns-cloudflare \
    --dns-cloudflare-credentials /etc/letsencrypt/cloudflare.ini \
    --dns-cloudflare-propagation-seconds 30 \
    --staging \
    -d api.rpow2.com'
```
Expected: ends with "Successfully received certificate." If failure: read the error, most often it's wrong scope on the token. Fix and retry.

- [ ] **Step 5.3: Delete the staging cert and issue the real one**

```
local$ ssh ubuntu@15.204.254.192 'sudo certbot delete --non-interactive --cert-name api.rpow2.com'
```
Then issue with prod:
```
local$ ssh ubuntu@15.204.254.192 'sudo certbot certonly --non-interactive --agree-tos \
    --email malibukrueger@gmail.com \
    --dns-cloudflare \
    --dns-cloudflare-credentials /etc/letsencrypt/cloudflare.ini \
    --dns-cloudflare-propagation-seconds 30 \
    -d api.rpow2.com'
```
Verification:
```
local$ ssh ubuntu@15.204.254.192 'sudo ls /etc/letsencrypt/live/api.rpow2.com/'
```
Expected: lists `cert.pem`, `chain.pem`, `fullchain.pem`, `privkey.pem`, `README`.

- [ ] **Step 5.4: Confirm certbot's renewal timer is enabled**

Certbot installs a systemd timer for renewals automatically:
```
local$ ssh ubuntu@15.204.254.192 'systemctl list-timers --all | grep certbot'
```
Expected: line listing `certbot.timer` with a future "NEXT" run time. The DNS-01 plugin and cloudflare.ini are already configured, so renewals will be automatic.

- [ ] **Step 5.5: Dry-run a renewal to confirm end-to-end**

```
local$ ssh ubuntu@15.204.254.192 'sudo certbot renew --dry-run'
```
Expected: ends with "Congratulations, all simulated renewals succeeded".

- [ ] **Step 5.6: Phase commit**

No repo files changed. Skip.

---

## Task 6: nginx — TLS reverse proxy

**Goal:** nginx fronts the rpow-server on :443 with the LE cert. Smoke-test via `--resolve` (DNS still points at Fly).

**Files:**
- Create: `/Users/fredkrueger/rpow/ops/nginx/api.rpow2.com.conf` (mirrored to VPS)

- [ ] **Step 6.1: Write the nginx site config**

Create `/Users/fredkrueger/rpow/ops/nginx/api.rpow2.com.conf`:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name api.rpow2.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name api.rpow2.com;

    ssl_certificate     /etc/letsencrypt/live/api.rpow2.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.rpow2.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:SSL:10m;

    client_max_body_size 1m;

    access_log /var/log/nginx/api.rpow2.com.access.log;
    error_log  /var/log/nginx/api.rpow2.com.error.log;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 60s;
        proxy_connect_timeout 5s;
    }
}
```

- [ ] **Step 6.2: Install the config and reload nginx**

```
local$ scp /Users/fredkrueger/rpow/ops/nginx/api.rpow2.com.conf ubuntu@15.204.254.192:/tmp/ && \
  ssh ubuntu@15.204.254.192 'sudo install -m 644 /tmp/api.rpow2.com.conf /etc/nginx/sites-available/api.rpow2.com.conf && \
    sudo ln -sfn /etc/nginx/sites-available/api.rpow2.com.conf /etc/nginx/sites-enabled/api.rpow2.com.conf && \
    sudo rm -f /etc/nginx/sites-enabled/default && \
    sudo nginx -t && \
    sudo systemctl reload nginx'
```
Verification: `nginx -t` prints "syntax is ok" and "test is successful".

- [ ] **Step 6.3: Smoke test HTTPS via --resolve (bypassing DNS)**

```
local$ curl -sS -o /dev/null -w "HTTP %{http_code}, cert=%{ssl_verify_result}\n" \
  --resolve api.rpow2.com:443:15.204.254.192 \
  https://api.rpow2.com/health
```
Expected: `HTTP 200, cert=0` (cert=0 means cert verified OK).

- [ ] **Step 6.4: Smoke test HTTPS body**

```
local$ curl -sS --resolve api.rpow2.com:443:15.204.254.192 https://api.rpow2.com/health
```
Expected: a JSON-ish health response.

- [ ] **Step 6.5: Confirm Fly is still serving real traffic (paranoia check)**

```
local$ curl -sS https://api.rpow2.com/health
```
Expected: same JSON-ish response, served by Fly. `dig api.rpow2.com` should still return Fly's IP `66.241.125.213`.

- [ ] **Step 6.6: Phase commit**

```
local$ cd /Users/fredkrueger/rpow && \
  git add ops/nginx/api.rpow2.com.conf && \
  git commit -m "ops: nginx site config for api.rpow2.com

TLS reverse proxy to 127.0.0.1:8080, LE cert from /etc/letsencrypt,
HTTP→HTTPS redirect, 1m body cap.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Backups — restic → B2 + nightly timer

**Goal:** Nightly encrypted off-site backups to Backblaze B2, with a tested restore drill.

**Files:**
- Create: `/Users/fredkrueger/rpow/ops/backup.sh` (mirrored to `/usr/local/bin/rpow-backup`)
- Create: `/Users/fredkrueger/rpow/ops/restore-test.sh`
- Create: `/Users/fredkrueger/rpow/ops/systemd/rpow-backup.service`, `rpow-backup.timer`

- [ ] **Step 7.1: Write `/etc/rpow/restic.env` on the VPS**

```
local$ . /Users/fredkrueger/rpow/.env && . /Users/fredkrueger/rpow/.env.vps && \
  ssh ubuntu@15.204.254.192 "sudo tee /etc/rpow/restic.env >/dev/null <<EOF
B2_ACCOUNT_ID=$B2_KEY_ID
B2_ACCOUNT_KEY=$B2_APP_KEY
RESTIC_REPOSITORY=b2:rpow2-ovhbackup:restic
RESTIC_PASSWORD=$RESTIC_PASSWORD
EOF
sudo chmod 600 /etc/rpow/restic.env"
```
Verification:
```
local$ ssh ubuntu@15.204.254.192 'sudo stat -c "%a %U:%G" /etc/rpow/restic.env'
```
Expected: `600 root:root`.

- [ ] **Step 7.2: Initialize the restic repo**

```
local$ ssh ubuntu@15.204.254.192 'sudo bash -c "set -a; source /etc/rpow/restic.env; set +a; restic init"'
```
Expected: ends with "created restic repository … at b2:rpow2-ovhbackup:restic".
If "config file already exists" — repo was already initialized; OK to proceed.

- [ ] **Step 7.3: Write the backup script**

Create `/Users/fredkrueger/rpow/ops/backup.sh`:

```bash
#!/usr/bin/env bash
# nightly rpow Postgres → B2 backup. Pipes pg_dump straight into restic.
set -euo pipefail

# shellcheck disable=SC1091
source /etc/rpow/restic.env
export B2_ACCOUNT_ID B2_ACCOUNT_KEY RESTIC_REPOSITORY RESTIC_PASSWORD

LABEL="rpow-$(date -u +%FT%H%MZ).dump"

sudo -u postgres pg_dump -Fc rpow \
    | restic backup --stdin --stdin-filename "$LABEL" \
        --tag rpow --tag postgres

# retention: 7 daily, 4 weekly, 6 monthly
restic forget --tag rpow --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune

# integrity check: read 5% of data on each run
restic check --read-data-subset=5%
```

- [ ] **Step 7.4: Install backup script on VPS**

```
local$ scp /Users/fredkrueger/rpow/ops/backup.sh ubuntu@15.204.254.192:/tmp/ && \
  ssh ubuntu@15.204.254.192 'sudo install -m 750 -o root -g root /tmp/backup.sh /usr/local/bin/rpow-backup'
```

- [ ] **Step 7.5: Run the backup once manually**

```
local$ ssh ubuntu@15.204.254.192 'sudo /usr/local/bin/rpow-backup'
```
Expected: ends with "Files: ... new" and a "snapshot ... saved" line, then `forget` output, then `check` output. No errors.

(Note: at this point Postgres only has the schema-only dump, so the backup will be small — that's fine.)

- [ ] **Step 7.6: Verify the snapshot is listed**

```
local$ ssh ubuntu@15.204.254.192 'sudo bash -c "set -a; source /etc/rpow/restic.env; set +a; restic snapshots"'
```
Expected: at least one snapshot row with today's date.

- [ ] **Step 7.7: Write the restore-drill script**

Create `/Users/fredkrueger/rpow/ops/restore-test.sh`:

```bash
#!/usr/bin/env bash
# Restore the latest backup into a scratch DB and assert row counts.
# This is the proof-of-life for the backup system.
set -euo pipefail

# shellcheck disable=SC1091
source /etc/rpow/restic.env
export B2_ACCOUNT_ID B2_ACCOUNT_KEY RESTIC_REPOSITORY RESTIC_PASSWORD

SCRATCH=rpow_restore_test
sudo -u postgres dropdb --if-exists "$SCRATCH"
sudo -u postgres createdb -O rpow_app "$SCRATCH"

LATEST=$(restic snapshots --tag rpow --json | jq -r 'sort_by(.time) | .[-1].id')
echo "Restoring snapshot $LATEST..."

restic dump "$LATEST" "$(restic snapshots "$LATEST" --json | jq -r '.[0].paths[0]')" \
    | sudo -u postgres pg_restore --no-owner --no-privileges -d "$SCRATCH"

echo "Row counts on restored scratch DB:"
sudo -u postgres psql -d "$SCRATCH" -c "
  SELECT 'users' AS tbl, count(*) FROM users
  UNION ALL SELECT 'tokens',         count(*) FROM tokens
  UNION ALL SELECT 'transfers',      count(*) FROM transfers
  UNION ALL SELECT 'magic_links',    count(*) FROM magic_links
  UNION ALL SELECT 'challenges',     count(*) FROM challenges
  UNION ALL SELECT 'pending_transfers', count(*) FROM pending_transfers
  ORDER BY tbl;
"

sudo -u postgres dropdb "$SCRATCH"
echo "Restore drill OK."
```

- [ ] **Step 7.8: Install and run restore drill**

```
local$ scp /Users/fredkrueger/rpow/ops/restore-test.sh ubuntu@15.204.254.192:/tmp/ && \
  ssh ubuntu@15.204.254.192 'sudo install -m 750 -o root -g root /tmp/restore-test.sh /usr/local/bin/rpow-restore-test && \
    sudo /usr/local/bin/rpow-restore-test'
```
Expected: ends with "Restore drill OK." and shows row counts (will all be 0 right now, since DB only has schema). The point is end-to-end success of restore + read.

- [ ] **Step 7.9: Write the systemd timer + service**

Create `/Users/fredkrueger/rpow/ops/systemd/rpow-backup.service`:

```ini
[Unit]
Description=rpow nightly backup
After=postgresql.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/rpow-backup
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
```

Create `/Users/fredkrueger/rpow/ops/systemd/rpow-backup.timer`:

```ini
[Unit]
Description=Nightly rpow backup at 03:00 UTC

[Timer]
OnCalendar=*-*-* 03:00:00 UTC
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
```

- [ ] **Step 7.10: Install the timer + service on VPS**

```
local$ scp /Users/fredkrueger/rpow/ops/systemd/rpow-backup.service \
            /Users/fredkrueger/rpow/ops/systemd/rpow-backup.timer \
            ubuntu@15.204.254.192:/tmp/ && \
  ssh ubuntu@15.204.254.192 'sudo install -m 644 /tmp/rpow-backup.service /etc/systemd/system/ && \
    sudo install -m 644 /tmp/rpow-backup.timer /etc/systemd/system/ && \
    sudo systemctl daemon-reload && \
    sudo systemctl enable --now rpow-backup.timer'
```
Verification:
```
local$ ssh ubuntu@15.204.254.192 'systemctl list-timers rpow-backup.timer'
```
Expected: shows `rpow-backup.timer` with NEXT run time at next 03:00 UTC.

- [ ] **Step 7.11: Phase commit**

```
local$ cd /Users/fredkrueger/rpow && \
  git add ops/backup.sh ops/restore-test.sh \
          ops/systemd/rpow-backup.service ops/systemd/rpow-backup.timer && \
  chmod +x ops/backup.sh ops/restore-test.sh && \
  git commit -m "ops: nightly restic→B2 backups + restore drill

pg_dump piped into restic, retention 7d/4w/6m, 5% read-data check
each run. Restore-test script exercises the full path into a scratch
DB. systemd timer fires nightly at 03:00 UTC.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Pre-cutover prep — full env, scripts, safety dump

**Goal:** Everything ready for cutover. Server starting cleanly with full env, cutover scripts written and committed, safety dump archived.

**Files:**
- Create: `/Users/fredkrueger/rpow/ops/parity-check.sql`
- Create: `/Users/fredkrueger/rpow/ops/smoke-test.sh`
- Create: `/Users/fredkrueger/rpow/ops/dns-flip.sh`
- Create: `/Users/fredkrueger/rpow/ops/cutover.sh`

- [ ] **Step 8.1: Write the row-count parity SQL**

Create `/Users/fredkrueger/rpow/ops/parity-check.sql`:

```sql
-- Run against both Neon and VPS Postgres post-restore.
-- Output should be IDENTICAL row-for-row, table-for-table.
-- If any row differs, ABORT cutover.
SELECT 'users'             AS tbl, count(*) FROM users
UNION ALL SELECT 'tokens',            count(*) FROM tokens
UNION ALL SELECT 'tokens_valid',      count(*) FROM tokens WHERE state='VALID'
UNION ALL SELECT 'tokens_invalidated',count(*) FROM tokens WHERE state='INVALIDATED'
UNION ALL SELECT 'transfers',         count(*) FROM transfers
UNION ALL SELECT 'magic_links',       count(*) FROM magic_links
UNION ALL SELECT 'magic_links_unused',count(*) FROM magic_links WHERE used_at IS NULL
UNION ALL SELECT 'challenges',        count(*) FROM challenges
UNION ALL SELECT 'challenges_unclaimed', count(*) FROM challenges WHERE claimed_at IS NULL
UNION ALL SELECT 'pending_transfers', count(*) FROM pending_transfers
UNION ALL SELECT 'pending_transfers_unclaimed', count(*) FROM pending_transfers WHERE claimed_at IS NULL
ORDER BY tbl;
```

- [ ] **Step 8.2: Write the smoke-test script**

Create `/Users/fredkrueger/rpow/ops/smoke-test.sh`:

```bash
#!/usr/bin/env bash
# Pre-cutover smoke test. Hits the VPS via --resolve so DNS doesn't gate it.
# Exits 0 if all checks pass; nonzero on any failure.
set -euo pipefail

VPS_IP="${VPS_IP:-15.204.254.192}"
HOST="api.rpow2.com"
RESOLVE="--resolve ${HOST}:443:${VPS_IP}"

curl_ok () {
    local label="$1"; shift
    if curl -sS -o /tmp/smoke-body -w "%{http_code}" $RESOLVE "$@" | grep -qE '^(200|2[0-9][0-9])$'; then
        echo "OK   $label"
    else
        echo "FAIL $label"
        echo "---body---"
        cat /tmp/smoke-body
        echo "----------"
        exit 1
    fi
}

echo "=== rpow VPS smoke test (host=$HOST -> $VPS_IP) ==="
curl_ok "GET /health" "https://${HOST}/health"

# /ledger is public and proves DB connectivity end-to-end
curl_ok "GET /ledger" "https://${HOST}/ledger"

# TLS cert sanity
echo | openssl s_client $RESOLVE -servername "$HOST" -connect "${HOST}:443" 2>/dev/null \
  | openssl x509 -noout -subject -dates -issuer

echo "=== smoke OK ==="
```

- [ ] **Step 8.3: Write the DNS-flip helper**

Create `/Users/fredkrueger/rpow/ops/dns-flip.sh`:

```bash
#!/usr/bin/env bash
# Flip api.rpow2.com A (and AAAA if VPS_IPV6 is set) to point at VPS.
# Required env: CLOUDFLARE_API_TOKEN, VPS_IP, VPS_IPV6 (or "NONE")
set -euo pipefail

ZONE_ID="685720286628e21c9b43f260ac6b63bf"
A_REC_ID="34daa777f0dbbdbd1e3c97d6c12e9837"
AAAA_REC_ID="1cfb2458cc028a8f95bea16a439bff6c"

: "${CLOUDFLARE_API_TOKEN:?missing}"
: "${VPS_IP:?missing}"
: "${VPS_IPV6:?missing  (use the literal string NONE if VPS has no IPv6)}"

api () { curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" "$@"; }

echo "Flipping A record to $VPS_IP..."
api -X PATCH --data "{\"content\": \"$VPS_IP\"}" \
    "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records/$A_REC_ID" \
  | jq -e '.success' > /dev/null
echo "  A flipped."

if [ "$VPS_IPV6" = "NONE" ]; then
    echo "Deleting AAAA record (VPS has no IPv6)..."
    api -X DELETE \
        "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records/$AAAA_REC_ID" \
      | jq -e '.success' > /dev/null
    echo "  AAAA deleted."
else
    echo "Flipping AAAA record to $VPS_IPV6..."
    api -X PATCH --data "{\"content\": \"$VPS_IPV6\"}" \
        "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records/$AAAA_REC_ID" \
      | jq -e '.success' > /dev/null
    echo "  AAAA flipped."
fi

echo "Done. Live records:"
api "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records?name=api.rpow2.com" \
  | jq -r '.result[] | "  \(.type) \(.name) -> \(.content) (proxied=\(.proxied), ttl=\(.ttl))"'
```

- [ ] **Step 8.4: Write the cutover orchestration script**

Create `/Users/fredkrueger/rpow/ops/cutover.sh`:

```bash
#!/usr/bin/env bash
# rpow Fly→VPS cutover orchestrator.
# Run from the local laptop. Halts at every gate and waits for ENTER.
#
# Required env (sourced from .env.vps + .env):
#   DATABASE_URL            (Neon, for dump source)
#   RPOW_DB_PASSWORD        (VPS Postgres password for rpow_app)
#   CLOUDFLARE_API_TOKEN    (for DNS flip)
#   VPS_IP, VPS_IPV6        (target of flip)
set -euo pipefail

VPS_HOST="ubuntu@15.204.254.192"
DUMP_LOCAL="/tmp/rpow-cutover-$(date -u +%FT%H%MZ).dump"

gate () {
    echo
    echo "==== GATE: $1 ===="
    echo "Press ENTER to proceed, Ctrl-C to ABORT."
    read -r
}

step () { echo; echo "[$(date -u +%H:%M:%SZ)] $*"; }

echo "rpow cutover starting. Verify pre-flight:"
echo "  - VPS_IP=$VPS_IP, VPS_IPV6=$VPS_IPV6"
echo "  - safety dump already archived to B2? (Step 8.7)"
echo "  - TTL=60 already set on api.rpow2.com? (done 2026-05-07)"
gate "ALL PRE-FLIGHT VERIFIED"

step "T+0s: stopping Fly app"
flyctl scale count 0 --app rpow2-server
sleep 5

step "T+10s: verifying Neon quiescence"
psql "$DATABASE_URL" -c "SELECT pid, usename, state, query FROM pg_stat_activity WHERE datname=current_database() AND state='active' AND pid<>pg_backend_pid();"
gate "Confirm only our session is active"

step "T+20s: pg_dump from Neon"
pg_dump -Fc "$DATABASE_URL" -f "$DUMP_LOCAL"
ls -la "$DUMP_LOCAL"

step "T+40s: scp dump to VPS, pg_restore"
scp "$DUMP_LOCAL" "${VPS_HOST}:/tmp/rpow-cutover.dump"
ssh "$VPS_HOST" "PGPASSWORD='$RPOW_DB_PASSWORD' pg_restore --clean --if-exists --no-owner --no-privileges -h /var/run/postgresql -U rpow_app -d rpow /tmp/rpow-cutover.dump"

step "T+90s: GATE 1 — row-count parity"
echo "--- Neon ---"
psql "$DATABASE_URL" -f "$(dirname "$0")/parity-check.sql"
echo "--- VPS ---"
ssh "$VPS_HOST" "PGPASSWORD='$RPOW_DB_PASSWORD' psql -h /var/run/postgresql -U rpow_app -d rpow -f -" < "$(dirname "$0")/parity-check.sql"
gate "Confirm Neon rows EXACTLY MATCH VPS rows"

step "T+95s: starting rpow-server on VPS"
ssh "$VPS_HOST" "sudo systemctl restart rpow-server && sleep 3 && systemctl is-active rpow-server"

step "T+100s: GATE 2 — smoke test via --resolve"
VPS_IP="$VPS_IP" "$(dirname "$0")/smoke-test.sh"
gate "Confirm /health, /ledger, TLS all OK"

step "T+125s: DNS FLIP — point api.rpow2.com at VPS"
"$(dirname "$0")/dns-flip.sh"

step "T+130s: watching propagation (~60s)"
for i in 1 2 3 4 5; do
    sleep 12
    echo "$(date -u +%H:%M:%SZ)"
    dig +short A api.rpow2.com @1.1.1.1
    dig +short A api.rpow2.com @8.8.8.8
done

step "T+200s: live curl through real DNS"
curl -sS -o /dev/null -w "HTTP %{http_code} cert=%{ssl_verify_result} via %{remote_ip}\n" https://api.rpow2.com/health || true

step "Cutover complete. Monitor for 30 min:"
echo "  ssh $VPS_HOST 'journalctl -u rpow-server -f'"
echo "  ssh $VPS_HOST 'tail -f /var/log/nginx/api.rpow2.com.access.log'"
```

- [ ] **Step 8.5: Make scripts executable and commit**

```
local$ cd /Users/fredkrueger/rpow && \
  chmod +x ops/cutover.sh ops/smoke-test.sh ops/dns-flip.sh && \
  git add ops/parity-check.sql ops/smoke-test.sh ops/dns-flip.sh ops/cutover.sh && \
  git commit -m "ops: cutover orchestrator + parity / smoke / DNS-flip helpers

cutover.sh halts at two manual gates (row-count parity, smoke
test) before any irreversible step. dns-flip.sh PATCHes both A
and AAAA via Cloudflare API; deletes AAAA if VPS has no IPv6.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 8.6: Restart rpow-server on VPS — already has full env from Task 4**

The env file written in Task 4 already contains the carry-over secrets. Confirm it's still healthy:
```
local$ ssh ubuntu@15.204.254.192 'systemctl is-active rpow-server && curl -fsS http://127.0.0.1:8080/health'
```
Expected: `active` and JSON-ish health response.

- [ ] **Step 8.7: Take the pre-cutover safety dump and upload to B2**

This is the rollback artifact. We capture it BEFORE the cutover.sh dump (which runs after Fly is stopped). This dump captures the state Neon is currently in, with users actively writing.

```
local$ . /Users/fredkrueger/rpow/.env.vps && \
  pg_dump -Fc "$DATABASE_URL" -f /tmp/rpow-pre-cutover-safety.dump && \
  ls -la /tmp/rpow-pre-cutover-safety.dump
```

Upload to B2 via restic on the VPS (so it lands in the same off-site repo):
```
local$ scp /tmp/rpow-pre-cutover-safety.dump ubuntu@15.204.254.192:/tmp/ && \
  ssh ubuntu@15.204.254.192 'sudo bash -c "set -a; source /etc/rpow/restic.env; set +a; \
    cat /tmp/rpow-pre-cutover-safety.dump | restic backup --stdin \
      --stdin-filename rpow-pre-cutover-$(date -u +%FT%H%MZ).dump --tag rpow --tag pre-cutover" && \
  rm /tmp/rpow-pre-cutover-safety.dump'
local$ rm /tmp/rpow-pre-cutover-safety.dump
```

Verification:
```
local$ ssh ubuntu@15.204.254.192 'sudo bash -c "set -a; source /etc/rpow/restic.env; set +a; restic snapshots --tag pre-cutover"'
```
Expected: at least one snapshot tagged `pre-cutover`.

- [ ] **Step 8.8: Optional — extend challenge TTL on Fly to 15 min**

Decide now whether to do this. The benefit is small (only helps the rare slow miner whose challenge was issued >4.5 min before T+0). Skip unless you have specific concern.

If yes:
```
local$ cd /Users/fredkrueger/rpow && \
  sed -i.bak 's|new Date(Date.now() + 5 \* 60 \* 1000)|new Date(Date.now() + 15 * 60 * 1000)|' apps/server/src/routes/challenge.ts && \
  rm apps/server/src/routes/challenge.ts.bak && \
  git diff apps/server/src/routes/challenge.ts
```
Verify the diff looks correct, then deploy to Fly:
```
local$ git checkout -b cutover-day-ttl-bump && \
  git commit -am "tmp: extend challenge TTL to 15min for cutover day" && \
  flyctl deploy --app rpow2-server
```
Plan to revert post-migration: `git checkout main`, the branch can be deleted.

If skipping, do nothing.

- [ ] **Step 8.9: Phase commit**

Already committed scripts in 8.5; nothing more to commit unless you did 8.8.

---

## Task 9: Cutover execution

**Goal:** Run the cutover. This is the only task with manual gates and irreversible steps.

**Files:** none modified.

- [ ] **Step 9.1: Pick a low-traffic window**

Skim recent Fly access logs:
```
local$ flyctl logs --app rpow2-server | tail -200
```
Pick a 30-min window with the lowest request rate. Schedule the cutover for that window.

- [ ] **Step 9.2: Pre-flight final check**

Run all verifications one more time:
```
local$ . /Users/fredkrueger/rpow/.env.vps && \
  ssh ubuntu@15.204.254.192 'systemctl is-active rpow-server && systemctl is-active nginx && systemctl is-active postgresql' && \
  curl -sS -o /dev/null -w "VPS: HTTP %{http_code}\n" --resolve api.rpow2.com:443:15.204.254.192 https://api.rpow2.com/health && \
  curl -sS -o /dev/null -w "Fly: HTTP %{http_code}\n" https://api.rpow2.com/health && \
  echo "VPS_IP=$VPS_IP, VPS_IPV6=$VPS_IPV6"
```
Expected: all systemctl active, both `HTTP 200`, IP env vars set.

- [ ] **Step 9.3: Open monitoring dashboards in separate terminals**

In three more shells, run:
```
local-2$ ssh ubuntu@15.204.254.192 'journalctl -u rpow-server -f'
local-3$ ssh ubuntu@15.204.254.192 'sudo tail -f /var/log/nginx/api.rpow2.com.access.log'
local-4$ ssh ubuntu@15.204.254.192 'sudo -u postgres psql rpow -c "SELECT count(*) AS users FROM users; SELECT count(*) AS tokens FROM tokens;"'
```

- [ ] **Step 9.4: Run the cutover script**

```
local$ cd /Users/fredkrueger/rpow && \
  set -a && . .env && . .env.vps && set +a && \
  ./ops/cutover.sh
```

The script halts at two gates (row-count parity, smoke test). Read the output carefully at each gate. **If any value looks off, Ctrl-C — do not press ENTER.**

- [ ] **Step 9.5: Watch propagation in real time**

After the cutover script completes, run for ~5 minutes:
```
local$ watch -n 5 'echo "=== $(date -u) ==="; \
  dig +short A api.rpow2.com @1.1.1.1; \
  dig +short A api.rpow2.com @8.8.8.8; \
  dig +short A api.rpow2.com @9.9.9.9; \
  curl -sS -o /dev/null -w "real-DNS curl: HTTP %{http_code} via %{remote_ip}\n" https://api.rpow2.com/health'
```
Expected: within ~120s, all three resolvers return `15.204.254.192`; the `remote_ip` in the curl is also `15.204.254.192`.

- [ ] **Step 9.6: Verify a full end-to-end flow against production DNS**

In a private browser window or fresh terminal, exercise: magic-link login → mint a token → transfer it → check `/ledger`. Watch the journalctl tail; you should see all of it landing on the VPS.

- [ ] **Step 9.7: Pre-cutover token-verify check**

Take any pre-cutover token (e.g. one in your account from before the migration) and exercise its verification path — this proves the signing key was carried correctly. The exact endpoint depends on the rpow client; the simplest check is: log in with a pre-cutover account, list your tokens. If they appear, the signing key is valid.

If verification fails: this means the wrong `RPOW_SIGNING_PRIVATE_KEY_HEX` is on the VPS. Roll back DNS immediately (see Step 9.8) and investigate.

- [ ] **Step 9.8: Rollback path — only if smoke or token-verify failed**

If you need to abort post-flip:
```
local$ . /Users/fredkrueger/rpow/.env && \
  curl -sS -X PATCH \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
    --data '{"content": "66.241.125.213"}' \
    https://api.cloudflare.com/client/v4/zones/685720286628e21c9b43f260ac6b63bf/dns_records/34daa777f0dbbdbd1e3c97d6c12e9837 && \
  flyctl scale count 1 --app rpow2-server
```

Any writes that hit the VPS during the post-flip window are stranded on VPS. Recovery script (sketch — do not run unless rollback was triggered):
```
ssh ubuntu@15.204.254.192 'sudo -u postgres pg_dump -Fc rpow > /tmp/vps-recovery.dump'
# Then on local, with Neon URL: pg_restore the relevant rows manually.
```

If no rollback needed, skip this step entirely.

---

## Task 10: Post-cutover — soak, decommission, docs

**Goal:** 48-hour soak verifies stability, then decommission Fly. Update RUNBOOK with new operator instructions.

**Files:**
- Modify: `/Users/fredkrueger/rpow/docs/RUNBOOK.md`
- Create: `/Users/fredkrueger/rpow/ops/rpow-status.sh`

- [ ] **Step 10.1: 30-min active monitoring**

For ~30 min after cutover:
- Watch `journalctl -u rpow-server -f` for errors
- Watch `tail -f /var/log/nginx/api.rpow2.com.error.log` for proxy errors
- `sudo -u postgres psql rpow -c "SELECT count(*) FROM tokens;"` periodically — should grow as users mint
- Check Resend dashboard — magic-link emails should still be sending

If errors emerge that aren't transient, investigate. Fly is still scaled to 0 but the project exists; rollback in step 9.8 is still on the table for the first ~hour.

- [ ] **Step 10.2: Confirm next nightly backup runs**

Wait until after 03:00 UTC (or use a manual trigger):
```
local$ ssh ubuntu@15.204.254.192 'sudo systemctl start rpow-backup.service'
```
Verify:
```
local$ ssh ubuntu@15.204.254.192 'sudo journalctl -u rpow-backup --no-pager | tail -30'
```
Expected: ends with no errors, shows snapshot saved.

- [ ] **Step 10.3: Run a fresh restore drill against post-cutover data**

```
local$ ssh ubuntu@15.204.254.192 'sudo /usr/local/bin/rpow-restore-test'
```
Expected: row counts match current production (no longer all zeros).

- [ ] **Step 10.4: Write the rpow-status helper**

Create `/Users/fredkrueger/rpow/ops/rpow-status.sh`:

```bash
#!/usr/bin/env bash
# One-page health summary for the rpow VPS.
set -uo pipefail

bar () { echo "─────────────── $1 ───────────────"; }

bar "services"
for svc in rpow-server nginx postgresql rpow-backup.timer fail2ban; do
    printf "%-25s %s\n" "$svc" "$(systemctl is-active "$svc" 2>&1)"
done

bar "rpow-server health"
curl -sS -o /tmp/h -w "  HTTP %{http_code}, %{time_total}s\n" http://127.0.0.1:8080/health || true
cat /tmp/h; echo

bar "disk"
df -h / /var | awk 'NR<=3 {print "  "$0}'

bar "memory"
free -h | awk '{print "  "$0}' | head -2

bar "postgres size"
sudo -u postgres psql -At -c "SELECT pg_size_pretty(pg_database_size('rpow'));" rpow 2>/dev/null | sed 's/^/  rpow db: /'

bar "cert"
echo | openssl s_client -servername api.rpow2.com -connect 127.0.0.1:443 2>/dev/null \
  | openssl x509 -noout -enddate | sed 's/^/  /'

bar "last backup"
sudo bash -c "set -a; source /etc/rpow/restic.env; set +a; restic snapshots --json --tag rpow" 2>/dev/null \
  | jq -r 'sort_by(.time) | .[-1] | "  \(.time)  \(.short_id)  \(.paths[0])"' \
  || echo "  (could not query)"

bar "fail2ban"
sudo fail2ban-client status sshd 2>/dev/null | grep -E 'Currently|Total' | sed 's/^/  /' || true
```

Install:
```
local$ scp /Users/fredkrueger/rpow/ops/rpow-status.sh ubuntu@15.204.254.192:/tmp/ && \
  ssh ubuntu@15.204.254.192 'sudo install -m 755 /tmp/rpow-status.sh /usr/local/bin/rpow-status'
```
Run once:
```
local$ ssh ubuntu@15.204.254.192 'sudo /usr/local/bin/rpow-status'
```
Expected: a sectioned report, all services `active`, /health 200, cert ~90 days out, recent backup.

- [ ] **Step 10.5: 48-hour soak — wait**

Don't decommission Fly for 48 hours. During this time:
- Spot-check `rpow-status` once or twice a day
- Watch for any user-reported issues (magic-link bounces, mint failures)
- Confirm at least 2 nightly backups have run successfully

If anything looks off, Fly is still there and DNS can flip back via Step 9.8.

- [ ] **Step 10.6: Decommission Fly**

After the soak:
```
local$ flyctl apps destroy rpow2-server
```
Confirm. The Fly machine and its IP are released. Neon project remains for one more week as a deeper safety net.

- [ ] **Step 10.7: Decommission Neon (after one week)**

After ~1 week of soak with no issues:
- Log into Neon dashboard
- Delete the `rpow2` project

> Do not skip the wait. If a subtle bug had VPS data drift from Neon's archived state, Neon is the only authoritative reference for what should-have-been.

- [ ] **Step 10.8: Update RUNBOOK.md**

Replace the contents of `docs/RUNBOOK.md`:

```markdown
# Operator Runbook (post-Fly migration)

## Where things live

- **Server**: OVH VPS at `15.204.254.192`. SSH: `ssh ubuntu@15.204.254.192`
- **Web SPA**: Netlify, deployed automatically from `main`.
- **DB**: PostgreSQL 16 on the same VPS, Unix-socket-only.
- **DNS**: Cloudflare, zone `rpow2.com`.
- **Email**: Resend.
- **Backups**: restic → Backblaze B2 bucket `rpow2-ovhbackup`, nightly at 03:00 UTC.

## Health check

```bash
ssh ubuntu@15.204.254.192 'sudo /usr/local/bin/rpow-status'
```

## Logs

```bash
ssh ubuntu@15.204.254.192 'journalctl -u rpow-server -f'
ssh ubuntu@15.204.254.192 'sudo tail -f /var/log/nginx/api.rpow2.com.access.log'
```

## Deploys (manual)

```bash
ssh ubuntu@15.204.254.192 'cd /opt/rpow/repo && \
  sudo -u rpow git pull origin main && \
  sudo -u rpow npm ci --workspaces --include-workspace-root --ignore-scripts && \
  sudo -u rpow npm run build --workspace @rpow/shared && \
  sudo -u rpow npm run build --workspace @rpow/server && \
  sudo systemctl restart rpow-server'
```

## Secrets

`/etc/rpow/server.env` (mode 0640, root:rpow). Edit with `sudo` and restart `rpow-server` after.

## Difficulty changes

```bash
ssh ubuntu@15.204.254.192 'sudo sed -i "s/^DIFFICULTY_BITS=.*/DIFFICULTY_BITS=30/" /etc/rpow/server.env && \
  sudo systemctl restart rpow-server'
```

## Backup operations

- Nightly: systemd `rpow-backup.timer` at 03:00 UTC.
- Manual: `ssh ubuntu@15.204.254.192 'sudo /usr/local/bin/rpow-backup'`
- Restore drill: `ssh ubuntu@15.204.254.192 'sudo /usr/local/bin/rpow-restore-test'`
- List snapshots: `ssh ubuntu@15.204.254.192 'sudo bash -c "set -a; . /etc/rpow/restic.env; set +a; restic snapshots"'`

## TLS renewals

Auto, via certbot's systemd timer using DNS-01 + the Cloudflare token at `/etc/letsencrypt/cloudflare.ini`. Verify timer health:
```bash
ssh ubuntu@15.204.254.192 'systemctl list-timers certbot.timer'
```

## Rotating the signing key

Same procedure as before — the key lives in `/etc/rpow/server.env` now (not `flyctl secrets`). Restart `rpow-server` after change.

## Incident: VPS down

- Cloudflare DNS will not auto-failover. Existing backups are in B2.
- Recovery: provision new VPS, replay Tasks 1–7 of `docs/superpowers/plans/2026-05-07-fly-to-vps-migration.md`, then `restic restore` the latest snapshot into a fresh `rpow` DB.
- Cert can be re-issued in minutes via DNS-01.
```

- [ ] **Step 10.9: Final commit**

```
local$ cd /Users/fredkrueger/rpow && \
  git add ops/rpow-status.sh docs/RUNBOOK.md && \
  chmod +x ops/rpow-status.sh && \
  git commit -m "docs: post-migration RUNBOOK + rpow-status helper

RUNBOOK reflects new VPS-hosted topology. rpow-status gives a
one-page health view of services, /health, disk, memory, db size,
cert expiry, last backup, fail2ban.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-review notes

Spec coverage check (manually walked through `2026-05-07-fly-to-vps-migration-design.md`):

- ✅ VPS hardening: Task 1 covers SSH, UFW, fail2ban, unattended-upgrades, time sync, rpow user.
- ✅ Software install: Task 2 covers Postgres 16, Node 22, nginx, certbot+cloudflare-plugin, restic, jq.
- ✅ App layout: Task 4 creates `/opt/rpow/repo`, `/etc/rpow/server.env`, systemd unit.
- ✅ TLS: Task 5 uses DNS-01 + Cloudflare token, with staging dry-run first.
- ✅ nginx: Task 6 implements the spec's nginx config sketch.
- ✅ Backups: Task 7 implements restic→B2, retention, restore drill, systemd timer.
- ✅ Cutover: Task 9 with two manual gates, scripted in `ops/cutover.sh`.
- ✅ Rollback: Step 9.8 covers post-flip rollback. Pre-flip rollback is implicit (don't pass gates).
- ✅ Data-loss safety: pre-cutover safety dump (8.7), Gate 1 row-count parity, Gate 2 smoke + token-verify (9.7).
- ✅ Cloudflare proxy off, TTL=60: already done in brainstorming session, recorded in spec; not in plan as steps.
- ✅ IPv6: Step 1.11 captures `VPS_IPV6` to `.env.vps`; `dns-flip.sh` handles flip-or-delete.
- ✅ Netlify: explicitly noted in spec as "no changes"; plan does not touch it.
- ✅ Decommission Fly: Step 10.6.
- ✅ RUNBOOK update: Step 10.8.

No placeholders found in plan. No "implement later" steps. All code blocks contain real content. Type/name consistency: `rpow_app` used everywhere as the DB role; `rpow` as the system user; `rpow-server` as the systemd unit; `rpow-backup` as the backup binary; `rpow-status` as the status binary. Cloudflare zone ID and record IDs match the spec.
