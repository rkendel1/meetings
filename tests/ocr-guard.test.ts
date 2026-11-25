/**
 * Browser OCR must never block sending an observation: a missing engine fails fast with a clear message, and a hung
 * one is cut off by a deadline, so the capture is sent without OCR (src/Observe.tsx) instead of the dialog freezing.
 * Reported on the live deployment: /ocr/worker.min.js was 404 (public/ocr was not built) and Send never finished.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkOcrAssets, OCR_ASSETS, withDeadline } from "../src/ocr-guard";

const served = (statusFor: (url: string) => number, type = "application/octet-stream") =>
  (async (url: string) => new Response(null, { status: statusFor(String(url)), headers: { "content-type": type } })) as unknown as typeof fetch;

test("OCR files that are all served pass the check", async () => {
  await checkOcrAssets("https://app.test/ocr", served(() => 200));
});

test("missing OCR files are reported at once, by name, instead of hanging", async () => {
  const started = Date.now();
  await assert.rejects(
    checkOcrAssets("https://app.test/ocr", served(() => 404)),
    (e: Error) => OCR_ASSETS.every((name) => e.message.includes(name)) && /404/.test(e.message) && /not available/.test(e.message),
  );
  assert.ok(Date.now() - started < 1000);
});

test("only the missing file is named when the others are served", async () => {
  await assert.rejects(
    checkOcrAssets("https://app.test/ocr", served((url) => (url.endsWith("/worker.min.js") ? 404 : 200))),
    (e: Error) => e.message.includes("worker.min.js") && !e.message.includes("eng.traineddata.gz"),
  );
});

test("an HTML fallback page is not mistaken for an OCR file", async () => {
  await assert.rejects(checkOcrAssets("https://app.test/ocr", served(() => 200, "text/html; charset=utf-8")), /HTML page/);
});

test("a server that does not answer is cut off after the timeout", async () => {
  const hang = ((_url: string, init?: RequestInit) => new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch;
  await assert.rejects(checkOcrAssets("https://app.test/ocr", hang, 50), /no answer within/);
});

test("a step that never settles is rejected by its deadline, and told to stop", async () => {
  let stopped = false;
  await assert.rejects(
    withDeadline(new Promise<string>(() => {}), 50, "Starting the OCR engine", () => (stopped = true)),
    /Starting the OCR engine did not finish/,
  );
  assert.equal(stopped, true);
});

test("a step that settles in time keeps its own result or error", async () => {
  assert.equal(await withDeadline(Promise.resolve("tsv"), 1000, "Reading the text"), "tsv");
  await assert.rejects(withDeadline(Promise.reject(new Error("no reading")), 1000, "Reading the text"), /no reading/);
});
