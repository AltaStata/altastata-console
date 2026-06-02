import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { writeFileSync } from "node:fs";
import path from "node:path";

import pkg from "./package.json" with { type: "json" };

// Emits dist/VERSION at the end of every production build, so the bundle is
// self-identifying once it ships inside altastata-python-package. The file is
// a single text line ("0.2.0\n") to keep parsing trivial from bash, Java, or
// Python without pulling in JSON.
function writeVersionFile(): Plugin {
  return {
    name: "altastata-write-version-file",
    apply: "build",
    closeBundle() {
      const versionPath = path.resolve(__dirname, "dist", "VERSION");
      writeFileSync(versionPath, `${pkg.version}\n`, "utf8");
    },
  };
}

export default defineConfig({
  plugins: [react(), writeVersionFile()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
