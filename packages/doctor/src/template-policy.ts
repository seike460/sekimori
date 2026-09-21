/** template 内の IAM role / policy から xray 書き込み可否を評価する判定層。 */

import type { Json, Resources } from "./cfn.js";
import { asObject, isIntrinsicObject, isNoValueRef, referencedLogicalId } from "./cfn.js";
import {
  evaluatePolicyDocument,
  isAwsManagedPolicyArn,
  KNOWN_NO_XRAY_MANAGED_POLICIES,
  type PolicyVerdict,
  XRAY_ALLOWED_MANAGED_POLICIES,
} from "./policy.js";

/**
 * ManagedPolicyArns / PermissionsBoundary の 1 件を評価する。
 * - 文字列 ARN: allow-list の AWS managed policy 名なら "allow"、xray 非含有が分かっている
 *   典型 policy なら "no-allow"。それ以外（未収録の AWS managed / customer managed）は
 *   document を読めないため "undecidable" — false fail と false pass の両方を避ける。
 * - `{"Ref": "X"}` で X が同 template の `AWS::IAM::ManagedPolicy` なら document を評価。
 * - その他の intrinsic（ImportValue / Sub / GetAtt 等）は "undecidable"。
 */
function managedPolicyVerdict(entry: unknown, resources: Resources): PolicyVerdict {
  if (typeof entry === "string") {
    // 名前の allow/deny リストは AWS 所有の managed policy（`arn:aws:iam::aws:policy/...`、
    // または接頭辞なしの bare name — template では AWS 側を指す慣用形）にだけ適用する。
    // customer managed policy ARN が同名を名乗るケースでの false pass を防ぐ。
    const awsManaged = isAwsManagedPolicyArn(entry) || !entry.includes(":");
    if (!awsManaged) return "undecidable";
    const name = entry.split("/").at(-1)?.toLowerCase();
    if (name === undefined) return "undecidable";
    if (XRAY_ALLOWED_MANAGED_POLICIES.has(name)) return "allow";
    if (KNOWN_NO_XRAY_MANAGED_POLICIES.has(name)) return "no-allow";
    return "undecidable";
  }
  const ref = asObject(entry)?.Ref;
  const target = typeof ref === "string" ? asObject(resources[ref]) : undefined;
  if (target !== undefined && target.Type === "AWS::IAM::ManagedPolicy") {
    return evaluatePolicyDocument(asObject(target.Properties)?.PolicyDocument);
  }
  return "undecidable";
}

/**
 * Role リソース（inline + managed policy + permissions boundary + standalone policy）から
 * xray 書き込み可否を判定。`roleId` は role の論理 ID。
 * 解決不能は undefined。policy を跨いだ Deny 優先（1 つでも Deny なら全体で deny）を再現する。
 * role が解決できて許可が無い（policy ゼロを含む）場合は false（= fail）。
 * `Role` の Ref 先が Role リソースでない / policy 列が intrinsic の場合は「評価不能」= undefined。
 */
