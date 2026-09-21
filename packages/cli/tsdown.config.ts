import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { index: "src/index.ts", bin: "src/bin.ts" },
  format: "esm",
  dts: true,
  clean: true,
  outDir: "dist",
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
});
