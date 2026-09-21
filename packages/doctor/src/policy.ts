/** IAM policy document から `xray:PutTraceSegments` 可否を読む共有ロジック（template / live 両経路で使う）。 */

type Json = Record<string, unknown>;

/**
 * policy document の評価結果。
 * - `"allow"` = `xray:PutTraceSegments` をカバーする Allow + `Resource: "*"` がある
 * - `"deny"` = 一致する Deny がある（Deny は常に勝つ）
 * - `"no-allow"` = 評価できたが許可が無い
 * - `"undecidable"` = document が object でない / NotAction・NotResource を含む等で判定不能
 */
export type PolicyVerdict = "allow" | "deny" | "no-allow" | "undecidable";

/** `xray:PutTraceSegments` を許可することが分かっている AWS managed policy 名（小文字）。 */
export const XRAY_ALLOWED_MANAGED_POLICIES: ReadonlySet<string> = new Set([
  "cloudwatchlambdaapplicationsignalsexecutionrolepolicy",
  "awsxraydaemonwriteaccess",
  "awsxraywriteonlyaccess",
  "awsxrayfullaccess",
  "administratoraccess",
  "poweruseraccess",
]);

/**
 * xray write を含まないことが分かっている代表的な AWS managed policy 名（小文字）。
 * Lambda の典型 execution role / read-only 系を網羅する — これらが role の唯一の policy
 * なら「許可が無い」と確定できて fail にできる。ここにも allow-list にも無い AWS managed
 * policy は undecidable（AWS が新しい xray 許可 policy を出した場合の false fail を避ける）。
 */
export const KNOWN_NO_XRAY_MANAGED_POLICIES: ReadonlySet<string> = new Set([
  // AWSLambda_FullAccess の xray action は GetTraceSummaries/BatchGetTraces のみで
  // PutTraceSegments を含まない（AWS 公式 policy document 確認済み）。
  "awslambda_fullaccess",
  "awslambdabasicexecutionrole",
  "awslambdavpcaccessexecutionrole",
  "awslambdaenimanagementaccess",
  "awslambdasqsqueueexecutionrole",
  "awslambdakinesisexecutionrole",
  "awslambdadynamodbexecutionrole",
  "awslambdamskexecutionrole",
  "awslambdaexecute",
  "awslambdareadonlyaccess",
  "awsxrayreadonlyaccess",
  "readonlyaccess",
  "securityaudit",
  "viewonlyaccess",
]);

const XRAY_WRITE_ACTION = "xray:puttracesegments";

function asObject(value: unknown): Json | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

function asStringList(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * IAM action pattern を match させる。`*` は任意文字列、`?` は任意 1 文字、
 * action 名の比較は case-insensitive（IAM 仕様）。
 */
export function iamActionMatches(pattern: string, action: string): boolean {
  const re = new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replaceAll("*", ".*")
      .replaceAll("?", ".")}$`,
    "i",
  );
  return re.test(action);
}

/**
 * Resource が `"*"` を含むか。`xray:PutTraceSegments` は resource-level permission を
 * 持たず実効 Resource は常に `"*"` なので、絞られた Resource の statement は Deny/Allow
 * どちらも到達しない — 両方で同じ判定を使う。
 */
function resourceIsWildcard(resource: unknown): boolean {
  return resource === "*" || (Array.isArray(resource) && resource.includes("*"));
}

/** AWS managed policy の ARN（account フィールドが `aws` / `aws-cn` 等）か。 */
export function isAwsManagedPolicyArn(arn: string): boolean {
  if (!arn.startsWith("arn:")) return false;
  const account = arn.split(":")[4];
  return account === "aws" || account === "aws-cn" || account === "aws-us-gov";
}

/**
 * policy document を評価する。
 * `NotAction` / `NotResource` を含む statement は包含関係を単純には判定できないため
 * `undecidable` に倒す（保守的 — 誤った pass/fail より「手で確認して」が安全）。
 * `Condition` / principal 条件までは見ない簡易ヒューリスティック。
 */
export function evaluatePolicyDocument(doc: unknown): PolicyVerdict {
  const obj = asObject(doc);
  if (obj === undefined || !Array.isArray(obj.Statement)) return "undecidable";
  const statements = obj.Statement;
  let saw = false;
  let allowed = false;
  let denied = false;
  let undecidable = false;
  for (const stmt of statements) {
    const s = asObject(stmt);
    if (s === undefined) continue;
    saw = true;
    if (s.NotAction !== undefined || s.NotResource !== undefined) {
      undecidable = true;
      continue;
    }
    // Action / Resource / Effect が intrinsic（`{ Ref: ... }` 等の非 string）だと
    // statement 全体を評価できない — 黙って skip すると false fail/false pass になる。
    const isStringOrList = (v: unknown) =>
      v === undefined ||
      typeof v === "string" ||
      (Array.isArray(v) && v.every((x) => typeof x === "string"));
    if (!isStringOrList(s.Action) || !isStringOrList(s.Resource) || !isStringOrList(s.Effect)) {
      undecidable = true;
      continue;
    }
    if (!asStringList(s.Action).some((a) => iamActionMatches(a, XRAY_WRITE_ACTION))) continue;
    if (!resourceIsWildcard(s.Resource)) continue;
    // `Condition` 付きの statement は条件評価が要る — Allow は実際に許可されない
    // 可能性、Deny は実際には遮断しない可能性があるので両方 undecidable に倒す。
    if (s.Condition !== undefined) {
      undecidable = true;
      continue;
    }
    if (s.Effect === "Deny") denied = true;
    else if (s.Effect === "Allow") allowed = true;
    // Action/Resource が一致するのに Effect が "Allow"/"Deny" 以外（欠落・typo・
    // `"ALLOW"` 等）— 実は Deny かもしれないので skip せず undecidable に倒す。
    else undecidable = true;
  }
  // Deny > undecidable > allow の順。undecidable が allow より先なのは、
  // その statement が実は Deny かもしれないため（false pass を避ける）。
  if (denied) return "deny";
  if (undecidable) return "undecidable";
  if (allowed) return "allow";
  // `Statement: []`（空列）も「評価できたが許可が無い」— 判定不能ではない。
  return saw || statements.length === 0 ? "no-allow" : "undecidable";
}

/**
 * 後方互換の薄い wrapper。`"deny"` と `"no-allow"` はともに `false`、
 * `"undecidable"` は `undefined` に畳む。
 */
export function policyDocumentAllowsXrayWrite(doc: unknown): boolean | undefined {
  const verdict = evaluatePolicyDocument(doc);
  if (verdict === "undecidable") return undefined;
  return verdict === "allow";
}
