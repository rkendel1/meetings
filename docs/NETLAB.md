# Network lab: calls between two NATed sites on one Linux host

**What this proves:** the application's real code (signaling, ICE configuration issued by `media:iceServers`,
TURN credentials from the provider integration) establishes media between two browsers that can reach each
other only through NAT routers, an emulated internet and a TURN server, for the NAT behaviours listed.
**What it does not prove:** interoperability on real networks, with real routers, mobile carriers, corporate
firewalls, other browsers, other TURN providers, or across independent devices. Everything runs on one host;
the "internet" is a Linux bridge with no latency, loss or MTU limits.

## Prerequisites

- Linux, root (network namespaces, iptables), `iproute2`, `iptables` (nf_tables backend tested), `coturn`,
  `tcpdump`/`conntrack` (only for diagnosis), Node 20+, Playwright's Chromium (`require('playwright')`).
- The app's dev server, with the TURN provider credential the lab's stand-in expects:

  ```bash
  FELTKIT_CREDENTIAL_TURN=netlab-token npm run dev
  ```

Tested with: Linux 6.18.44, iptables 1.8.10 (nf_tables), coturn 4.6.1, Node 22.23.5, Playwright 1.63.0,
Chrome for Testing 153.0.8010.12; meetings `ba1484b` + this document's commit; FeltKit: see "Results".

## Topology (`scripts/netlab/lab.sh`)

```
siteA 10.1.0.2 ── natA [lanA 10.1.0.1 | wanA 198.51.100.2] ──┐
                                                             ├── inet: bridge 198.51.100.0/24
siteB 10.2.0.2 ── natB [lanB 10.2.0.1 | wanB 198.51.100.3] ──┘     coturn (STUN+TURN) 198.51.100.10:3478 udp+tcp
                                                                   app 198.51.100.20:3000 → host 127.0.0.1:3000
```

- Each site reaches the app as `http://localhost:3000` through a TCP forwarder on its own loopback (FeltKit's
  dev server answers only `localhost`, a DNS-rebinding guard); every request still crosses the site's NAT.
- NAT routers: `MASQUERADE` out of `wanX`; `FORWARD` from `wanX` accepts only `ESTABLISHED,RELATED`.
  - `fullcone`: plus `PREROUTING -i wanX -p udp --dport 1024:65535 -j DNAT --to 10.X.0.2` and a matching
    `FORWARD` accept: endpoint-independent mapping and filtering (RFC 4787 "full cone").
  - `cone`: plain Linux MASQUERADE (port-preserving; conntrack filters by remote address and port).
  - `symmetric`: `MASQUERADE --random-fully` (a new port per destination).
  - `udp-blocked`: natB also drops every UDP packet from lanB (only TCP leaves site B).
- coturn: `use-auth-secret`, `static-auth-secret=netlab-shared-secret`, `realm=meetings.netlab`, relay ports
  49160–49999, `allowed-peer-ip=198.51.100.0-198.51.100.255`, no TLS/DTLS.
- TURN credentials: the app calls its `turn` integration (`TURN_API_URL` default in development:
  `http://127.0.0.1:4790/v1/turn/keys/dev`, token `credential-ref:turn`); `scripts/turn-api-dev.mjs` answers in
  the Cloudflare Realtime shape with coturn REST credentials (`<expiry>:<key>`, HMAC-SHA1). `run.sh` starts it
  per scenario with the ICE URLs that scenario needs.
- Browsers run inside `siteA`/`siteB` (`ip netns exec`), with `--no-proxy-server` and the host's proxy
  variables unset (Chrome otherwise sends TURN-over-TCP through the host's HTTPS proxy, unreachable from a site).

## Commands

```bash
sudo scripts/netlab/run.sh            # every scenario
```

```bash
sudo scripts/netlab/run.sh 4 5        # only scenarios 4 and 5
```

```bash
RUNS=3 sudo -E scripts/netlab/run.sh  # repeat each scenario
```

```bash
sudo scripts/netlab/lab.sh up symmetric udp-blocked   # just the network, for manual tests
```

```bash
node scripts/netlab/cross-network.mjs "my scenario"    # one call across the lab as it is
```

```bash
sudo scripts/netlab/lab.sh down
```

Each scenario line reports PASS/FAIL/OPEN against its expectation, the selected candidate pair on both sides,
the decoded video width both ways, and on failure each side's candidates and pair states.

## Scenarios, expectations and results

Results: 2026-11-18, `RUNS=2`, app on the local build of rkendel1/feltkit `ce0603f` (session-bound presence),
and before that on published 0.3.32 (same outcomes).

| # | Network | ICE servers | Expected | Result | Classification |
|---|---|---|---|---|---|
| 1 | full-cone NATs | provider STUN | direct | ✅ 2/2 srflx↔srflx, ~0.59 s, video both ways | works |
| 2 | Linux MASQUERADE NATs | provider STUN | none | ✅ 2/2 no connection, as expected | network behaviour (finding 1) |
| 3 | symmetric NATs | provider STUN | none | ✅ 2/2 no connection, as expected | network behaviour |
| 4 | symmetric NATs | provider STUN + TURN udp/tcp | relay | ✅ 2/2 relay/udp ↔ prflx, ~0.54 s, video both ways | works |
| 5 | symmetric NATs, all UDP blocked at site B | provider STUN + TURN udp/tcp | relay over TCP | ⚠ OPEN 2/2: no connection | **unresolved**; reproduces without the app (finding 3) |

Findings:

1. **Plain Linux MASQUERADE defeats hole punching** when a peer's first packet reaches the router before the
   site's own first packet: conntrack takes the mapping and the site's outbound packets leave on another port
   (shown with tcpdump and `conntrack -L`). Network behaviour, not application behaviour; it means TURN is
   needed more often than "cone NAT" suggests.
2. **An unresolvable third-party STUN hostname in the ICE list broke relay connectivity** in Chrome (0/3 with
   `stun:stun.l.google.com` included, 5/5 without, scenario 4). The app now issues only the provider's servers
   when a provider is configured. The Chrome-internal mechanism was not determined (a bare two-browser harness
   with the same list connected). Classification: browser-specific behaviour, mitigated in the app.
3. **TURN over TCP with UDP fully blocked:** Chrome gathers the TCP relay candidate (`relay … relayProtocol tcp`,
   ~90 ms) but forms no candidate pairs with it; this reproduces with a bare two-browser `RTCPeerConnection`
   and no application code. Not the application's code or configuration as far as tested; browser- or
   coturn-configuration-specific, unresolved. Next step: TURNS on 443 with a production provider, and another
   browser.
4. Lab artefact, removed: Chrome routed TURN-over-TCP through the host's configured HTTPS proxy
   (`ERR_PROXY_CONNECTION_FAILED`).

## What another engineer should not conclude

- That calls work across real networks: run the same app on a public deployment with browsers on separate
  networks (home broadband, mobile, a corporate network) to establish that.
- That relay-over-TCP works or fails in production: scenario 5 is open.
- Latency or quality: the emulated internet has none of a real one's impairments.
