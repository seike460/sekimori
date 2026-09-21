import { defineConfig } from "tsdown";

// DEC-004: CLI 系 package は ESM のみ。
export default defineConfig({
  entry: { index: "src/index.ts" },
  format: "esm",
  dts: true,
  clean: true,
  outDir: "dist",
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
});
