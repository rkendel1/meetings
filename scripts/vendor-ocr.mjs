// Serves in-browser OCR from this application: copies tesseract.js's worker, its WebAssembly core and the English
// LSTM data from the pinned npm packages into public/ocr (git-ignored; run before dev and build). No CDN at run time.
// Checks the engine version the derived artifacts name (src/ocr.ts) against the core it ships.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const ENGINE_VERSION = "5.1.0-288-g2a9c1";
const root = new URL("..", import.meta.url).pathname;
const out = join(root, "public", "ocr");
mkdirSync(out, { recursive: true });
const mod = (p) => join(root, "node_modules", p);
cpSync(mod("tesseract.js/dist/worker.min.js"), join(out, "worker.min.js"));
for (const f of readdirSync(mod("tesseract.js-core"))) if (/^tesseract-core.*-lstm\.wasm\.js$/.test(f)) cpSync(mod(`tesseract.js-core/${f}`), join(out, f));
cpSync(mod("@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz"), join(out, "eng.traineddata.gz"));
const core = readFileSync(mod("tesseract.js-core/tesseract-core-lstm.wasm"));
if (!core.includes(Buffer.from(ENGINE_VERSION))) {
  console.error(`vendor-ocr: tesseract.js-core no longer reports Tesseract ${ENGINE_VERSION}; update ENGINE_VERSION here and in src/ocr.ts.`);
  process.exit(1);
}
if (!existsSync(join(out, "eng.traineddata.gz"))) process.exit(1);
console.log(`vendor-ocr: public/ocr ready (Tesseract ${ENGINE_VERSION}, tesseract.js-core ${JSON.parse(readFileSync(mod("tesseract.js-core/package.json"), "utf8")).version})`);
