#!/usr/bin/env bash
# A network lab on one Linux host (root; iproute2, iptables, coturn): two sites, each behind its own NAT
# router, on a shared "internet" where a TURN server and the app are reachable. The sites cannot reach each
# other except through their NATs, as two homes or offices would.
#
#   siteA (10.1.0.2) ─ natA [10.1.0.1 | 198.51.100.2] ─┐
#                                                      ├─ inet: 198.51.100.0/24  TURN/STUN 198.51.100.10:3478
#   siteB (10.2.0.2) ─ natB [10.2.0.1 | 198.51.100.3] ─┘        app 198.51.100.20:3000 → host 127.0.0.1:3000
#
#   lab.sh up <fullcone|cone|symmetric> [udp-blocked]   # NAT behaviour of both routers; udp-blocked: site B allows only TCP out
#   lab.sh down
# NAT: "fullcone" maps and filters independently of the remote endpoint (RFC 4787 EIM/EIF): direct works.
# "cone" is plain Linux MASQUERADE: port-preserving, but conntrack filters by remote address and port, and a
# peer's packet arriving before the site's own first packet takes the mapping (hole punching often fails).
# "symmetric" adds --random-fully (a new port per destination: only a relay connects).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
STATE=/tmp/meetings-netlab
TURN_SECRET="${TURN_SHARED_SECRET:-netlab-shared-secret}"

down() {
  [ -f $STATE/turn.pid ] && kill "$(cat $STATE/turn.pid)" 2>/dev/null || true
  for f in fwd fwdA fwdB; do [ -f $STATE/$f.pid ] && kill "$(cat $STATE/$f.pid)" 2>/dev/null || true; done
  for ns in siteA siteB natA natB inet; do ip netns del $ns 2>/dev/null || true; done
  ip link del veth-host 2>/dev/null || true
  rm -rf $STATE
}

up() {
  local nat="$1" block="${2:-}"
  down; mkdir -p $STATE
  for ns in inet natA natB siteA siteB; do ip netns add $ns; ip -n $ns link set lo up; done
  # The internet: one bridge.
  ip -n inet link add br0 type bridge; ip -n inet link set br0 up
  ip -n inet addr add 198.51.100.1/24 dev br0
  ip -n inet addr add 198.51.100.10/24 dev br0   # TURN/STUN
  ip -n inet addr add 198.51.100.20/24 dev br0   # the app
  # Two sites, each behind a NAT router.
  for s in A B; do
    local n=$([ $s = A ] && echo 1 || echo 2) wan=$([ $s = A ] && echo 2 || echo 3)
    ip link add wan$s netns nat$s type veth peer name port$s netns inet
    ip -n inet link set port$s master br0; ip -n inet link set port$s up
    ip -n nat$s addr add 198.51.100.$wan/24 dev wan$s; ip -n nat$s link set wan$s up
    ip link add lan$s netns nat$s type veth peer name eth0 netns site$s
    ip -n nat$s addr add 10.$n.0.1/24 dev lan$s; ip -n nat$s link set lan$s up
    ip -n site$s addr add 10.$n.0.2/24 dev eth0; ip -n site$s link set eth0 up
    ip -n site$s route add default via 10.$n.0.1
    ip netns exec nat$s sysctl -qw net.ipv4.ip_forward=1
    if [ "$nat" = symmetric ]; then
      ip netns exec nat$s iptables -t nat -A POSTROUTING -o wan$s -j MASQUERADE --random-fully
    else
      ip netns exec nat$s iptables -t nat -A POSTROUTING -o wan$s -j MASQUERADE
    fi
    if [ "$nat" = fullcone ]; then
      # Endpoint-independent mapping and filtering (RFC 4787 "full cone"): any UDP to the router's public
      # address reaches the site's host on the same port, so a mapping learned by STUN works for every peer.
      ip netns exec nat$s iptables -t nat -A PREROUTING -i wan$s -p udp --dport 1024:65535 -j DNAT --to-destination 10.$n.0.2
      ip netns exec nat$s iptables -A FORWARD -i wan$s -p udp -d 10.$n.0.2 -j ACCEPT
    fi
    # Nothing enters a site unless it answers something the site sent (stateful NAT/firewall).
    ip netns exec nat$s iptables -A FORWARD -i wan$s -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    ip netns exec nat$s iptables -A FORWARD -i wan$s -j DROP
  done
  if [ "$block" = udp-blocked ]; then
    # Site B's firewall: only TCP to the app and to TURN; no UDP at all.
    ip netns exec natB iptables -I FORWARD 1 -i lanB -p udp -j DROP
  fi
  # The app: the host's 127.0.0.1:3000, reached from the internet at 198.51.100.20:3000.
  ip link add veth-host type veth peer name veth-inet netns inet
  ip addr add 192.168.250.1/30 dev veth-host; ip link set veth-host up
  ip -n inet addr add 192.168.250.2/30 dev veth-inet; ip -n inet link set veth-inet up
  ip netns exec inet sysctl -qw net.ipv4.ip_forward=1
  ip netns exec inet iptables -t nat -A PREROUTING -d 198.51.100.20 -p tcp --dport 3000 -j DNAT --to-destination 192.168.250.1:3000
  ip netns exec inet iptables -t nat -A POSTROUTING -o veth-inet -j MASQUERADE
  node "$HERE/forward.mjs" 192.168.250.1 3000 127.0.0.1 3000 > $STATE/fwd.log 2>&1 & echo $! > $STATE/fwd.pid
  # FeltKit's development server answers only requests addressed to localhost (DNS-rebinding guard). Each
  # site reaches the app as http://localhost:3000 through a forwarder on its own loopback, so every request
  # still leaves the site through its NAT, and the page is a secure context (camera, microphone).
  for s in A B; do
    ip netns exec site$s node "$HERE/forward.mjs" 127.0.0.1 3000 198.51.100.20 3000 > $STATE/fwd$s.log 2>&1 & echo $! > $STATE/fwd$s.pid
  done
  # TURN/STUN (coturn) on the internet, with time-limited REST credentials.
  cat > $STATE/turnserver.conf <<CONF
listening-ip=198.51.100.10
relay-ip=198.51.100.10
listening-port=3478
min-port=49160
max-port=49999
use-auth-secret
static-auth-secret=$TURN_SECRET
realm=meetings.netlab
no-tls
no-dtls
no-cli
fingerprint
allowed-peer-ip=198.51.100.0-198.51.100.255
log-file=$STATE/turn.log
simple-log
verbose
CONF
  ip netns exec inet turnserver -c $STATE/turnserver.conf > /dev/null 2>&1 & echo $! > $STATE/turn.pid
  sleep 1
  echo "lab up: nat=$nat ${block:-}"
}

case "${1:-}" in
  up) up "${2:-cone}" "${3:-}" ;;
  down) down; echo "lab down" ;;
  *) echo "usage: lab.sh up <cone|symmetric> [udp-blocked] | down" >&2; exit 2 ;;
esac
