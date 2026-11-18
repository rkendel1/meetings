// Development stand-in for a TURN provider's credential API, in front of a local coturn configured with
// `use-auth-secret` / `static-auth-secret`. Same request and response shape as Cloudflare Realtime TURN:
//   POST /v1/turn/keys/<key>/credentials/generate-ice-servers   { "ttl": 3600 }
//   Authorization: Bearer <TURN_API_TOKEN>
//   → { "iceServers": [{ "urls": [...], "username": "<expiry>:<key>", "credential": "<HMAC-SHA1>" }] }
// Credentials follow coturn's REST convention (draft-uberti-behave-turn-rest): username = expiry:key,
// credential = base64(HMAC-SHA1(shared secret, username)). coturn checks both, and the expiry.
//
// Env: TURN_API_TOKEN, TURN_SHARED_SECRET (coturn's static-auth-secret), TURN_URLS (comma separated),
//      TURN_API_PORT (default 4790), TURN_API_HOST (default 127.0.0.1).
import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";

const token = process.env.TURN_API_TOKEN;
const secret = process.env.TURN_SHARED_SECRET;
const urls = (process.env.TURN_URLS ?? "turn:127.0.0.1:3478?transport=udp,turn:127.0.0.1:3478?transport=tcp").split(",");
if (!token || !secret) throw new Error("Set TURN_API_TOKEN and TURN_SHARED_SECRET.");

const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
createServer((req, res) => {
  const m = req.url?.match(/^\/v1\/turn\/keys\/([\w-]+)\/credentials\/generate-ice-servers$/);
  if (req.method !== "POST" || !m) return res.writeHead(404).end();
  if (!same(req.headers.authorization ?? "", `Bearer ${token}`)) return res.writeHead(401).end();
  let body = "";
  req.on("data", (c) => (body += c)).on("end", () => {
    let ttl;
    try {
      ttl = JSON.parse(body || "{}").ttl;
    } catch {
      return res.writeHead(400).end();
    }
    if (!Number.isInteger(ttl) || ttl < 60 || ttl > 86400) return res.writeHead(400).end();
    const username = `${Math.floor(Date.now() / 1000) + ttl}:${m[1]}`;
    const credential = createHmac("sha1", secret).update(username).digest("base64");
    res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ iceServers: [{ urls, username, credential }] }));
  });
}).listen(Number(process.env.TURN_API_PORT ?? 4790), process.env.TURN_API_HOST ?? "127.0.0.1", () => console.log(`TURN credential API on ${process.env.TURN_API_HOST ?? "127.0.0.1"}:${process.env.TURN_API_PORT ?? 4790} (urls: ${urls.join(", ")})`));
