#!/bin/sh
# Keep the disabled path before all VPN setup, filesystem changes and traps.
if [ -z "${PIA_USERNAME:-}" ] || [ -z "${PIA_PASSWORD:-}" ] || [ -z "${PIA_REGION:-}" ]; then
  echo 'PIA VPN disabled (credentials not set); using normal networking'
  exec /usr/local/bin/docker-entrypoint.sh "$@"
fi

vpn_pid=
app_pid=
reply_routes=false
pia_dns_rule=false
resolver_saved=false
vpn_error='unknown startup failure'
pia_dns_server="${PIA_DNS_SERVER:-10.0.0.243}"
pia_tun_mtu="${PIA_TUN_MTU:-1500}"
original_umask=$(umask)
umask 077

stop_vpn() {
  if [ "$resolver_saved" = true ]; then
    cat /app/pia/resolv.conf.original > /etc/resolv.conf 2>/dev/null || :
    resolver_saved=false
  fi
  if [ "$pia_dns_rule" = true ]; then
    ip -4 rule del priority 8000 to "$pia_dns_server/32" table main 2>/dev/null || :
    pia_dns_rule=false
  fi
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
    ip -4 rule del priority 8999 to 10.0.0.0/8 table 51820 2>/dev/null || :
    ip -4 rule del priority 9000 to 192.168.0.0/16 table 51820 2>/dev/null || :
    ip -4 rule del priority 9001 to 172.16.0.0/12 table 51820 2>/dev/null || :
    ip -4 route flush table 51820 2>/dev/null || :
    reply_routes=false
  fi
  rm -f /run/pia-vpn.pid /app/pia/auth.conf /app/pia/resolv.conf.original 2>/dev/null || :
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
  case "$PIA_REGION" in
    ''|*[!a-zA-Z0-9_-]*) vpn_error='PIA_REGION must be an OpenVPN profile basename using only letters, digits, underscores, or hyphens'; return 1 ;;
  esac
  case "$PIA_USERNAME$PIA_PASSWORD" in *'
'*|*"$(printf '\r')"*) vpn_error='PIA credentials contain an invalid newline'; return 1 ;; esac
  case "$pia_dns_server" in
    10.0.0.241|10.0.0.242|10.0.0.243|10.0.0.244) ;;
    *) vpn_error='PIA_DNS_SERVER must be one of the official PIA DNS addresses: 10.0.0.241, 10.0.0.242, 10.0.0.243, or 10.0.0.244'; return 1 ;;
  esac
  case "$pia_tun_mtu" in
    ''|*[!0-9]*) vpn_error='PIA_TUN_MTU must be an integer from 1200 through 1500'; return 1 ;;
  esac
  if [ "$pia_tun_mtu" -lt 1200 ] || [ "$pia_tun_mtu" -gt 1500 ]; then
    vpn_error='PIA_TUN_MTU must be an integer from 1200 through 1500'
    return 1
  fi
  [ "$(id -u)" = 0 ] || { vpn_error='VPN entrypoint is not running as root'; return 1; }
  [ -c /dev/net/tun ] || { vpn_error='/dev/net/tun is unavailable; add --device /dev/net/tun:/dev/net/tun to the container'; return 1; }
  mkdir -p /app/pia && chmod 700 /app/pia || { vpn_error='cannot create the private /app/pia runtime directory'; return 1; }
  : > /app/pia/openvpn.log || { vpn_error='cannot create /app/pia/openvpn.log'; return 1; }
  ip route save default > /app/pia/default-routes || { vpn_error='cannot read the container default route'; return 1; }
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    --connect-timeout 10 --max-time 30 \
    https://www.privateinternetaccess.com/openvpn/openvpn.zip \
    -o /app/pia/openvpn.zip >> /app/pia/openvpn.log 2>&1 || { vpn_error='failed to download the official PIA OpenVPN bundle'; return 1; }
  unzip -p /app/pia/openvpn.zip "$PIA_REGION.ovpn" \
    > /app/pia/region.ovpn 2>> /app/pia/openvpn.log || { vpn_error="PIA_REGION '$PIA_REGION' was not found in the OpenVPN bundle"; return 1; }
  [ -s /app/pia/region.ovpn ] || { vpn_error="PIA_REGION '$PIA_REGION' produced an empty OpenVPN profile"; return 1; }
  printf '%s\n%s\n' "$PIA_USERNAME" "$PIA_PASSWORD" > /app/pia/auth.conf || { vpn_error='cannot create the private PIA authentication file'; return 1; }
  chmod 600 /app/pia/auth.conf || { vpn_error='cannot secure the PIA authentication file'; return 1; }
  # Preserve replies to published ports (8081 included): sockets with the
  # original container source address use its original routes. New outbound
  # sockets select the tunnel source address and use the VPN default route.
  [ -z "$(ip -4 route show table 51820 2>/dev/null)" ] || { vpn_error='policy-routing table 51820 is already in use'; return 1; }
  ip -o -4 addr show scope global | awk '{ sub(/\/.*/, "", $4); print $4 }' \
    > /app/pia/reply-addresses || { vpn_error='cannot enumerate container IPv4 addresses'; return 1; }
  ip -4 route show table main > /app/pia/main-routes || { vpn_error='cannot read the main routing table'; return 1; }
  reply_routes=true
  while IFS= read -r route; do
    # Intentional splitting: ip route output consists of route argument words.
    ip -4 route add table 51820 $route || { vpn_error='cannot create VPN reply routes; NET_ADMIN capability is required'; return 1; }
  done < /app/pia/main-routes
  while IFS= read -r address; do
    ip -4 rule add priority 10000 from "$address" table 51820 || { vpn_error='cannot create VPN reply rules; NET_ADMIN capability is required'; return 1; }
  done < /app/pia/reply-addresses
  # Destination-based LAN pinning: with the public default route on tun0, any
  # RFC1918 DESTINATION (the host's Docker LAN DNS resolver, host.docker.
  # internal, other cluster containers) is otherwise thrown into the public
  # tunnel and blackholed. Pin all three RFC1918 ranges to the LAN table
  # BEFORE the public default applies. (A from-based src rule can't help: the
  # kernel selects the source address per destination, so this LAN-bound
  # traffic picks the tun0 source address and misses the src rule.)
  ip -4 rule add priority 8999 to 10.0.0.0/8 table 51820 || { vpn_error='cannot create private-network routing rules; NET_ADMIN capability is required'; return 1; }
  ip -4 rule add priority 9000 to 192.168.0.0/16 table 51820 || { vpn_error='cannot create LAN routing rules; NET_ADMIN capability is required'; return 1; }
  ip -4 rule add priority 9001 to 172.16.0.0/12 table 51820 || { vpn_error='cannot create Docker routing rules; NET_ADMIN capability is required'; return 1; }
  rm -f /run/pia-vpn.pid
  # Stay a child of this shell (no --daemon), so shutdown can reliably reap
  # OpenVPN even if it has not yet written its PID file.
  # Ignore PIA's pushed def1 route and install a literal default via tun0.
  /usr/sbin/openvpn --writepid /run/pia-vpn.pid \
    --config /app/pia/region.ovpn --dev tun0 \
    --tun-mtu "$pia_tun_mtu" --fast-io \
    --data-ciphers AES-256-GCM:AES-128-GCM:AES-128-CBC --data-ciphers-fallback AES-128-CBC \
    --auth-user-pass /app/pia/auth.conf --auth-nocache --auth-retry none \
    --pull-filter ignore redirect-gateway --redirect-gateway \
    > /app/pia/openvpn.log 2>&1 &
  vpn_pid=$!
}

