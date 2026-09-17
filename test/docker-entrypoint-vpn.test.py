import os, pathlib, subprocess, tempfile, time
# Dependency-free mock tests; no root, Docker, network, or real credentials.
source = (pathlib.Path(__file__).resolve().parents[1] / 'docker-entrypoint-vpn.sh').read_text()
with tempfile.TemporaryDirectory(prefix='pia-wrapper-') as directory:
    root = pathlib.Path(directory)
    bindir = root / 'bin'
    bindir.mkdir()
    def executable(path, text):
        path.write_text(text)
        path.chmod(0o755)
    resolv = root / 'resolv.conf'
    wrapper = source.replace('/usr/local/bin/docker-entrypoint.sh', str(bindir / 'original')).replace('/usr/sbin/openvpn', str(bindir / 'openvpn')).replace('/app/pia', str(root / 'pia')).replace('/run/pia-vpn.pid', str(root / 'vpn.pid')).replace('/etc/resolv.conf', str(resolv)).replace('/dev/net/tun', '/dev/null')
    executable(root / 'wrapper', wrapper)
    executable(bindir / 'original', '''#!/bin/sh
printf 'APP:%s:%s\\n' "$1" "$2"
if [ "$CASE" = signal ]; then
  trap 'echo APP_STOP; exit 0' TERM INT
  while :; do /bin/sleep 0.05; done
fi
exit 7
''')
    executable(bindir / 'id', '#!/bin/sh\necho 0\n')
    executable(bindir / 'sleep', '#!/bin/sh\n/bin/sleep 0.02\n')
    executable(bindir / 'curl', '''#!/bin/sh
echo curl >> "$ROOT/calls"
if [ "$CASE" = download ]; then exit 22; fi
output=
previous=
for argument in "$@"; do
  if [ "$previous" = -o ]; then output=$argument; fi
  previous=$argument
done
case "$*" in
  *'/api/client/v2/token'*) printf '{"token":"test-token"}\\n' > "$output" ;;
  *'serverlist.piaservers.net'*) printf '{"regions":[{"id":"us_chicago","servers":{"wg":[{"ip":"203.0.113.8","cn":"wg.example"}]}}]}\\nSIGNATURE\\n' > "$output" ;;
  *'/addKey'*) printf '{"status":"OK","peer_ip":"10.7.8.9/32","server_key":"server-public-key","server_port":1337}\\n' > "$output" ;;
esac
exit 0
''')
    executable(bindir / 'getent', '''#!/bin/sh
grep -q '^nameserver 10.0.0.243$' "$ROOT/resolv.conf" || exit 1
[ "$CASE" != dns ]
''')
    executable(bindir / 'unzip', '#!/bin/sh\necho "client"\n')
    executable(bindir / 'ip', '''#!/bin/sh
echo "ip $*" >> "$ROOT/calls"
case "$*" in
  'route save default') echo saved ;;
  '-o -4 addr show scope global') echo '2: eth0 inet 172.17.0.2/16 scope global eth0' ;;
  '-4 route show table main') echo 'default via 172.17.0.1 dev eth0' ;;
  '-4 route show default')
    if [ -f "$ROOT/ready" ]; then
      if [ "${PIA_PROTOCOL:-wireguard}" = wireguard ]; then echo 'default dev pia'; else echo 'default via 10.0.0.1 dev tun0'; fi
    fi ;;
  '-4 route get 10.0.0.243')
    if [ "${PIA_PROTOCOL:-wireguard}" = wireguard ]; then echo '10.0.0.243 dev pia src 10.7.8.9'; else echo '10.0.0.243 dev tun0 src 10.1.2.3'; fi ;;
  '-4 route get 203.0.113.8') echo '203.0.113.8 via 172.17.0.1 dev eth0 src 172.17.0.2' ;;
  'link set mtu 1420 up dev pia') touch "$ROOT/ready" ;;
esac
''')
    executable(bindir / 'jq', '''#!/usr/bin/env python3
import json, pathlib, sys
path = pathlib.Path(sys.argv[-1])
data = json.loads(path.read_text())
query = next((a for a in sys.argv[1:] if a.startswith('.')), '')
if query.startswith('.regions'):
    region = sys.argv[sys.argv.index('--arg') + 2]
    print(json.dumps(next(r for r in data['regions'] if r['id'] == region)))
elif '.token' in query: print(data['token'])
elif '.servers.wg[0].ip' in query: print(data['servers']['wg'][0]['ip'])
elif '.servers.wg[0].cn' in query: print(data['servers']['wg'][0]['cn'])
elif '.status' in query: print(data.get('status', ''))
elif '.peer_ip' in query: print(data['peer_ip'])
elif '.server_key' in query: print(data['server_key'])
elif '.server_port' in query: print(data['server_port'])
else: sys.exit(1)
''')
    executable(bindir / 'wg', '''#!/bin/sh
echo "wg $*" >> "$ROOT/calls"
case "$1" in
  genkey) echo private-key ;;
  pubkey) cat >/dev/null; echo public-key ;;
esac
''')
    executable(bindir / 'openvpn', '''#!/usr/bin/env python3
import os, pathlib, signal, time, sys
root = pathlib.Path(os.environ['ROOT'])
assert '--tun-mtu' in sys.argv and sys.argv[sys.argv.index('--tun-mtu') + 1] == os.environ.get('PIA_TUN_MTU', '1500')
assert '--fast-io' in sys.argv
assert '--mssfix' not in sys.argv
assert (root / 'pia/auth.conf').stat().st_mode & 0o777 == 0o600
assert (root / 'pia/auth.conf').read_text() == os.environ['PIA_USERNAME'] + '\\n' + os.environ['PIA_PASSWORD'] + '\\n'
(root / 'vpn.pid').write_text(str(os.getpid()))
def stop(*args):
    (root / 'stopped').touch()
    sys.exit(0)
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
if os.environ['CASE'] == 'auth':
    print('AUTH_FAILED ' + os.environ['PIA_PASSWORD'], flush=True)
    sys.exit(1)
if os.environ['CASE'] != 'timeout': (root / 'ready').touch()
while True: time.sleep(.05)
''')
    env = dict(os.environ, PATH=str(bindir)+':'+os.environ['PATH'], ROOT=str(root), PIA_USERNAME='test-user', PIA_PASSWORD='secret.*[$]value', PIA_REGION='us_chicago', PIA_PROTOCOL='openvpn')
    for case in ['missing-user', 'missing-password', 'missing-region', 'empty-user', 'empty-password', 'empty-region', 'download', 'invalid-region', 'invalid-dns', 'invalid-mtu', 'auth', 'timeout', 'dns', 'success', 'signal']:
        resolv.write_text('nameserver 127.0.0.11\n')
        for path in ['ready', 'stopped', 'calls']:
            (root/path).unlink(missing_ok=True)
        current = dict(env, CASE=case)
        if case.startswith('missing-'):
            current.pop({'missing-user':'PIA_USERNAME','missing-password':'PIA_PASSWORD','missing-region':'PIA_REGION'}[case])
        if case.startswith('empty-'):
            current[{'empty-user':'PIA_USERNAME','empty-password':'PIA_PASSWORD','empty-region':'PIA_REGION'}[case]] = ''
        if case == 'invalid-region': current['PIA_REGION'] = '../escape'
        if case == 'invalid-dns': current['PIA_DNS_SERVER'] = '8.8.8.8'
        if case == 'invalid-mtu': current['PIA_TUN_MTU'] = '900'
        p = subprocess.Popen([str(root/'wrapper'), 'space argument', '*.literal'], env=current, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        if case == 'signal':
            deadline = time.monotonic()+5
            while not (root/'ready').exists() and time.monotonic()<deadline: time.sleep(.02)
            time.sleep(.1)
            p.terminate()
        output = p.communicate(timeout=10)[0]
        assert current['PIA_PASSWORD'] not in output if current.get('PIA_PASSWORD') else True, output
        assert 'APP:space argument:*.literal' in output, output
        assert p.returncode == (143 if case == 'signal' else 7), (case, p.returncode, output)
        if case.startswith(('missing-', 'empty-')):
            assert 'PIA VPN disabled' in output and not (root/'calls').exists(), output
        elif case in ['success', 'signal']:
            assert 'PIA VPN up: tun0 active' in output and (root/'stopped').exists(), output
        else:
            assert 'WARNING: PIA VPN failed to start' in output, output
            assert 'PIA VPN startup failed:' in output, output
            if case == 'download': assert 'failed to download' in output, output
            if case == 'invalid-region': assert 'PIA_REGION must be' in output, output
            if case == 'invalid-dns': assert 'PIA_DNS_SERVER must be' in output, output
            if case == 'invalid-mtu': assert 'PIA_TUN_MTU must be' in output, output
            if case in ['auth', 'timeout']: assert 'did not establish a tun0 default route' in output, output
            if case == 'dns': assert 'could not resolve discord.com through tun0' in output, output
        if case in ['auth', 'timeout', 'success', 'signal']:
            assert not (root/'pia/auth.conf').exists()
            assert 'route restore' in (root/'calls').read_text()
        if case in ['dns', 'success', 'signal']:
            calls = (root/'calls').read_text()
            assert 'priority 8000 to 10.0.0.243/32 table main' in calls
            assert resolv.read_text() == 'nameserver 127.0.0.11\n'
        print('PASS '+case)

    # WireGuard is the default transport. Its mocked success path exercises
    # token acquisition, region selection, ephemeral keys, routing and cleanup.
    for path in ['ready', 'stopped', 'calls']:
        (root/path).unlink(missing_ok=True)
    resolv.write_text('nameserver 127.0.0.11\n')
    current = dict(env, CASE='wireguard-success')
    current.pop('PIA_PROTOCOL')
    p = subprocess.run([str(root/'wrapper'), 'space argument', '*.literal'], env=current, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=10)
    assert p.returncode == 7, p.stdout
    assert 'PIA VPN up: pia active (WireGuard' in p.stdout, p.stdout
    assert 'APP:space argument:*.literal' in p.stdout, p.stdout
    calls = (root/'calls').read_text()
    assert 'wg genkey' in calls and 'wg set pia' in calls, calls
    assert '203.0.113.8/32 via 172.17.0.1 dev eth0' in calls, calls
    assert 'route restore' in calls and 'link delete pia' in calls, calls
    assert resolv.read_text() == 'nameserver 127.0.0.11\n'
    print('PASS wireguard-success')
