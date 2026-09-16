# Selfbot PIA VPN egress — spec (Linux Docker server)

Route the streaming selfbot's **outbound** traffic (Discord gateway wss, voice UDP,
media fetches) through the user's existing PIA tunnel, so the egress IP is a PIA IP
and the account egresses as clean residential traffic. Reuse the PIA credentials the
user already has for `qbittorrent-vpn` (`j4ym0/pia-qbittorrent`-style or `binhex/
arch-qbittorrentvpn`) on the same Docker server.

> Selfbot-only scope: only the `10man-streambot` container needs the tunnel. The CS2
> Discord bot and everything else stay on their current network.

---

## TL;DR — Recommendation (read first)

**Run the PIA OpenVPN client INSIDE the streambot container**, using the same
`PIA_USERNAME` / `PIA_PASSWORD` / `PIA_REGION` the user already has for
`qbittorrent-vpn`. The container runs with `--cap-add NET_ADMIN` + a TUN device;
OpenVPN opens a `tun0` interface inside the container's netns, and the container's
default route via OpenVPN's `route-nopull`-less config pins **every** outbound
packet — gateway wss, voice UDP, media fetches — through the tunnel.

Why OpenVPN rather than WireGuard: **OpenVPN works with just username +
password + region** (creds-only), matching how the user is already authenticating
for `qbittorrent-vpn`. PIA WireGuard requires a **per-device provisioned
`wg0.conf`** (a private key PIA mints per device) — not something you can derive
from just the account creds. If the user already has a `.conf` for WireGuard, they
can use it; otherwise OpenVPN is the path.

Why in-container rather than attaching to the qbittorrent container's netns:
1. **Clean failure isolation.** If the PIA tunnel drops, the selfbot's OpenVPN
   client restarts in its own container — the user's qBittorrent/other PIA
   sessions are unaffected.
2. **Self-contained image.** The streambot image ships its own PIA client and
   doesn't require a companion container to be up.
3. **No extra Docker plumbing.** You can't attach an existing container's
   `network_mode: service:` from outside the compose/stack that owns it.

The only cost: adding `openvpn` + `ca-certificates` to the streambot image
(~55 MB). The user's existing PIA credentials (username, password, region) work
unchanged.

**Fallback (degraded): SOCKS5 bridge + proxy env.** Stays in Docker, no TUN
needed. Pins gateway (wss) + media fetches (HTTPS) to PIA, but **NOT voice
UDP** — the voice/`node-av` libraries open a raw UDP socket with no proxy hooks
(verified: zero proxy references in `@dank074/discord-video-stream` and
`@discordjs/voice`). Accept only if an in-container VPN client is genuinely not
possible.

---

## A. Goal & non-goals

**Goal**
- Make the selfbot's *outbound* egress (gateway `gateway.discord.gg` wss, the
  voice UDP socket to whatever IP/port Discord negotiates, and media fetches to
  YouTube / ShareTV host) leave the container via the PIA tunnel → egress IP is a
  PIA IP.
- Reuse the user's existing PIA credentials (username + password + region) that
  already work for `qbittorrent-vpn`.

**Non-goals**
- Inbound traffic (no inbound tunnel for ShareTV; ShareTV is a local/lan host on
  the Docker server and its `GET`s stay direct).
- Changing/rotating the Discord user token (that is the ToS-risk factor, not IP).
- Hiding that the account is a selfbot — a VPN cannot do this.
- Routing other containers (CS2 real-bot, iptv-share) through PIA — out of scope
  unless split-tunneling is explicitly requested.
- Any change to the video/audio pipeline, codecs, or stream parameters.

**Constraint (drives the design):** voice UDP is a direct `dgram`/UDP socket from
`@discordjs/voice`/`node-av`; it ignores `HTTPS_PROXY`/`ALL_PROXY`/SOCKS entirely.
Only the **OS routing table at the process's netns** moves it. That is exactly
what in-container OpenVPN does: `tun0` becomes the default interface in the
container's netns, and the voice socket follows.

