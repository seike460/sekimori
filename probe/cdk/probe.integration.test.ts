import { describe, it } from "vitest";

// 実 AWS に deploy 済みの probe stack が前提。`SEKIMORI_PROBE=1` のときだけ動く。
describe.skipIf(!process.env.SEKIMORI_PROBE)("sekimori probe (real AWS)", () => {
  it("emitter -> EventBridge -> SQS -> consumer is linked", async () => {
    const { execFileSync } = await import("node:child_process");
    execFileSync("pnpm", ["run", "assert"], {
      stdio: "inherit",
      cwd: new URL(".", import.meta.url),
      // vitest の testTimeout は sync exec を中断できない — process 側でも締める
      // （assert 本体の最悪値: Transaction Search 15 分 + X-Ray fallback 15 分 + invoke/余裕）。
      timeout: 35 * 60_000,
    });
  });
});
