// A plain TCP forwarder: node forward.mjs <listen-host> <listen-port> <target-host> <target-port>
import { createServer, connect } from "node:net";
const [lh, lp, th, tp] = process.argv.slice(2);
createServer((a) => {
  const b = connect(Number(tp), th);
  a.pipe(b).pipe(a);
  a.on("error", () => b.destroy());
  b.on("error", () => a.destroy());
}).listen(Number(lp), lh, () => console.log(`forwarding ${lh}:${lp} → ${th}:${tp}`));
