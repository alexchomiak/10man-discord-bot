# PIA verification / PR notes

Verified 2026-09-15 (America/Chicago). These results distinguish local checks
from deployment checks requiring the Linux server, private env file and a live
Discord voice session. No real PIA credentials were supplied or used.

## 1. Full existing test suite — PASS

`npm test` with the existing `node_modules`, Node v20.9.0:

```text
1..114
# tests 114
# suites 0
# pass 114
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1148.179958
```

`PATH=/Users/alexchomiak/.nvm/versions/node/v22.23.2/bin:$PATH npm test`:

```text
1..114
# tests 114
# suites 0
# pass 114
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 952.66
```

Initial sandboxed runs each had one `listen EPERM` failure in the webhook test;
allowing localhost socket access produced the passing results above. Test
requirements/scripts and package manifests were not changed for this feature.

## 2. No-PIA fallback — local smoke/egress PASS; real app deployment SKIPPED

Skipped full app startup with the current production env file because it and
the Linux deployment server were not available in this checkout. No Discord
login or production restart was attempted.

A disposable image was successfully built from local `10man:latest` with the
OS packages added at build time. It reused that image's Node v22.23.2 and
`node_modules`; no `npm install` was run. The current wrapper was mounted read-only
for verification. This tests the runtime additions but is **not** a full build
of the production multi-stage Dockerfile, whose existing dependency stage runs
`npm install`. Its final CMD was supplied explicitly in the smoke test.

With all PIA variables absent and `MODE=help`, `/app/run.sh` returned exit 0:

```text
PIA VPN disabled (credentials not set); using normal networking
Usage: MODE=all|bot|streambot run.sh

MODE=all (default)     run the CS2 real-bot AND the TV streaming selfbot.
MODE=bot               run only the CS2 real-bot (legacy behavior).
MODE=streambot         run only the TV streaming selfbot.
```

Separate isolated containers ran the original entrypoint with a diagnostic shell
command that checked UID, queried `https://api.ipify.org`, and checked auth/PID
file cleanup. Comparison output (verbatim):

```text
PASS baseline: app UID 1000; egress obtained; no auth/PID file remains
PASS disabled: app UID 1000; egress obtained; no auth/PID file remains
PASS failure: app UID 1000; egress obtained; no auth/PID file remains
PASS baseline == disabled == failed VPN: identical public egress IP
```

This compares local Docker baseline egress, not the remote Linux server's IP.
Containers were removed after each check.

## 3. Valid PIA connection — SKIPPED

Skipped because no valid PIA credentials were supplied. A real VPN-up log,
PIA-owned public IP/region, and real authenticated tunnel routing remain
unverified. Mock success checks below are not a substitute.

## 4. Live voice UDP egress — SKIPPED

Skipped because no live Discord voice session or authenticated PIA tunnel was
available. `ss` peer identification and `ip route get <voice-ip>` must be run on
the deployment server during voice playback, as described in `docs/pia.md`.

## 5. Wrong-credentials failure — local auth/fail-open/egress PASS; real app SKIPPED

With deliberately invalid credentials, `PIA_REGION=us_chicago`, and
`--cap-add NET_ADMIN --device /dev/net/tun:/dev/net/tun`, the client reached PIA
and received `AUTH_FAILED`. Relevant output from the launcher smoke test:

```text
2026-09-16 01:25:07 AUTH: Received control message: AUTH_FAILED
2026-09-16 01:25:07 SIGTERM[soft,auth-failure] received, process exiting
WARNING: PIA VPN failed to start; continuing on normal networking
Usage: MODE=all|bot|streambot run.sh

MODE=all (default)     run the CS2 real-bot AND the TV streaming selfbot.
MODE=bot               run only the CS2 real-bot (legacy behavior).
MODE=streambot         run only the TV streaming selfbot.
```

Exit 0. The final wrapper was then used for the separate egress comparison in
step 2: it dropped to UID 1000, kept the baseline public IP, and removed auth/PID
files. Full Discord app startup was skipped because the production env file
was not available. Published-port connectivity during a real VPN session also
remains unverified.

## Additional checks — PASS

`sh -n docker-entrypoint-vpn.sh` and `git diff --check` returned exit 0.
`python3 test/docker-entrypoint-vpn.test.py` uses temporary mocked commands;
it needs no root privileges, Docker, network, real credentials or extra packages.
It checks arguments/exit codes, mode-0600 two-line auth data, redacted diagnostics,
cleanup, timeout, and TERM forwarding:

```text
PASS missing-user
PASS missing-password
PASS missing-region
PASS empty-user
PASS empty-password
PASS empty-region
PASS download
PASS invalid-region
PASS auth
PASS timeout
PASS success
PASS signal
```

A direct assertion against the app's shared redactor returned:

```text
PASS literal password redaction, including absent Discord token
```

The official ZIP URL was fetched successfully and a regional profile inspected.
See `docs/pia.md` for implementation adjustments, required Docker flags and
remaining deployment verification commands. No run script or CI configuration
was changed. Pre-existing unrelated working-tree edits were retained. No PR was
published; these notes are ready to include in its description.

A further Linux-container check replaced only the OpenVPN executable with a
simulated TUN creator. The real wrapper and real `ip` commands installed the
routes and launched the diagnostic command as UID 1000. Exit 0; output:

```text
PIA VPN up: tun0 active
1.1.1.1 via 10.99.0.1 dev tun0 src 10.99.0.2 uid 1000
1.1.1.1 from 172.17.0.2 via 172.17.0.1 dev eth0 table 51820 uid 1000
PASS simulated TUN routing and published-port source reply rule
```

This verifies kernel route selection for new outbound traffic and replies with
the original container source address. It does not verify PIA authentication,
actual remote port reachability, media delivery or a live voice session.