configure_vpn_dns() {
  # PIA's private DNS addresses are inside 10/8. The general 10/8 LAN rule
  # above must remain for Unraid/Docker services, so give this single address
  # a higher-priority lookup in the VPN-bearing main table.
  ip -4 rule add priority 8000 to "$pia_dns_server/32" table main || {
    vpn_error='cannot route PIA DNS through tun0; NET_ADMIN capability is required'
    return 1
  }
  pia_dns_rule=true
  ip -4 route get "$pia_dns_server" | grep -Eq "dev tun0( |$)" || {
    vpn_error="PIA DNS $pia_dns_server is not routed through tun0"
    return 1
  }
  cp /etc/resolv.conf /app/pia/resolv.conf.original || {
    vpn_error='cannot save the container DNS configuration'
    return 1
  }
  resolver_saved=true
  printf 'nameserver %s\noptions timeout:2 attempts:3\n' "$pia_dns_server" > /etc/resolv.conf || {
    vpn_error='cannot install the PIA DNS resolver in the container'
    return 1
  }
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
  [ "$vpn_up" = true ] || vpn_error='OpenVPN did not establish a tun0 default route within 30 seconds; inspect the redacted OpenVPN lines above'
  if [ "$vpn_up" = true ] && ! configure_vpn_dns; then
    vpn_up=false
  fi
  if [ "$vpn_up" = true ] && ! getent ahostsv4 discord.com >/dev/null 2>&1; then
    vpn_up=false
    vpn_error="PIA DNS $pia_dns_server could not resolve discord.com through tun0"
  fi
fi

if [ "$vpn_up" != true ]; then
  stop_vpn
  print_log_tail
  echo "PIA VPN startup failed: $vpn_error" >&2
  echo 'WARNING: PIA VPN failed to start; continuing on normal networking' >&2
  trap - INT TERM
  umask "$original_umask"
  exec /usr/local/bin/docker-entrypoint.sh "$@"
fi

echo "PIA VPN up: tun0 active (region $PIA_REGION, MTU $pia_tun_mtu)"
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