---

## B. Options (ranked for this server + Docker context)

### B1. PIA OpenVPN client INSIDE the streambot container — **RECOMMENDED**

- **How:** the streambot Dockerfile installs `openvpn` + `ca-certificates`. At
  container start, a pre-run entry script:
  1. Downloads PIA's CA cert + server list from
     `https://www.privateinternetaccess.com/` (or the user's region-specific
     server set).
  2. Pulls the per-server `.ovpn` config for `PIA_REGION` (e.g.
     `https://www.privateinternetaccess.com/server/region/<region>.zip`).
  3. Writes `PIA_USERNAME` / `PIA_PASSWORD` into the config (or an `auth-user-pass`
     file).
  4. Starts `openvpn --config <region>.ovpn &` and waits for `tun0` to be up
     (`ip addr show tun0`, or poll `ip route | grep default` pointing at `tun0`).
  5. Only then does it `exec node src/streambot/index.js`.
  6. On exit/SIGTERM: kill OpenVPN first, let `tun0` tear down.
- **Capabilities:** `--cap-add NET_ADMIN` (for TUN); `--device /dev/net/tun:rw`
  (mount the host's TUN device into the container). No `--privileged` needed.
- **Credentials:** `PIA_USERNAME`, `PIA_PASSWORD`, `PIA_REGION` env vars.
- **Pros:**
  - Only approach that pins **voice UDP + gateway wss + media** all at the netns
    level (satisfies the primary goal).
  - Reuses the **exact same credentials** (user/pass/region) the user already has
    for `qbittorrent-vpn`. No new PIA object/device needed.
  - Self-contained: the streambot container is the only one that changes.
  - Clean failure semantics: PIA down → the OpenVPN client inside this container
    exits/retries; other PIA consumers are untouched.
  - No second container to manage, no compose wiring, no `network_mode: service:`
    edge cases.
- **Cons:**
  - Adds `openvpn` + `ca-certificates` to the streambot image (~55 MB; acceptable).
  - Requires `--cap-add NET_ADMIN` + `--device /dev/net/tun` at `docker run` — the
    Docker host kernel needs to expose `/dev/net/tun` (every standard Linux Docker
    host has it by default; the container just needs the device mapped).
  - First-start fetch of the per-region PIA `.ovpn` needs outbound HTTPS (which
    isn't tunneled yet — that's fine, it's just a one-shot download before the
    tunnel comes up; use the real line for this).
  - PIA's ToS on simultaneous connections — check plan tier if the user wants to
    run `qbittorrent-vpn` **and** the streambot at the same time (see F4).

### B2. Shared PIA sidecar + `network_mode: service:` — viable if user prefers one PIA egress

- **How:** the user's existing `qbittorrent-vpn` container (or a dedicated
  `pia-egress` sidecar image) owns the TUN interface and runs OpenVPN. The
  streambot container joins it with `network_mode: service:pia-sidecar` (or a
  `depends_on: service_healthy` + shared bridge). Both containers share the
  sidecar's netns → both egress via the same PIA tunnel.
- **Pros:** one PIA connection for all purposes; simpler to reason about
  "one egress IP."
- **Cons:**
  - The streambot's ports must be re-exposed through the sidecar (`-p 8081:8081`
    still works via the host, but intra-network traffic between the two
    containers now goes through the sidecar's netns, not the bridge).
  - Ties streambot's lifespan to the sidecar container (sidecar down → streambot
    can't start). For a selfbot that "must always be available," this is a
    coupling you don't need.
  - If the user's `qbittorrent-vpn` image has a killswitch (iptables rules that
    block all non-tun egress), those rules apply to the streambot too, which may
    or may not be desirable.
- **Verdict:** reasonable if the user wants "one PIA tunnel for the whole
  stack," but adds coupling for no functional gain over B1.

### B3. SOCKS5 bridge + proxy env — **DEGRADED, not recommended**

