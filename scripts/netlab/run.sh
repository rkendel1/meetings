#!/usr/bin/env bash
# Cross-network call scenarios (scripts/netlab/lab.sh), each with its expected outcome. Needs root,
# iproute2, iptables, coturn, Playwright's Chromium, and the app's dev server started with the TURN
# provider's credential:   FELTKIT_CREDENTIAL_TURN=netlab-token npm run dev
# It runs the TURN provider stand-in (scripts/turn-api-dev.mjs) itself. RUNS=n repeats each scenario.
#   run.sh          every scenario          run.sh 4 5      only scenarios 4 and 5
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
RUNS="${RUNS:-1}"
STUN="stun:198.51.100.10:3478"
TURN="turn:198.51.100.10:3478?transport=udp,turn:198.51.100.10:3478?transport=tcp"
api_pid=""
provider() { # the ICE URLs the provider hands out; waits until it answers with exactly them
  [ -n "$api_pid" ] && kill $api_pid 2>/dev/null; pkill -f turn-api-dev.mjs 2>/dev/null; sleep 0.5
  TURN_API_TOKEN=netlab-token TURN_SHARED_SECRET=netlab-shared-secret TURN_URLS="$1" node "$HERE/../turn-api-dev.mjs" > /tmp/meetings-turn-api.log 2>&1 &
  api_pid=$!
  for _ in $(seq 1 50); do
    curl -s -X POST http://127.0.0.1:4790/v1/turn/keys/x/credentials/generate-ice-servers -H "authorization: Bearer netlab-token" -d '{"ttl":600}' 2>/dev/null | grep -qF "\"${1%%,*}\"" && return 0
    sleep 0.1
  done
  echo "TURN provider stand-in did not start: $(cat /tmp/meetings-turn-api.log)" >&2; exit 3
}
fails=0
open=0
ONLY=" $* "
scenario() { # name nat block urls expect(direct|relay|relay-tcp|none) [open: a known, unresolved limitation]
  if [ "$ONLY" != "  " ] && [[ "$ONLY" != *" ${1%% *} "* ]]; then return; fi
  provider "$4"
  for i in $(seq 1 "$RUNS"); do
    "$HERE/lab.sh" up "$2" "$3" > /dev/null
    local json; json="$(CONNECT_TIMEOUT_MS=30000 node "$HERE/cross-network.mjs" "$1")"
    local verdict; verdict="$(node -e '
      const j = JSON.parse(process.argv[1]), expect = process.argv[2];
      const path = j.connected ? Object.values(j.paths.ada)[0] ?? "" : "";
      const video = j.connected && j.video?.adaSeesGrace > 0 && j.video?.graceSeesAda > 0;
      const got = !j.connected ? "none" : path.startsWith("relay") || /→relay/.test(path) ? (/relay over tcp/.test(Object.values(j.paths.grace)[0] + path) ? "relay-tcp" : "relay") : "direct";
      const ok = got === expect && (expect === "none" || video);
      console.log(`${ok ? "PASS" : "FAIL"} expected=${expect} got=${got} relayIssued=${j.relayOffered} ${j.connected ? `in ${j.connectMs} ms, ada ${path}, grace ${Object.values(j.paths.grace)[0]}, video ${j.video.adaSeesGrace}/${j.video.graceSeesAda}` : JSON.stringify(j.states)}`);
    ' "$json" "$5")"
    if [[ "$verdict" != PASS* && "${6:-}" == open ]]; then verdict="OPEN ${verdict#FAIL }"; open=$((open + 1));
    elif [[ "$verdict" != PASS* ]]; then fails=$((fails + 1)); fi
    echo "$1 [$i/$RUNS]: $verdict"
  done
}
scenario "1 full-cone NATs (EIM/EIF), STUN only"            fullcone  ""          "$STUN"       direct
scenario "2 Linux MASQUERADE NATs, STUN only"               cone      ""          "$STUN"       none
scenario "3 symmetric NATs, STUN only"                      symmetric ""          "$STUN"       none
scenario "4 symmetric NATs, TURN"                           symmetric ""          "$STUN,$TURN" relay
# Open: with every UDP packet blocked at one site, Chrome gathers a TURN-over-TCP relay candidate there but
# forms no candidate pairs with it, in this app and in a bare two-browser RTCPeerConnection alike (AUDIT.md).
scenario "5 symmetric NATs, site B blocks all UDP, TURN"    symmetric udp-blocked "$STUN,$TURN" relay-tcp open
kill $api_pid 2>/dev/null
"$HERE/lab.sh" down > /dev/null
echo "failures: $fails, open: $open"
exit $fails
