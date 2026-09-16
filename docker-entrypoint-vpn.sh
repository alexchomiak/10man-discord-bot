#!/bin/sh
# Keep the disabled path before all VPN setup, filesystem changes and traps.
if [ -z "${PIA_USERNAME:-}" ] || [ -z "${PIA_PASSWORD:-}" ] || [ -z "${PIA_REGION:-}" ]; then
  echo 'PIA VPN disabled (credentials not set); using normal networking'
  exec /usr/local/bin/docker-entrypoint.sh "$@"
fi

vpn_pid=
app_pid=
reply_routes=false
original_umask=$(umask)
umask 077

stop_vpn() {
  if [ -n "$vpn_pid" ]; then
    kill -TERM "$vpn_pid" 2>/dev/null || :
    # OpenVPN normally removes its routes on TERM; bound cleanup if it hangs.
    remaining=5
    while kill -0 "$vpn_pid" 2>/dev/null && [ "$remaining" -gt 0 ]; do
      sleep 1
      remaining=$((remaining - 1))
    done
    kill -KILL "$vpn_pid" 2>/dev/null || :
    wait "$vpn_pid" 2>/dev/null || :
    vpn_pid=
    ip link delete tun0 2>/dev/null || :
    if [ -s /app/pia/default-routes ]; then
      ip route restore < /app/pia/default-routes 2>/dev/null || :
    fi
  fi
  if [ "$reply_routes" = true ]; then
    while IFS= read -r address; do
      ip -4 rule del priority 10000 from "$address" table 51820 2>/dev/null || :
    done < /app/pia/reply-addresses
    ip -4 rule del priority 9000 to 192.168.0.0/16 table 51820 2>/dev/null || :
    ip -4 rule del priority 9001 to 172.16.0.0/12 table 51820 2>/dev/null || :
    ip -4 route flush table 51820 2>/dev/null || :
    reply_routes=false
  fi
  rm -f /run/pia-vpn.pid /app/pia/auth.conf 2>/dev/null || :
}

shutdown() {
  trap '' INT TERM
  if [ -n "$app_pid" ]; then
    kill -"$1" "$app_pid" 2>/dev/null || :
  fi
  stop_vpn
  if [ -n "$app_pid" ]; then wait "$app_pid" 2>/dev/null || :; fi
  exit "$2"
}
trap 'shutdown TERM 143' TERM
trap 'shutdown INT 130' INT

# Match the existing literal-string token redactor; never interpolate a secret
# into a command, regex, or log. This also redacts diagnostics on setup failure.
print_log_tail() {
  [ -f /app/pia/openvpn.log ] || return 0
  tail -n 20 /app/pia/openvpn.log | node -e '
    let text = "";
    process.stdin.on("data", chunk => { text += chunk; });
    process.stdin.on("end", () => {
      for (const secret of [process.env.PIA_PASSWORD, process.env.PIA_USERNAME]) {
        if (secret) text = text.split(secret).join("***");
      }
      process.stderr.write(text);
    });
  '
}

prepare_vpn() {
  # The verified bundle uses names such as us_chicago.ovpn. Reject paths,
  # glob patterns, option injection and multi-line credentials without echoing.
  case "$PIA_REGION" in ''|*[!a-zA-Z0-9_-]*) return 1 ;; esac
  case "$PIA_USERNAME$PIA_PASSWORD" in *'
