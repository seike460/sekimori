/** live AWS 判定 — Lambda/IAM/X-Ray の実設定を SDK で読み readiness を評価する。 */
import {
  type AttachedPolicy,
  GetPolicyCommand,
  GetPolicyVersionCommand,
  GetRoleCommand,
  GetRolePolicyCommand,
  IAMClient,
  ListAttachedRolePoliciesCommand,
  type ListAttachedRolePoliciesCommandOutput,
  ListRolePoliciesCommand,
  type ListRolePoliciesCommandOutput,
} from "@aws-sdk/client-iam";
import { GetFunctionConfigurationCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { checkFunction, type FunctionFacts, type FunctionReport } from "./checks.js";
import {
  evaluatePolicyDocument,
  isAwsManagedPolicyArn,
  type PolicyVerdict,
  XRAY_ALLOWED_MANAGED_POLICIES,
} from "./policy.js";

/** 各 AWS SDK 呼び出しの request timeout 既定値 — 応答の無い API に張り付かないよう守る。 */
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/**
 * `AbortSignal.timeout` の内部タイマーは setTimeout と同じく 2^31-1 ms が上限。
 * 超過値は 1ms に丸められて即時 abort し（silent）、NaN・負数・小数は RangeError になる。
 * IAM 側では `xrayIamError` の warn に、Lambda 側では reject になるため入口で名指しして止める。
 */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

function assertTimeoutMs(timeoutMs: number): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError(
      `analyzeFunction: options.timeoutMs must be an integer in 1..${MAX_TIMEOUT_MS}ms.`,
    );
  }
}

const requestOptions = (timeoutMs: number) => ({
  abortSignal: AbortSignal.timeout(timeoutMs),
});

function roleNameFromArn(arn: string): string | undefined {
  return arn.split("/").at(-1);
}

function documentVerdict(document: string | undefined): PolicyVerdict {
  if (document === undefined) return "undecidable";
  try {
    return evaluatePolicyDocument(JSON.parse(decodeURIComponent(document)));
  } catch {
    // policy document の URI decode / JSON parse 失敗は判定不能に倒す。
    return "undecidable";
  }
}

/** managed policy の ARN から現行 version の document を取って評価する。読めなければ undecidable。 */
async function managedPolicyDocVerdict(
  iam: IAMClient,
  arn: string,
  policyName: string | undefined,
  timeoutMs: number,
): Promise<PolicyVerdict> {
  // 名前の allow-list は AWS 所有の managed policy（`arn:aws:iam::aws:policy/...`）にだけ
  // 適用する — 同名を名乗る customer managed policy での false pass を防ぐ。
  if (
    policyName !== undefined &&
    isAwsManagedPolicyArn(arn) &&
    XRAY_ALLOWED_MANAGED_POLICIES.has(policyName.toLowerCase())
  ) {
    return "allow";
  }
  try {
    const policy = await iam.send(
      new GetPolicyCommand({ PolicyArn: arn }),
      requestOptions(timeoutMs),
    );
    const versionId = policy.Policy?.DefaultVersionId;
    if (versionId === undefined) return "undecidable";
    const version = await iam.send(
      new GetPolicyVersionCommand({ PolicyArn: arn, VersionId: versionId }),
      requestOptions(timeoutMs),
    );
    return documentVerdict(version.PolicyVersion?.Document);
  } catch {
    // GetPolicy / GetPolicyVersion の失敗（権限・throttle 等）は判定不能に倒す。
    return "undecidable";
  }
}

interface Paged {
  IsTruncated?: boolean | undefined;
  Marker?: string | undefined;
}

/** List* API の Marker/IsTruncated ページング（1 ページ 100 件）を畳み込む。 */
async function collectPages<Page extends Paged, Item>(
  fetchPage: (marker: string | undefined) => Promise<Page>,
  items: (page: Page) => Item[] | undefined,
): Promise<Item[]> {
  const out: Item[] = [];
  let marker: string | undefined;
  do {
    const page = await fetchPage(marker);
    out.push(...(items(page) ?? []));
    marker = page.IsTruncated ? page.Marker : undefined;
  } while (marker !== undefined);
  return out;
}

const listAttachedRolePolicies = (iam: IAMClient, roleName: string, timeoutMs: number) =>
  collectPages<ListAttachedRolePoliciesCommandOutput, AttachedPolicy>(
    (marker) =>
      iam.send(
        new ListAttachedRolePoliciesCommand({ RoleName: roleName, Marker: marker }),
        requestOptions(timeoutMs),
      ),
    (page) => page.AttachedPolicies,
  );

const listRolePolicyNames = (iam: IAMClient, roleName: string, timeoutMs: number) =>
  collectPages<ListRolePoliciesCommandOutput, string>(
    (marker) =>
      iam.send(
        new ListRolePoliciesCommand({ RoleName: roleName, Marker: marker }),
        requestOptions(timeoutMs),
      ),
    (page) => page.PolicyNames,
  );

/**
 * Role の managed policy + inline policy + permissions boundary を全部読んで
 * xray 書き込み可否を判定する。1 つでも Deny が一致すれば false（Deny は policy を跨いで勝つ）。
 * boundary が xray を許さなければ policy の許可があっても false。
 * 読めない policy がある / statement が判定不能なら undefined（warn）。
 */