- **How:** a small `dante` or `microsocks` container bridges from a PIA-tuned
  tunnel; the streambot runs with
  `ALL_PROXY=socks5://bridge:1080 HTTPS_PROXY=… HTTP_PROXY=… NO_PROXY=127.0.0.1,<sharetv>`.
- **The limitation (say it plainly):** **voice UDP does NOT go through SOCKS5.**
  `node-av`/`@discordjs/voice` open a raw UDP socket to the IP+port Discord
  negotiates; no proxy hook exists in the libraries. So under B3: **gateway and
  media fetches are on PIA; voice media + voice data are on the real line.**
  Since "make the account look like clean residential traffic," voice is
  precisely the fingerprint left on the real IP.
- **Verdict:** only if B1 is genuinely infeasible (e.g. Docker host kernel lacks
  TUN support, or the user can't get `NET_ADMIN`/TUN on the server). B1 is
  the correct default on any normal Linux Docker host.

### B4. PIA WireGuard inside the container — same shape as B1, needs a provisioned config

- **How:** same as B1 but with WireGuard client instead of OpenVPN.
- **Caveat:** PIA WireGuard is **per-device provisioned** — the user (or a PIA
  client app) must have already generated a `wg0.conf` + private key for this
  device. Credentials + region alone are not enough. If the user has a PIA
  desktop app already signed in on the server, they can export the conf;
  otherwise OpenVPN (B1) is simpler because it just needs username/password.
- **MTU:** WireGuard default ~1420; if they see voice stutter, drop to 1280.

### Ranked

1. **B1 — in-container PIA OpenVPN, creds-only, `NET_ADMIN` + TUN — RECOMMENDED.**
2. **B4 — in-container PIA WireGuard — viable if a provisioned `wg0.conf` exists.**
3. **B2 — shared PIA sidecar — reasonable for "one egress IP" but adds coupling.**
4. **B3 — SOCKS5 bridge — degraded (no voice coverage); only if B1/B4 infeasible.**

---

## C. Reusing the existing PIA credentials (qbittorrent-vpn)

> **Security rule:** do not print, commit, or copy secrets into files. Refer to
> them as `${PIA_USERNAME}` / `${PIA_PASSWORD}` / `${PIA_REGION}`. The `.ovpn`
> config (if used) includes a CA cert + server list; treat it as credential
> material.

**What the user already has** (based on `qbittorrent-vpn` being up and working)
- A PIA **username + password** (account credentials).
- A **region** (e.g. `netherlands`, `germany`, `france` — whatever
  `qbittorrent-vpn` is pinned to).
- Possibly a **WireGuard per-device config** from the PIA desktop app
  (`~/wireguard/*.conf` or wherever PIA stored it on the server).

**What to verify before implementing:**
1. **Region:** what region is the running `qbittorrent-vpn` pinned to? Run
   `docker exec <qbittorrent-vpn> env | grep -iE 'PIA_REGION|VPN'` (or read its
   compose file) to read the region string **as it is spelled in the config**,
   because PIA's per-region `.ovpn` files are named by exact slug (e.g.
   `nl1`, `nl2` for Netherlands, `de1`, `de2`, `fr1`, …).
2. **Auth form:** does `qbittorrent-vpn` use `auth-user-pass` (PIA_USERNAME /
   PIA_PASSWORD) or a provisioned WireGuard conf? Both work for the selfbot too;
   OpenVPN + user/pass is simpler to mirror exactly.
3. **PIA plan:** check the user's PIA tier for **simultaneous connection count**.
   If the tier is limited (e.g. 10 connections, which is PIA Standard), running
   two containers on the same account is fine as long as they're not both
   connected at the same time, or the tier allows concurrent. Check
   `my.pia.com` → Billing → Plan.
