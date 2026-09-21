import { defineConfig } from "tsdown";

// DEC-004: runtime package は ESM + CJS の両出力。AWS は Application Signals で CJS bundle を推奨し、
// ADOT の ESM 経路はまだ experimental。CLI 系 package は ESM のみ。
export default defineConfig({
  entry: {
    index: "src/index.ts",
    apigw: "src/apigw.ts",
    dynamodb: "src/dynamodb.ts",
    eventbridge: "src/eventbridge.ts",
    kinesis: "src/kinesis.ts",
    sfn: "src/sfn.ts",
    sns: "src/sns.ts",
    sqs: "src/sqs.ts",
    // semconv は依存を持たない leaf。doctor 等が OTel API を引き回さずに定数だけ使えるよう公開する。
    semconv: "src/semconv.ts",
    tracer: "src/tracer.ts",
    xray: "src/xray-header.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  outDir: "dist",
  sourcemap: true,
  outExtensions: ({ format }) =>
    format === "cjs" ? { js: ".cjs", dts: ".d.cts" } : { js: ".js", dts: ".d.ts" },
});
