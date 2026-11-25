import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * public/ocr is git-ignored and filled by scripts/vendor-ocr.mjs. npm's predev/prebuild hooks run it, but a build that
 * does not go through npm (`npx feltkit fly deploy`) skips them and would ship without the OCR engine. Running it
 * here, in the build itself, makes every build fill public/ocr first, and fail loudly if it cannot.
 */
function vendorOcr(): Plugin {
  return {
    name: "vendor-ocr",
    apply: "build",
    buildStart() {
      execFileSync(process.execPath, [fileURLToPath(new URL("./scripts/vendor-ocr.mjs", import.meta.url))], { stdio: "inherit" });
    },
  };
}

export default defineConfig({
  plugins: [react(), vendorOcr()],
});
