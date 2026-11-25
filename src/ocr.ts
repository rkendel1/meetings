/**
 * Browser OCR for observations: Tesseract compiled to WebAssembly (tesseract.js), run on this device, its worker, core
 * and English LSTM data served by this application (public/ocr, scripts/vendor-ocr.mjs; no CDN). It returns the raw
 * reading; xeet turns it into a separate artifact derived from the original capture (annotate_ocr), every recognized
 * line marked inferred and attributed to this engine. It reads only pixels: it is not the accessibility tree xeet's
 * macOS app records, and is never presented as one.
 */
import { createWorker, PSM } from "tesseract.js";

/** The Tesseract build inside tesseract.js-core 7.0.0 (checked against the shipped core by scripts/vendor-ocr.mjs). */
export const ENGINE = {
  name: "tesseract",
  version: "5.1.0-288-g2a9c1",
  languages: ["eng"],
  config: { psm: "3 (auto page segmentation, as native xeet-ocr)", oem: "1 (LSTM)", traineddata: "@tesseract.js-data/eng 4.0.0_best_int", runtime: "tesseract.js 7.0.0, tesseract.js-core 7.0.0" },
  formats: ["image/png"],
  platform: "wasm",
  unsupported: ["orientation detection (page segmentation mode 3 assumes upright text)", "handwriting", "accessibility tree (pixels only)"],
};

/** Tesseract's TSV reading of a PNG, recognized in the browser. */
export async function readText(png: Blob): Promise<string> {
  const base = `${location.origin}/ocr`;
  const worker = await createWorker("eng", 1, { workerPath: `${base}/worker.min.js`, corePath: base, langPath: base, gzip: true, workerBlobURL: false });
  try {
    await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
    const { data } = await worker.recognize(png, {}, { tsv: true });
    if (typeof data.tsv !== "string" || !data.tsv.trim()) throw new Error("The OCR engine returned no reading.");
    return data.tsv;
  } finally {
    await worker.terminate();
  }
}
