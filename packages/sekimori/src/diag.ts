/**
 * OTel `diag` の安全な wrapper — `@opentelemetry/api` は登録済み logger の例外を
 * 捕捉しないため、logger が投げると diag 呼び出しが保護 catch を突き抜けて
 * 呼び出し側の結果・元の例外を上書きする。診断ログは best-effort とする。
 */
import { diag } from "@opentelemetry/api";

/** `diag.warn` を logger の例外を飲み込んで呼ぶ。診断の失敗は業務処理へ伝播させない。 */
export function diagWarn(message: string, error: unknown): void {
  try {
    diag.warn(message, error);
  } catch {
    // 診断 logger 自体の失敗は黙って捨てる — ここで投げると守ろうとした
    // 結果・元の例外・span 終了処理を壊す。
  }
}
