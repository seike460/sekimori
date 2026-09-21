/** CLI 引数 parse の純粋関数層 — `tryParse` が結果を返し、副作用は呼び出し側に置く。 */
import { parseArgs } from "node:util";

type Options = NonNullable<Parameters<typeof parseArgs>[0]>["options"];

/**
 * 未知の flag / 型違反を parse 失敗として返す純粋関数。例外は握り潰さず
 * message へ変換する。usage の描画は呼び出し側の責務。
 */
export function tryParse<const O extends Options>(args: string[], options: O) {
  try {
    return { ok: true as const, parsed: parseArgs({ args, allowPositionals: true, options }) };
  } catch (error) {
    return { ok: false as const, message: error instanceof Error ? error.message : String(error) };
  }
}

/** コマンドの実行中エラーを stderr の1行 + exit code 2 に正規化する。 */
export function failWith(message: string, prefix: string): number {
  process.stderr.write(`${prefix}: ${message}\n`);
  return 2;
}
