/**
 * 変換 pass が共有するコンテキスト型（EmitCtx）と finding 報告の小ヘルパー。
 * 「何を報告するか」の型をここに集め、rewrite / tracking / import 各層が
 * 同じ Report へ書き込む。
 */
import type { Node } from "ts-morph";

/** 変換結果の報告項目。`auto` は機械変換済み、`manual` は人手確認が要る構文。 */
export interface MigrationFinding {
  readonly kind: "auto" | "manual";
  readonly construct: string;
  readonly line: number;
  readonly message: string;
}

export interface Report {
  findings: MigrationFinding[];
}

export type LineOf = (n: Node) => number;

/**
 * 生成コードが参照する OTel 名の解決結果を運ぶコンテキスト。
 * `spanStatusCode()` は `SpanStatusCode` のローカル名を lazy に確定し、
 * import 対象として登録する（呼ばれなければ import も増えない）。
 * `otelTraceName` の読み取りも同様に lazy に「使った」を記録する —
 * shim 経路（`t.getSegment().addError`）は `trace` を参照しないため、
 * SpanStatusCode だけが要る出力に `trace` を混ぜて noUnusedLocals を落とさない。
 */
export interface EmitCtx {
  readonly otelTraceName: string;
  spanStatusCode(): string;
  /** capture wrapper が生成する span 引数名 — ファイル内の既存 identifier と衝突しない名を lazy に選ぶ。 */
  spanParam(): string;
  /** callback 外で `x = getSegment()` 束縛された receiver — callback 内の参照を拾うのに使う。 */
  outerSegments?: { decls: ReadonlySet<Node>; texts: ReadonlySet<string> };
  /** 束縛後に別式で再代入された decl — callback 内の外側束縛参照を manual に倒す判定に使う。 */
  taintedReceivers?: ReadonlySet<Node>;
  /**
   * callback 内 pass が既に manual 報告した外側束縛 receiver の member key
   * （`${canonicalReceiverText}|${memberOr[arg]}` → 残り回数）。
   * callback ごと replaceWithText で再 parse されると file-level PA/EA pass が
   * 同じ receiver を新 node として再報告する — key を consume して報告済み分だけ
   * skip する。行番号は replaceWithText 後にずれるため key には含めない。
   * receiver 単位ではなく member 単位で記録するのは、callback 外にある同名
   * receiver の別 member use を潰さないため。
   */
  reportedOuterSegments?: Map<string, number>;
}

export function report(
  r: Report,
  line: number,
  kind: "auto" | "manual",
  construct: string,
  message: string,
) {
  r.findings.push({ kind, construct, line, message });
}

/**
 * callback 内 pass で manual 報告した外側束縛 receiver の member を記録する。
 * key は `${canonicalReceiverText}|${member 名または[引数]}`（行番号は
 * replaceWithText 後にずれるため含めない）。file post-pass が再 parse 済みの
 * 同じ node を再報告しないよう consume で照合する。
 */
export function recordReportedOuter(map: Map<string, number> | undefined, key: string): void {
  if (map === undefined) return;
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** `recordReportedOuter` の key が残っていれば 1 回分消費して true。 */
export function consumeReportedOuter(map: Map<string, number> | undefined, key: string): boolean {
  if (map === undefined) return false;
  const n = map.get(key) ?? 0;
  if (n <= 0) return false;
  map.set(key, n - 1);
  return true;
}
