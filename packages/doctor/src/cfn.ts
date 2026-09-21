/** CloudFormation / SAM template の JSON 構造と intrinsic 判定の最小ヘルパー群。 */

export type Json = Record<string, unknown>;

/** cdk.out / SAM template のうち doctor が読む最小形。 */
export interface CfnTemplate {
  Resources?: Record<
    string,
    {
      Type?: string;
      Properties?: Json;
      /** resource-level attribute — deploy 条件。正規は文字列だが malformed 値も流れ得る。 */
      Condition?: unknown;
    }
  >;
  /** SAM `Globals` — Function 以下の property は各 Serverless::Function に継承される。 */
  Globals?: Json;
}

export type Resources = NonNullable<CfnTemplate["Resources"]>;

export function asObject(value: unknown): Json | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

/** `{ "Ref": "AWS::NoValue" }` — SAM/CDK が「未設定」を表すのに使う pseudo-parameter。 */
export function isNoValueRef(value: unknown): boolean {
  return asObject(value)?.Ref === "AWS::NoValue";
}

/** `Properties` 等の object が intrinsic 関数だけを持つ（= 全 property 解決不能）か。 */
const INTRINSIC_KEYS = new Set([
  "Ref",
  "Condition",
  "Fn::If",
  "Fn::Sub",
  "Fn::GetAtt",
  "Fn::ImportValue",
  "Fn::Join",
  "Fn::Select",
  "Fn::GetAZs",
  "Fn::Base64",
  "Fn::Cidr",
  "Fn::FindInMap",
  "Fn::Transform",
  "Fn::Equals",
  "Fn::And",
  "Fn::Or",
  "Fn::Not",
  "Fn::ForEach",
]);

export function isIntrinsicObject(value: unknown): boolean {
  const obj = asObject(value);
  if (obj === undefined) return false;
  const keys = Object.keys(obj);
  return keys.length > 0 && keys.every((k) => INTRINSIC_KEYS.has(k));
}

/**
 * `{"Fn::GetAtt": ["X","Arn"]}` / `{"Fn::GetAtt": "X.Arn"}` / `{"Ref": "X"}` → 論理 ID。
 * （Fn::GetAtt は YAML shorthand 由来で文字列形も valid。）
 */
export function referencedLogicalId(value: unknown): string | undefined {
  const obj = asObject(value);
  if (obj === undefined) return undefined;
  const getAtt = obj["Fn::GetAtt"];
  if (Array.isArray(getAtt) && typeof getAtt[0] === "string") return getAtt[0];
  if (typeof getAtt === "string") return getAtt.split(".")[0];
  if (typeof obj.Ref === "string") return obj.Ref;
  return undefined;
}

/** intrinsic（`{Fn::If}` / `{Ref}` 等。NoValue は除く）= 値が解決不能な object。 */
export function isUnresolvable(value: unknown): boolean {
  return isIntrinsicObject(value) && !isNoValueRef(value);
}
