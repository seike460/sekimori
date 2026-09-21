import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["packages/*/src/**/types.ts"],
      reporter: ["text", "json-summary"],
      // 公開品質の下限。coverage が下がったら CI で検知できるよう閾値を設ける。
      thresholds: { statements: 80, branches: 75, functions: 80, lines: 80 },
    },
    projects: [
      {
        resolve: {
          // workspace 内の import は src へ向ける（テストが build 順序に依存しないため）。
          // 文字列 alias は前方一致で `sekimori/tracer` を `index.ts/tracer` に解決してしまうため、
          // bare と subpath を正規表現で分ける。
          alias: [
            // `@sekimori/*` workspace パッケージも dist ではなく src へ向ける —
            // `pnpm install` 直後の `pnpm test`（build 前）でも cli suite が解決できる。
            {
              find: /^@sekimori\/(codemod|doctor)$/,
              replacement: `${fileURLToPath(new URL("./packages", import.meta.url))}/$1/src/index.ts`,
            },
            // 公開 subpath と src のファイル名が対応しないものを先に明示する
            // （`./xray` は xray-header.ts、`./package.json` はパッケージ直下）。
            {
              find: /^sekimori\/xray$/,
              replacement: fileURLToPath(
                new URL("./packages/sekimori/src/xray-header.ts", import.meta.url),
              ),
            },
            {
              find: /^sekimori\/package\.json$/,
              replacement: fileURLToPath(
                new URL("./packages/sekimori/package.json", import.meta.url),
              ),
            },
            {
              // exports map にある公開 subpath だけを解決する（`sekimori/carriers` のような
              // 未公開 subpath がローカルで通って consumer で壊れるのを防ぐ）。
              find: /^sekimori\/(apigw|dynamodb|eventbridge|kinesis|semconv|sfn|sns|sqs|tracer)$/,
              replacement: `${fileURLToPath(new URL("./packages/sekimori/src", import.meta.url))}/$1.ts`,
            },
            {
              find: /^sekimori$/,
              replacement: fileURLToPath(
                new URL("./packages/sekimori/src/index.ts", import.meta.url),
              ),
            },
          ],
        },
        test: {
          name: "unit",
          include: ["packages/*/test/**/*.test.ts", "probe/cdk/**/*.test.ts"],
          exclude: ["**/*.integration.test.ts", "**/node_modules/**"],
          environment: "node",
        },
      },
      {
        // 実 AWS に対する接続性テスト (probe)。AWS 資格情報と deploy 済み stack が前提。
        test: {
          name: "integration",
          include: ["probe/**/*.integration.test.ts"],
          environment: "node",
          // assert.ts は Transaction Search に最大 15 分 + X-Ray fallback にさらに 15 分かかり得る。
          // 両方の deadline + 呼び出し/ポーリングの余裕を見て 35 分にする。
          testTimeout: 2_100_000,
        },
      },
    ],
  },
});