4. **Where the credentials live on the server (check in this order):**
   - The running `qbittorrent-vpn` container: `docker exec <qbittorrent-vpn> sh -c 'env | grep -iE "PIA|VPN" ; ls /config /config/* 2>/dev/null'
     to see the exact env variables + any mounted credential files.
   - The Docker compose file for `qbittorrent-vpn`: find it (usually
     `~/docker/qbittorrentvpn/` or similar on the server) and read the
     `environment:` + `volumes:` blocks. **These ARE the credentials to reuse** —
     copy the env var **names** (not values yet), and the user can confirm
     the values match their PIA account.
   - If WireGuard: look for `*.conf` under whatever directory the container
     mounts, or `~/.wireguard/` on the host.

**The three env vars to reuse verbatim:** `PIA_USERNAME`, `PIA_PASSWORD`,
`PIA_REGION` (+ optionally `VPN_CLIENT=openvpn` if the selfbot mirrors the
qbittorrent-vpn naming). Do **not** copy the credentials into this spec or into
the repo — they should be in the `.env` / `docker-compose.yml` on the server, or
in env at `docker run` time, never committed.

---

## D. Implementation plan (approvable steps — EXAMPLES, not to be run yet)

> All commands below are **EXAMPLES**. Do not execute until approved.

### D1. Where the VPN runs

- **Primary (B1):** inside the `10man-streambot` container. Add the OpenVPN
  client to the image; a pre-run entrypoint starts it and waits for `tun0`
  before launching `node src/streambot/index.js`.
- **Fallback (B3):** keep in container, but with a `dante`/`microsocks` bridge
  container + `ALL_PROXY` env on the streambot container. Voice is not covered.

### D2. Dockerfile changes (describe, not implemented)

```
# Top of the current stage-1 (node-base) section, before `npm ci`:
RUN apt-get update && apt-get install -y --no-install-recommends \
  openvpn ca-certificates resolvconf dbus \
  && rm -rf /var/lib/apt/lists/*
```

(Exact package list may vary; `openvpn` pulls in `openvpn-auth` and `ca-
certificates` anyway. `resolvconf` for DNS handling. Total image delta
~55 MB.)

Also add a `/app/pia/` directory and a small `pia-entry.sh` entrypoint (or fold
it into the existing `docker-entrypoint.sh`) that:

1. Reads `PIA_USERNAME`, `PIA_PASSWORD`, `PIA_REGION` from env.
2. **Fetches the PIA `.ovpn` config** for `PIA_REGION`:
   - PIA publishes per-region `.ovpn` at
     `https://www.privateinternetaccess.com/openvpn/<region>.zip` (region slug
     like `nl1`, `de2`). Confirm exact URL from the current PIA docs / the
     `qbittorrent-vpn` compose at runtime.
   - Extract, write `<region>.ovpn` into `/app/pia/`.
3. **Write `auth.conf`** with `PIA_USERNAME` on line 1 and `PIA_PASSWORD` on
   line 2; chmod 600. (This is the same `auth-user-pass` form `qbittorrent-vpn`
   uses.)
4. **Start OpenVPN:**
   ```
   /usr/sbin/openvpn --daemon --writepid /tmp/pia-vpn.pid \
     --config /app/pia/<region>.ovpn \
     --auth-user-pass /app/pia/auth.conf \
     > /app/pia/openvpn.log 2>&1 &
   ```
5. **Wait for `tun0`:**
   ```
   for i in $(seq 1 30); do
     if ip route | grep -E '^default.*via.*dev tun'; then
       break
     fi
     sleep 1
   done
   # If tun0 never comes up, print openvpn.log tail and fail (or go direct —
   # see D5 for the fail-open/closed decision).
   ```
6. **Launch the bot:** `exec node src/streambot/index.js` (the entrypoint's
   final step, same as today).
7. **On exit:** `kill $(cat /tmp/pia-vpn.pid)` if it's alive, so the tunnel
   doesn't outlive the container.
8. **DNS:** OpenVPN inside a container often needs
   `--script-security 2 --up /etc/openvpn/update-resolv-conf` (the `resolvconf`
   package handles it). If DNS leaks, pin the container's `/etc/resolv.conf` to
   a public resolver and route through the tunnel only for IPv4 traffic.

Also add a `vpn-entrypoint.sh` as the container ENTRYPOINT that wraps the above
(1–7) and `exec`s the current entrypoint. This keeps the "VPN first, then bot"
ordering without entangling the Node boot path.

### D3. `docker run` / compose changes (EXAMPLE)

```
# Before (today):
docker run -d --name 10man-streambot \
  --env-file /tmp/sbot.env.fixed \
  -p 8081:8081 \
  10man

# After (B1):
docker run -d --name 10man-streambot \
  --cap-add NET_ADMIN \
  --device /dev/net/tun:/dev/net/tun \
  --env-file /tmp/sbot.env.fixed \
  -p 8081:8081 \
  -e PIA_USERNAME -e PIA_PASSWORD -e PIA_REGION \
  10man
```

- `--cap-add NET_ADMIN` + `--device /dev/net/tun` are the only new `docker run`
  arguments. No `--privileged` needed. No new network.
- The three `PIA_*` env vars should come from the same `.env`/`env-file` that
  the user already has for `qbittorrent-vpn` (or a copy of them under a
  different name so it's clear it's reused). Do **not** hardcode in the image.
- **The three `PIA_*` values must match the user's PIA account as used by
  `qbittorrent-vpn`.** Same account, same region (ideally same egress IP) for
  consistency. Confirm the region slug with the user before first deploy.

### D4. Bot-side env + config (no code change in `config.js` unless desired)

The bot itself needs no routing code — the tunnel pins the netns by design.
Optional additions (all non-fatal, all default-off so existing deploys are
unchanged):

- `VPN_EXPECTED_EGRESS_CIDR` (string, e.g. the PIA ASN range the user expects) —
  at bot start, do a `fetch('https://api.ipify.org')` and compare to the
  expected subnet. If mismatch → warn via the alert sink (existing
  `alerts.js`). **Do not crash the bot.** Non-fatal by design.
- `VPN_LOG_LEVEL` (`info` | `debug`) — default `info`. Controls whether the
  entrypoint prints OpenVPN log lines on failure.
- `VPN_FAIL_MODE` (`closed` | `open`, default `closed`) — if the tunnel never
  comes up within 30 s:
  - `closed`: exit the container (the bot doesn't start without VPN).
  - `open`: log a warning, continue without VPN (the bot is up but egresses on
    the real IP). Only choose `open` if the user prefers "bot available" over
    "bot invisible." Recommend `closed`.

### D5. Verification (do this after deployment)

Checklist (strongest = toggle test):

1. **Interface is up:** `docker exec 10man-streambot ip addr show tun0` → should show
   `tun0` with an address in the PIA subnet, UP + RUNNING.
2. **Route points at the tunnel:** `docker exec 10man-streambot ip route` → default
   via `tun0`.
3. **Egress IP via the bot, tunnel UP:** from inside the container,
   `docker exec 10man-streambot curl -s https://api.ipify.org` → must be a **PIA
   IP** matching the region. (Also check the ASN: PIA is AS14061 — `whois` the
   IP to confirm.)
4. **Negative control, tunnel DOWN (or `VPN_FAIL_MODE=open`):** same `curl` with
   the tunnel stopped → must be the **server's real ISP IP**.
   The UP=PIA / DOWN=real toggle proves the *container process* egresses via the
   tunnel, not just that "some other app is tunneling."
5. **Voice path check (the hard part, do it once):**
   - Join a voice channel (test stream).
   - `docker exec 10man-streambot ss -lnp | grep -E 'udp'` → find the socket the
     voice lib opened (it'll be to a Discord voice IP).
   - `docker exec 10man-streambot ip route get <voice-ip>` → should show `dev
     tun0` in the route. That's the direct proof the voice UDP goes via the
     tunnel.
6. **Media fetch IP:** run a `$stream <yt-url>`; during that, from another shell
   `docker exec 10man-streambot ss -nup` (or `tcpdump -i any host <yt-ip>`) to
   confirm outbound to YouTube/CDN is via `tun0`. (If yt-dlp uses HTTP, `ss -tnp`
   shows the TCP sockets; check their `local:` / `peer:` — the remote peer will be
   the PIA IP if routing is correct, or the real egress IP if not. Simpler: run
   `curl` from inside the container to `https://www.youtube.com` and inspect
   `X-Forwarded-For` / `CF-RAY` headers — PIA IPs vs real IPs.)
7. **DNS leak check:** `docker exec 10man-streambot nslookup google.com` → the
   resolver IP should be a PIA resolver (or a public one routed via `tun0`).
   Low priority; the VPN works even with DNS leak, it's just a fingerprint.
8. **No local leakage:** make sure ShareTV / `127.0.0.1` / LAN traffic is NOT
   routed via `tun0`. Add a `route` exception for the ShareTV subnet
   (e.g. `192.168.0.0/16` or `10.0.0.0/8` depending on the server) before the
   tunnel default-route: `ip route add <sharetv-subnet> dev eth0` (direct).
   If the ShareTV host is on a private range, OpenVPN's default route will still
   send LAN-bound traffic to the tunnel unless we add the exception. **Do this
   in the `up` script**, not in the bot code.

### D6. Failure modes & non-fatal handling

- **PIA down / credentials wrong → OpenVPN fails to start.** Default: **fail-
  closed** — the container exits (the bot doesn't start without the tunnel).
  On restart, Docker's `--restart=unless-stopped` (set if not set already)
  retries; when PIA recovers, the bot comes up. Emit a `vpn-failed` event to
  the existing alert sink (the `notifications` webhook) so the user knows.
- **PIA down mid-stream.** OpenVPN client usually retries/reconnects (that's
  what OpenVPN does by default). While reconnected, the tunnel is down and
  outgoing packets queue or drop. If the tunnel drops for > ~30 s the voice WS
  will disconnect; `discord.js-selfbot-v13` auto-reconnects the gateway; the
  voice path will re-establish on the next `$stream`. Non-fatal to the bot,
  but the current stream is interrupted. Log it via the alert sink.
- **DNS leak.** Not a functional problem; a fingerprint. PIA-managed OpenVPN
  config usually sets the tunnel's DNS. If it doesn't and the container's
  `/etc/resolv.conf` points at the server's local DNS, set `resolvconf` to
  PIA's DNS in the `up` script. Low priority.
- **MTU / fragmentation (voice is UDP — shows as stutter, not clean errors).**
  PIA OpenVPN default MTU is 1400–1420; if voice stutters under sustained
  load, drop the tunnel MTU to **1280** (`mtu 1280` in the `.ovpn`) and retry.
  Common fix after the first stutter.
- **Concurrent-connection limits (PIA tier).** If the user's PIA tier is
  limited (e.g. 10 or 5 simultaneous connections), running `qbittorrent-vpn`
  **and** the streambot on the same account is fine at steady state (2
  connections), but if either drops and both retry at the same time, one may be
  denied. Low risk; check the tier at setup (F4).
- **TUN device unavailable on the Docker host.** Almost no modern Linux Docker
  host has this; if it does, fall back to B3 (SOCKS5 bridge) — but that
  doesn't cover voice, so this is a genuine blocker. Verify with
  `ls -l /dev/net/tun` on the server before implementing.

---

## E. Risk / limitations (keep it real, not preachy)

- **VPN ≠ selfbot invisibility.** It changes egress IP; it does nothing about
  the user-token behavior that makes the account a selfbot. ToS risk stays.
  (This is the "hide IP, not identity" reality.)
- **PIA tier / concurrency.** Check the user's tier for simultaneous
  connections before enabling both `qbittorrent-vpn` and the selfbot on the
  same account at the same time (F4).
- **PIA down is a hard dependency on B1.** If PIA is unreachable (or the
  server can't reach `privateinternetaccess.com` to fetch the config), the
  selfbot container won't start in `VPN_FAIL_MODE=closed`. If the user wants
  "bot always up," use `open` and accept the real-egress-IP risk.
- **Voice UDP is the sensitive one — B1 covers it, B3 does not.** The whole
  point of this spec is that B1/B4 pin the netns so the voice socket follows;
  if for any reason we degrade to B3, the account's voice traffic still
  egresses on the real server IP.

---

## F. Open questions for the user

1. **Which PIA region** is the running `qbittorrent-vpn` pinned to? (Match it
   exactly for a stable egress IP; or pick a different PIA region for the
   selfbot if you want to spread the signal across two PIA IPs.)
2. **PIA tier:** how many simultaneous connections does the account allow?
   (Standard = 10; Premium varies. Confirm at `my.pia.com` → Billing.)
   This matters if you want `qbittorrent-vpn` + the selfbot both connected at
   the same time (yes, that's the default B1 — it adds one more PIA
   connection).
3. **Auth form you already have:** just `PIA_USERNAME` + `PIA_PASSWORD` +
   `PIA_REGION` (OpenVPN, creds-only — easiest, matches B1), **or** a PIA
   WireGuard `.conf` + private key (B4, works too)?
4. **`qbittorrent-vpn` location on the server:** what's the compose file path /
   container name? (So we can reuse the exact env var **names** — e.g. does
   it already call them `PIA_USERNAME`/`PIA_PASSWORD`/`PIA_REGION` or
   `VPN_USERNAME`/`VPN_PASSWORD`/`VPN_REGION`? Copy the names verbatim so the
   credentials are in one place.)
5. **PIA-down behavior:** `closed` (bot won't start without the tunnel, default
   recommendation) or `open` (bot always up, egresses on the real IP if PIA
   is down)?
6. **ShareTV / LAN reachability:** what subnet is the ShareTV / iptv-share
   host on (`192.168.0.0/16`? `10.x`? another LAN?)? We'll add a direct-route
   exception for that subnet so local ShareTV traffic isn't round-tripped
   through PIA.

---

## G. References / sources (current as of research)

- **`qbittorrent-vpn` (the proven reference implementation).**
  - PIA-specific image: `j4ym0/pia-qbittorrent` (`github.com/j4ym0/pia-qbittorrent-docker`).
  - Multi-provider: `binhex/arch-qbittorrentvpn` (`github.com/binhex/arch-qbittorrentvpn`).
  - Both run OpenVPN or WireGuard inside a single container with
    `--cap-add NET_ADMIN` + TUN, using PIA username/password/region for
    OpenVPN or a PIA-provisioned WG conf for WireGuard. Killswitch (iptables)
    optional. No SOCKS5 bridge — direct TUN.
- **`@dank074/discord-video-stream@6.0.0` + `@discordjs/voice@0.19`** — vendored
  under `node_modules/`; grep-confirmed **no proxy hooks** in the voice path
  (source of the "voice UDP can't use a proxy" constraint).
- **PIA OpenVPN distribution:** PIA publishes per-region `.ovpn` files at
  `https://www.privateinternetaccess.com/openvpn/` (region slug e.g. `nl1`,
  `de2`, `fr1`); the standard credential form is a two-line `auth.conf`
  (username, password) — the same form `qbittorrent-vpn` uses.
- **PIA WireGuard:** per-device provisioned; `PIA_USERNAME`/`PIA_PASSWORD`/region
  alone are not enough for WireGuard. You need a `wg0.conf` + the private
  key for that device (PIA desktop app or `piawg` to generate).
- **No official PIA Node SDK for programmatic tunnel setup.** Closest found:
  `piavpnjs` (desktop client wrapper — not viable headless in Docker),
  `the-wireguard-effect` (WireGuard-go wrapper — needs a provisioned conf
  anyway). The community-standard path (what `qbittorrent-vpn` uses) is
  `openvpn` + `auth-user-pass` + region.