export function roleAllowsXrayWrite(
  roleId: string | undefined,
  resources: Resources,
): boolean | undefined {
  const res = asObject(roleId !== undefined ? resources[roleId] : undefined);
  // Ref / GetAtt の先が Role 以外（Queue 等）のリソースなら評価不能 = warn。
  if (res === undefined || res.Type !== "AWS::IAM::Role") return undefined;
  const props = asObject(res.Properties);
  // `Properties: { "Fn::If": [...] }` のように object 自体が intrinsic なら全 property が
  // 解決不能 — 空として評価して false fail しない。
  if (props === undefined || isIntrinsicObject(props)) return undefined;
  const verdicts: PolicyVerdict[] = [];
  let unresolvable = false;
  const managed = props.ManagedPolicyArns;
  // Fn::If / Ref 等で list が解決できないときは評価不能。`Ref: AWS::NoValue` は未設定と同義。
  if (managed !== undefined && !Array.isArray(managed) && !isNoValueRef(managed))
    unresolvable = true;
  for (const entry of Array.isArray(managed) ? managed : []) {
    if (isNoValueRef(entry)) continue; // CDK は ManagedPolicyArns 未設定時に NoValue を残す
    const verdict = managedPolicyVerdict(entry, resources);
    if (verdict === "no-allow") continue;
    if (verdict === "undecidable") unresolvable = true;
    else verdicts.push(verdict);
  }
  const policies = props.Policies;
  if (policies !== undefined && !Array.isArray(policies) && !isNoValueRef(policies))
    unresolvable = true;
  for (const policy of Array.isArray(policies) ? policies : []) {
    verdicts.push(evaluatePolicyDocument(asObject(policy)?.PolicyDocument));
  }
  // PermissionsBoundary は effective permission を絞る — xray を許さない boundary なら deny 同等。
  const boundary = props.PermissionsBoundary;
  if (boundary !== undefined && !isNoValueRef(boundary)) {
    const verdict = managedPolicyVerdict(boundary, resources);
    if (verdict === "no-allow" || verdict === "deny") return false;
    if (verdict === "undecidable") unresolvable = true;
  }
  // CDK の `fn.addToRolePolicy()` / `role.attachInlinePolicy()` は standalone
  // `AWS::IAM::Policy`（`Roles: [{ Ref: Role }]`）を生成する — role 本体に inline policy が
  // 無くても effective permission に効くため必ず拾う（拾わないと false fail / false pass）。
  // `Roles` を持つ `AWS::IAM::ManagedPolicy`（customer managed policy の attach）も同様。
  const roleName = typeof props.RoleName === "string" ? props.RoleName : undefined;
  for (const [otherId, raw] of Object.entries(resources)) {
    if (otherId === roleId) continue;
    const other = asObject(raw);
    if (other?.Type !== "AWS::IAM::Policy" && other?.Type !== "AWS::IAM::ManagedPolicy") {
      continue;
    }
    const otherProps = asObject(other.Properties);
    const roles = otherProps?.Roles;
    // `Roles: { Fn::If: [...] }` のような intrinsic — 対象 role に効くか不明。
    // skip すると Deny/Allow を見落として false pass/false fail になるので warn に倒す。
    if (roles !== undefined && !Array.isArray(roles) && !isNoValueRef(roles)) {
      unresolvable = true;
      continue;
    }
    if (!Array.isArray(roles)) continue;
    // entry が `{Ref}` / `{Fn::GetAtt}` なら論理 ID で照合。literal role 名は
    // 対象 role の `RoleName`（明示指定時）と照合 — RoleName 未指定の物理名は
    // deploy 時に採番されるため照合不能として warn に倒す。
    let attached = false;
    for (const r of roles) {
      const refId = referencedLogicalId(r);
      if (refId !== undefined) {
        if (refId === roleId) attached = true;
        continue;
      }
      if (typeof r === "string") {
        if (roleName !== undefined && r === roleName) attached = true;
        else if (roleName === undefined) unresolvable = true;
        continue;
      }
      if (!isNoValueRef(r)) unresolvable = true;
    }
    if (!attached) continue;
    // policy resource の `Condition` 属性は deploy 条件 — 条件付きで作成される
    // policy の効果は実行時条件次第なので、評価は保てない（undecidable 側に倒す）。
    // 正規の CFN では Condition は文字列だが、非文字列の malformed 値でも
    // 「条件付き」を無視して評価する方が危険なので、存在するだけで unresolvable にする。
    if (other.Condition !== undefined) {
      unresolvable = true;
      continue;
    }
    verdicts.push(evaluatePolicyDocument(otherProps?.PolicyDocument));
  }
  if (verdicts.includes("deny")) return false;
  if (unresolvable || verdicts.includes("undecidable")) return undefined;
  if (verdicts.includes("allow")) return true;
  return false;
}

/**
 * SAM `AWS::Serverless::Function` の `Policies` から xray 書き込み可否を判定する。
 * Role 未指定のとき SAM は `AWSLambdaBasicExecutionRole` だけを持つ default role を作るため、
 * Policies が無い/NoValue なら xray write は確実に無い → false（fail）。
 * entry は managed policy 名の文字列 / `{ Statement: [...] }` の inline document /
 * `{ "Ref": ManagedPolicy }` を受理する。SAM policy template 名（`SQSPollerPolicy` 等）や
 * intrinsic は解決不能 → "undecidable"（warn）。
 */
function samPoliciesVerdict(policies: unknown, resources: Resources): boolean | undefined {
  if (policies === undefined || isNoValueRef(policies)) return false;
  // SAM の Policies は String / Map / List を受理する — 単体値は 1 要素に正規化する。
  // intrinsic（`{Fn::If}` 等）も 1 要素に畳み、entry 評価で undecidable になる。
  const list = Array.isArray(policies) ? policies : [policies];
  const verdicts: PolicyVerdict[] = [];
  let unresolvable = false;
  for (const entry of list) {
    if (isNoValueRef(entry)) continue;
    const obj = asObject(entry);
    const verdict =
      obj !== undefined && obj.Statement !== undefined
        ? evaluatePolicyDocument(obj)
        : managedPolicyVerdict(entry, resources);
    if (verdict === "no-allow") continue;
    if (verdict === "undecidable") unresolvable = true;
    else verdicts.push(verdict);
  }
  if (verdicts.includes("deny")) return false;
  if (unresolvable) return undefined;
  return verdicts.includes("allow");
}

/** SAM function の xray write 判定。Role → Ref 解決、未指定/NoValue → default role の Policies。 */
export function samXrayWriteAllowed(props: Json, resources: Resources): boolean | undefined {
  // `Ref: AWS::NoValue` は referencedLogicalId も拾うため先に除外する。
  if (props.Role === undefined || isNoValueRef(props.Role)) {
    const verdict = samPoliciesVerdict(props.Policies, resources);
    // SAM は Role 未指定のとき生成する default role に function の PermissionsBoundary を
    // 適用する — xray を許さない boundary なら effective permission は deny 相当。
    const boundary = props.PermissionsBoundary;
    if (boundary !== undefined && !isNoValueRef(boundary)) {
      const bv = managedPolicyVerdict(boundary, resources);
      if (bv === "no-allow" || bv === "deny") return false;
      if (bv === "undecidable") return verdict === true ? undefined : verdict;
    }
    return verdict;
  }
  const roleId = referencedLogicalId(props.Role);
  if (roleId !== undefined) return roleAllowsXrayWrite(roleId, resources);
  // Role が文字列 ARN や別種の intrinsic — template からは policy を読めない。
  return undefined;
}
