/**
 * Guards around browser OCR (src/ocr.ts), kept free of tesseract.js so they can be tested in Node.
 *
 * OCR is optional: an observation is sent without it when the engine cannot run. For that to work the engine must
 * fail fast. tesseract.js never settles when its worker script is missing (the 404 is swallowed inside a Web Worker),
 * so a missing file is checked for before the worker is started, and every step has a deadline.
 */

/** The files the engine loads from this application (public/ocr, filled by scripts/vendor-ocr.mjs). */
export const OCR_ASSETS = ["worker.min.js", "eng.traineddata.gz", "tesseract-core-lstm.wasm.js"] as const;

/** Rejects with `what` if `work` has not settled after `ms`; `onTimeout` runs then (to stop what is still running). */
export function withDeadline<T>(work: Promise<T>, ms: number, what: string, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        onTimeout?.();
      } finally {
        reject(new Error(`${what} did not finish within ${Math.round(ms / 1000)} s.`));
      }
    }, ms);
    work.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e)),
    );
  });
}

/** Whether each OCR file is served (not missing, not an HTML fallback page). Rejects at once, naming what is missing. */
export async function checkOcrAssets(base: string, fetchFn: typeof fetch = fetch, timeoutMs = 8000): Promise<void> {
  const problems = (
    await Promise.all(
      OCR_ASSETS.map(async (name) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await fetchFn(`${base}/${name}`, { method: "HEAD", signal: controller.signal });
          if (!res.ok) return `${name} (HTTP ${res.status})`;
          if ((res.headers.get("content-type") ?? "").includes("text/html")) return `${name} (an HTML page, not the file)`;
          return null;
        } catch (e) {
          return `${name} (${controller.signal.aborted ? `no answer within ${Math.round(timeoutMs / 1000)} s` : String((e as Error)?.message ?? e)})`;
        } finally {
          clearTimeout(timer);
        }
      }),
    )
  ).filter((p): p is string => p !== null);
  if (problems.length) throw new Error(`the OCR engine files are not available on this server: ${problems.join(", ")}.`);
}