'*|*"$(printf '\r')"*) return 1 ;; esac
  [ "$(id -u)" = 0 ] && [ -c /dev/net/tun ] || return 1
  mkdir -p /app/pia && chmod 700 /app/pia || return 1
  : > /app/pia/openvpn.log || return 1
  ip route save default > /app/pia/default-routes || return 1
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    --connect-timeout 10 --max-time 30 \
    https://www.privateinternetaccess.com/openvpn/openvpn.zip \
    -o /app/pia/openvpn.zip >> /app/pia/openvpn.log 2>&1 || return 1
  unzip -p /app/pia/openvpn.zip "$PIA_REGION.ovpn" \
    > /app/pia/region.ovpn 2>> /app/pia/openvpn.log || return 1
  [ -s /app/pia/region.ovpn ] || return 1
  printf '%s\n%s\n' "$PIA_USERNAME" "$PIA_PASSWORD" > /app/pia/auth.conf || return 1
  chmod 600 /app/pia/auth.conf || return 1
  # Preserve replies to published ports (8081 included): sockets with the
  # original container source address use its original routes. New outbound
  # sockets select the tunnel source address and use the VPN default route.
  [ -z "$(ip -4 route show table 51820 2>/dev/null)" ] || return 1
  ip -o -4 addr show scope global | awk '{ sub(/\/.*/, "", $4); print $4 }' \
    > /app/pia/reply-addresses || return 1
  ip -4 route show table main > /app/pia/main-routes || return 1
  reply_routes=true
  while IFS= read -r route; do
    # Intentional splitting: ip route output consists of route argument words.
    ip -4 route add table 51820 $route || return 1
  done < /app/pia/main-routes
  while IFS= read -r address; do
    ip -4 rule add priority 10000 from "$address" table 51820 || return 1
  done < /app/pia/reply-addresses
  # Destination-based LAN pinning: with the public default route on tun0, any
  # RFC1918 DESTINATION (the host's Docker LAN DNS resolver, host.docker.
  # internal, other cluster containers) is otherwise thrown into the public
  # tunnel and blackholed. Pin the whole /16 + docker range to the LAN table
  # BEFORE the public default applies. (A from-based src rule can't help: the
  # kernel selects the source address per destination, so this LAN-bound
  # traffic picks the tun0 source address and misses the src rule.)
  ip -4 rule add priority 9000 to 192.168.0.0/16 table 51820 || return 1
  ip -4 rule add priority 9001 to 172.16.0.0/12 table 51820 || return 1
  rm -f /run/pia-vpn.pid
  # Stay a child of this shell (no --daemon), so shutdown can reliably reap
  # OpenVPN even if it has not yet written its PID file.
  # Ignore PIA's pushed def1 route and install a literal default via tun0.
  /usr/sbin/openvpn --writepid /run/pia-vpn.pid \
    --config /app/pia/region.ovpn --dev tun0 \
    --data-ciphers AES-256-GCM:AES-128-GCM:AES-128-CBC --data-ciphers-fallback AES-128-CBC \
    --auth-user-pass /app/pia/auth.conf --auth-nocache --auth-retry none \
    --pull-filter ignore redirect-gateway --redirect-gateway \
    > /app/pia/openvpn.log 2>&1 &
  vpn_pid=$!
}

vpn_up=false
if prepare_vpn; then
  elapsed=0
  while [ "$elapsed" -lt 30 ]; do
    if kill -0 "$vpn_pid" 2>/dev/null && ip -4 route show default | grep -Eq '^default.*dev tun0( |$)'; then
      vpn_up=true
      break
    fi
    kill -0 "$vpn_pid" 2>/dev/null || break
    sleep 1
    elapsed=$((elapsed + 1))
  done
fi

if [ "$vpn_up" != true ]; then
  stop_vpn
  print_log_tail
  echo 'WARNING: PIA VPN failed to start; continuing on normal networking' >&2
  trap - INT TERM
  umask "$original_umask"
  exec /usr/local/bin/docker-entrypoint.sh "$@"
fi

echo 'PIA VPN up: tun0 active'
umask "$original_umask"
# An exec here would discard the cleanup traps. Only the enabled/success path
# remains a supervisor; the original entrypoint still drops privileges as usual.
/usr/local/bin/docker-entrypoint.sh "$@" &
app_pid=$!
status=0
wait "$app_pid" || status=$?
app_pid=
stop_vpn
exit "$status"
