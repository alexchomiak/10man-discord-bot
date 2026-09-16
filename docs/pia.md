# Optional PIA OpenVPN

Set `PIA_USERNAME`, `PIA_PASSWORD`, and `PIA_REGION` using the same credentials
and variable names as your existing PIA setup. Keep them in your existing
private env file; never commit it. `PIA_REGION` is the exact filename without
`.ovpn` in PIA's bundle, for example `us_chicago`. Display names and region IDs
from other PIA clients are not necessarily profile filenames. If your existing
compose uses different variable names, confirm those names before adapting it.
No compose file or server credentials were available in this checkout.

Keep the existing env-file path, image command and `8081:8081` mapping; add only:

```sh
--cap-add NET_ADMIN --device /dev/net/tun:/dev/net/tun
```

For example, with your existing env file containing all three PIA variables:

```sh
docker run -d --name 10man-streambot \
  --cap-add NET_ADMIN --device /dev/net/tun:/dev/net/tun \
  --env-file /path/to/your/existing.env \
  -p 8081:8081 \
  10man
```

Keep any other existing arguments, including `MODE`. No run script was changed.
Use the usual isolated Docker network, not host networking. The wrapper starts
as root for network setup, then the original entrypoint drops app privileges to
`node`. All packages are installed at image build time. Node remains version 22;
package manifests, dependency installation and `node_modules` are unchanged by
this feature.

## Startup and shutdown

If **any** PIA variable is missing or empty, the wrapper prints
`PIA VPN disabled (credentials not set); using normal networking` and immediately
executes the original entrypoint with the original arguments. It does no VPN
filesystem, download, route, package or signal setup on this path.

When enabled, the wrapper downloads the official bundle, extracts only the
selected profile to `/app/pia/region.ovpn`, and writes a two-line, mode-0600
`/app/pia/auth.conf` inside a mode-0700 directory. OpenVPN logs are private to
root. Failure diagnostics redact credentials by literal string replacement,
matching the app's token-redaction approach. The app's shared redactor also
removes `PIA_PASSWORD`, even when no Discord token is supplied.

The HTTPS download has a separate 30-second timeout. After launching OpenVPN,
the wrapper waits up to 30 seconds for a default IPv4 route through `tun0`, then
prints `PIA VPN up: tun0 active` and launches the unchanged original entrypoint.
It retains PIA's certificate validation and permits AES-128-CBC alongside modern
GCM ciphers for compatibility with the downloaded profile and OpenVPN 2.6.

Any setup/authentication/route timeout fails open: stop and reap OpenVPN, remove
its interface, restore saved default routes, remove temporary reply rules and
auth/PID files, print the redacted log tail and
`WARNING: PIA VPN failed to start; continuing on normal networking`, then exec
the original entrypoint. A failed client cannot later reconnect behind the app.
SIGTERM/SIGINT and normal app exit also clean up OpenVPN.

## Implementation adjustments for PR review

- The suggested per-region ZIP URL was not assumed. PIA's documented working
  endpoint is [the shared OpenVPN bundle](https://www.privateinternetaccess.com/openvpn/openvpn.zip).
  It was downloaded and `us_chicago.ovpn` inspected on 2026-09-15 (America/Chicago).
  See [PIA's Linux instructions](https://helpdesk.privateinternetaccess.com/kb/articles/pdf/linux-setting-up-manual-openvpn-connection-through-the-terminal)
  and [binhex's VPN FAQ](https://github.com/binhex/documentation/blob/master/docker/faq/vpn.md).
- An `exec` discards shell traps. On VPN success only, the wrapper remains as
  supervisor, forwards TERM/INT to the app, preserves its exit status and reaps
  OpenVPN. OpenVPN runs as a background child **without `--daemon`**, retaining
  `--writepid /run/pia-vpn.pid`; this avoids daemon PID-file startup races. Disabled
  and failed startup paths still exec the old entrypoint. App command, env and
  privilege dropping remain unchanged.
- PIA may push `redirect-gateway def1`, which produces two half-default routes
  rather than the requested literal default. The wrapper ignores that push and
  requests `redirect-gateway` without `def1`, so the default-route readiness check
  matches the installed route.
- `iproute2` and `unzip` are required for route checks and extraction, in addition
  to `openvpn` and the already installed `ca-certificates`.
- Source-based IPv4 reply rules preserve published-port replies using the
  container's original addresses/routes (table 51820, rule priority 10000).
  New unbound outbound sockets select the tunnel address/default route. Cleanup
  removes these rules. Explicitly binding an outbound socket to the old container
  address would use the original route; the app does not need such a binding.

This is a separate OpenVPN connection using the same PIA account, not reuse of
the qBittorrent container's tunnel, and it need not receive the same exit IP.
It is intentionally fail-open, with no kill switch. DNS configuration is left
unchanged (Docker's resolver may resolve outside PIA); this implementation routes
IPv4 and does not promise IPv6 protection on IPv6-enabled Docker networks.
Connected Docker subnets retain their routes; remote LAN destinations may require
host-specific routes. Validate ShareTV reachability and port 8081 on deployment.

## Deployment verification

1. Without PIA variables, start using the current env file. Check normal app
   startup and compare `docker exec 10man-streambot curl -s https://api.ipify.org`
   to the host's normal egress IP.
2. With valid PIA variables and the two flags, look for the VPN-up line, run
   `docker exec 10man-streambot ip route`, and repeat the IP check. Verify the
   returned IP's ownership/region; do not assume a fixed PIA ASN.
3. During live voice, inspect `docker exec 10man-streambot ss -unap` for a connected
   UDP peer and run `docker exec 10man-streambot ip route get <voice-ip>`; expect
   `dev tun0`. `ss -unlp` can locate a socket but often does not show its peer.
   If the library uses an unconnected UDP socket, obtain the target from session
   diagnostics or a packet capture; the listening address is not the voice IP.
4. Repeat with a deliberately wrong PIA username. Expect the warning, normal
   app startup, and the original egress IP. Confirm port 8081 remains reachable.

Recorded results and explicit skips are in [pia-verification.md](pia-verification.md).
