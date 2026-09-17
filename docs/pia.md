# Optional PIA VPN

Set `PIA_USERNAME`, `PIA_PASSWORD`, and `PIA_REGION` using the same credentials
and variable names as your existing PIA setup. Keep them in your existing
private env file; never commit it. `PIA_REGION` is the exact filename without
`.ovpn` in PIA's bundle, for example `us_chicago` or `ca_toronto`. Display names and region IDs
from other PIA clients are not necessarily profile filenames. If your existing
compose uses different variable names, confirm those names before adapting it.
No compose file or server credentials were available in this checkout.

`PIA_PROTOCOL` defaults to `wireguard`, the recommended transport for real-time
Discord video. Set `PIA_PROTOCOL=openvpn` only for compatibility or diagnosis.
WireGuard region selection uses the same PIA IDs, obtains a short-lived API
token, registers an ephemeral key, and discards the token and private key during
shutdown. `PIA_WG_MTU` defaults to `1420`.

Keep the existing env-file path, image command and `8081:8081` mapping. WireGuard
requires:

```sh
--cap-add NET_ADMIN
```

The existing `/dev/net/tun` mapping is harmless and may be retained. It is only
required when `PIA_PROTOCOL=openvpn`.

For example, with your existing env file containing all three PIA variables:

```sh
docker run -d --name 10man-streambot \
  --cap-add NET_ADMIN \
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

When WireGuard is enabled, the wrapper obtains a short-lived PIA token, selects
the requested region from PIA's server list, registers an ephemeral public key,
and configures the `pia` interface. Private material is stored only in the
mode-0700 runtime directory and removed during cleanup. OpenVPN mode downloads
the official profile bundle and writes a mode-0600 authentication file. Failure
diagnostics redact credentials by literal string replacement.

WireGuard setup uses PIA's authenticated server API and prints
`PIA VPN up: pia active (WireGuard, ...)` after installing the interface, route,
and private DNS. OpenVPN downloads have a separate 30-second timeout. After
launching OpenVPN, the wrapper waits up to 30 seconds for a default IPv4 route
through `tun0`, then prints `PIA VPN up: tun0 active` and launches the unchanged
original entrypoint.
It retains PIA's certificate validation and permits AES-128-CBC alongside modern
GCM ciphers for compatibility with the downloaded profile and OpenVPN 2.6.

When any PIA setting is present, setup/authentication/route failures are
fail-closed by default: the wrapper removes the VPN interface, restores saved
routes, removes temporary rules and credentials, prints a redacted reason, and
exits without launching the app. This prevents Discord from seeing the host's
normal egress IP after a VPN failure. `PIA_FAIL_OPEN=true` explicitly restores
the former fallback to normal networking. SIGTERM/SIGINT and normal app exit
also clean up the VPN.

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

This is a separate VPN connection using the same PIA account, not reuse of
the qBittorrent container's tunnel, and it need not receive the same exit IP.
Configured PIA mode is fail-closed during startup. This implementation routes
IPv4 and does not promise IPv6 protection on IPv6-enabled Docker networks.
Connected Docker subnets retain their routes. RFC1918 destinations
(`10.0.0.0/8`, `172.16.0.0/12`, and `192.168.0.0/16`) use the original routing
table so private Unraid/Docker and LAN services remain reachable.

Once the VPN interface is ready, the wrapper saves Docker's `/etc/resolv.conf`, installs
PIA's private streaming DNS (`10.0.0.243` by default), and adds a higher-priority
host rule that sends that address through the VPN-bearing main table instead of
the general `10.0.0.0/8` LAN rule. It verifies both the DNS route and a
`discord.com` lookup before starting the app. Cleanup restores Docker's original
resolver. `PIA_DNS_SERVER` may select one of PIA's official private DNS addresses:
`10.0.0.241`, `10.0.0.242`, `10.0.0.243`, or `10.0.0.244`. A failed route or
lookup tears down the tunnel and follows the documented fail-closed path. Validate
ShareTV reachability and port 8081 on deployment.

For real-time Discord video, the wrapper leaves `PIA_TUN_MTU` at OpenVPN's
normal `1500` default and enables OpenVPN's UDP fast-I/O path. Values from 1200
through 1500 are accepted for diagnosing a path with a confirmed MTU problem.
Smaller values increase tunnel packet rate and should not be used as general
latency tuning. This setting does not lower the configured video resolution,
frame rate, or bitrate.

The media pipeline separately uses `SBOT_JITTER_BUFFER_SEC=4` by default. It
fills part of the bounded `SBOT_PIPELINE_BUFFER_MB=8` NUT queue before a remote
source begins feeding the persistent Discord tracks. This absorbs short source
or tunnel stalls while keeping the same Go Live connection. If a longer stall
exhausts that runway, track timing rebases when data resumes instead of sending
all delayed RTP frames in a catch-up burst. Set the jitter buffer to `0` only
for diagnosis; larger values add the same amount of playback startup delay.

## Deployment verification

1. Without PIA variables, start using the current env file. Check normal app
   startup and compare `docker exec 10man-streambot curl -s https://api.ipify.org`
   to the host's normal egress IP.
2. With valid PIA variables and the two flags, look for the VPN-up line, run
   `docker exec 10man-streambot ip route`,
   `docker exec 10man-streambot ip route get 10.0.0.243`, and
   `docker exec 10man-streambot cat /etc/resolv.conf`. The DNS route must use
   `tun0`, and the resolver must name `10.0.0.243`. Repeat the IP check and verify
   the returned IP's ownership/region; do not assume a fixed PIA ASN.
3. During live voice, inspect `docker exec 10man-streambot ss -unap` for a connected
   UDP peer and run `docker exec 10man-streambot ip route get <voice-ip>`; expect
   `dev tun0`. `ss -unlp` can locate a socket but often does not show its peer.
   If the library uses an unconnected UDP socket, obtain the target from session
   diagnostics or a packet capture; the listening address is not the voice IP.
4. Repeat with a deliberately wrong PIA username. Expect the warning, normal
   app startup, and the original egress IP. Confirm port 8081 remains reachable.

Recorded results and explicit skips are in [pia-verification.md](pia-verification.md).