interface XrayWriteVerdict {
  readonly allowed: boolean | undefined;
  /** IAM 読み取り自体の失敗理由（warn の説明に使う）。 */
  readonly error?: string | undefined;
}

async function roleAllowsXrayWrite(
  iam: IAMClient,
  roleArn: string,
  timeoutMs: number,
): Promise<XrayWriteVerdict> {
  const roleName = roleNameFromArn(roleArn);
  if (roleName === undefined) return { allowed: undefined };
  try {
    const verdicts: PolicyVerdict[] = [];
    let unresolvable = false;

    const role = await iam.send(
      new GetRoleCommand({ RoleName: roleName }),
      requestOptions(timeoutMs),
    );
    const boundaryArn = role.Role?.PermissionsBoundary?.PermissionsBoundaryArn;
    if (boundaryArn !== undefined) {
      const verdict = await managedPolicyDocVerdict(
        iam,
        boundaryArn,
        boundaryArn.split("/").at(-1),
        timeoutMs,
      );
      if (verdict === "no-allow" || verdict === "deny") return { allowed: false };
      if (verdict === "undecidable") unresolvable = true;
    }

    for (const p of await listAttachedRolePolicies(iam, roleName, timeoutMs)) {
      const name = p.PolicyName?.toLowerCase();
      // ListAttachedRolePolicies は常に ARN を返すが、fixture 互換で ARN 欠落を許す —
      // その場合は名前だけしか情報が無いので AWS 所有と見做して allow-list を適用する。
      if (
        name !== undefined &&
        (p.PolicyArn === undefined || isAwsManagedPolicyArn(p.PolicyArn)) &&
        XRAY_ALLOWED_MANAGED_POLICIES.has(name)
      ) {
        verdicts.push("allow");
        continue;
      }
      if (p.PolicyArn === undefined) {
        unresolvable = true;
        continue;
      }
      const verdict = await managedPolicyDocVerdict(iam, p.PolicyArn, p.PolicyName, timeoutMs);
      if (verdict === "undecidable") unresolvable = true;
      else verdicts.push(verdict);
    }

    for (const policyName of await listRolePolicyNames(iam, roleName, timeoutMs)) {
      const doc = await iam.send(
        new GetRolePolicyCommand({ RoleName: roleName, PolicyName: policyName }),
        requestOptions(timeoutMs),
      );
      verdicts.push(documentVerdict(doc.PolicyDocument));
    }

    if (verdicts.includes("deny")) return { allowed: false };
    if (unresolvable || verdicts.includes("undecidable")) return { allowed: undefined };
    if (verdicts.includes("allow")) return { allowed: true };
    return { allowed: false };
  } catch (error) {
    // IAM 読み取り自体の失敗（権限不足 / throttle / network）— 判定不能だが
    // 理由は report の warn に載せて「なぜ読めなかったか」を残す。
    return { allowed: undefined, error: error instanceof Error ? error.name : String(error) };
  }
}

/** role verdict を FunctionFacts の field へ写す。Role 未設定なら両方 undefined。 */
async function xrayWriteFacts(
  iam: IAMClient,
  roleArn: string | undefined,
  timeoutMs: number,
): Promise<Pick<FunctionFacts, "xrayWriteAllowed" | "xrayIamError">> {
  if (roleArn === undefined) return {};
  const verdict = await roleAllowsXrayWrite(iam, roleArn, timeoutMs);
  return { xrayWriteAllowed: verdict.allowed, xrayIamError: verdict.error };
}

/**
 * live の Lambda 関数を `GetFunctionConfiguration` + IAM で検査する。
 * AWS 資格情報が要る。読み取りのみで変更はしない。
 */
export interface AnalyzeOptions {
  /** client の差し替え口（テストで fake を注入する / caller が region・資格情報を制御する）。 */
  lambda?: LambdaClient;
  iam?: IAMClient;
  /** 各 AWS SDK 呼び出しの request timeout（既定 15_000ms）。 */
  timeoutMs?: number;
}

export async function analyzeFunction(
  functionName: string,
  options: AnalyzeOptions = {},
): Promise<FunctionReport> {
  const lambda = options.lambda ?? new LambdaClient({});
  const iam = options.iam ?? new IAMClient({});
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  assertTimeoutMs(timeoutMs);
  const config = await lambda.send(
    new GetFunctionConfigurationCommand({ FunctionName: functionName }),
    requestOptions(timeoutMs),
  );
  const facts: FunctionFacts = {
    name: config.FunctionName ?? functionName,
    tracingMode: config.TracingConfig?.Mode,
    layers: (config.Layers ?? []).map((l) => l.Arn ?? "").filter((a) => a !== ""),
    environment: config.Environment?.Variables ?? {},
    // PackageType=Image / 非 Node runtime には ADOT JS layer / exec wrapper が適用外。
    nonNodeJs:
      config.PackageType === "Image" ||
      (typeof config.Runtime === "string" && !config.Runtime.startsWith("nodejs")),
    ...(await xrayWriteFacts(iam, config.Role, timeoutMs)),
  };
  return checkFunction(facts);
}
