import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// @inco/js + viem expect a few Node globals/polyfills in the browser.
export default defineConfig({
  resolve: {
    alias: {
      "fs/promises": "node-stdlib-browser/mock/empty",
      "node:fs/promises": "node-stdlib-browser/mock/empty",
    },
  },
  plugins: [nodePolyfills({ globals: { Buffer: true, global: true, process: true } })],
  optimizeDeps: { esbuildOptions: { target: "es2020" } },
});
