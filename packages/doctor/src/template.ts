/** template 解析の orchestrator — CFN/SAM template から function 単位の facts を組み立てる。 */
import {
  asObject,
  type CfnTemplate,
  isIntrinsicObject,
  isNoValueRef,
  type Json,
  referencedLogicalId,
} from "./cfn.js";
import { checkFunction, type DoctorReport, type FunctionFacts } from "./checks.js";
import { mergeSamGlobals, unsupportedGlobalKeys } from "./sam-globals.js";
import { roleAllowsXrayWrite, samXrayWriteAllowed } from "./template-policy.js";

export type { CfnTemplate } from "./cfn.js";

const ESM_HELPERS: Record<string, string> = {
  ":sqs:": "withSqsRecord",
  ":kinesis:": "withKinesisRecord",
  ":dynamodb:": "withDynamoDbRecord",
};

/** EventSourceArn の Ref/GetAtt 先の resource Type → 対応する helper。 */
const ESM_TYPE_HELPERS: Record<string, string> = {
  "AWS::SQS::Queue": "withSqsRecord",
  "AWS::Kinesis::Stream": "withKinesisRecord",
  "AWS::DynamoDB::Table": "withDynamoDbRecord",
};

/**
 * cdk.out の CloudFormation template（JSON.parse 済み）を解析する。
 * `AWS::Lambda::Function` ごとに 6 check を評価し、event source と
 * Transaction Search の有無を note として添える。
 */
export function analyzeTemplate(template: CfnTemplate): DoctorReport {
  const resources = template.Resources ?? {};
  const functions: DoctorReport["functions"] = [];
  const notes: string[] = [];
  // SAM `Globals.Function` — 各 Serverless::Function が継承する default property。
  // SAM の merge は property 単位（map は再帰 merge、list は global 先行の連結）。
  const samGlobals = asObject(asObject(template.Globals)?.Function);
  // SAM が Globals.Function で受け付けない key（Policies / PackageType / ImageConfig 等）。
  // 書いても merge されず deploy 時に SAM がエラーにする — doctor でも読み飛ばして note に出す。
  const unsupportedGlobals = unsupportedGlobalKeys(samGlobals);
  let samFunctions = 0;

  for (const [logicalId, rawResource] of Object.entries(resources)) {
    const resource = asObject(rawResource);
    const isSam = resource?.Type === "AWS::Serverless::Function";
    if (resource?.Type !== "AWS::Lambda::Function" && !isSam) continue;
    if (isSam) samFunctions++;
    // `Properties: { "Fn::If": [...] }` のように object 自体が intrinsic の場合、
    // 全 property が解決不能 — layers/env を「未設定」と誤認して fail しないよう印を付ける。
    // `Ref: AWS::NoValue` は Properties 未設定と同義（unresolvable ではない）。
    const propsUnresolvable =
      resource.Properties !== undefined &&
      (asObject(resource.Properties) === undefined ||
        (isIntrinsicObject(resource.Properties) && !isNoValueRef(resource.Properties)));
    const ownProps = isNoValueRef(resource.Properties) ? {} : (asObject(resource.Properties) ?? {});
    const samMerged =
      isSam && samGlobals !== undefined ? mergeSamGlobals(samGlobals, ownProps) : undefined;
    const props: Json = samMerged?.props ?? ownProps;
    const globalsDropped = samMerged?.dropped ?? new Set<string>();
    // Environment / Variables も intrinsic になり得る — `{Fn::If}` 等は asObject を
    // 通るので「object だから concrete map」と誤認しないよう intrinsic かも見る。
    const envRaw = props.Environment;
    const envIsUnresolvable =
      envRaw !== undefined &&
      !isNoValueRef(envRaw) &&
      (isIntrinsicObject(envRaw) || asObject(envRaw) === undefined);
    const env = envIsUnresolvable || isNoValueRef(envRaw) ? undefined : asObject(envRaw);
    const varsRaw = env?.Variables;
    const varsIsUnresolvable =
      varsRaw !== undefined &&
      !isNoValueRef(varsRaw) &&
      (isIntrinsicObject(varsRaw) || asObject(varsRaw) === undefined);
    const envUnresolvable =
      propsUnresolvable ||
      globalsDropped.has("Environment") ||
      envIsUnresolvable ||
      varsIsUnresolvable;
    const envEntries = varsIsUnresolvable ? [] : Object.entries(asObject(varsRaw) ?? {});
    const layerEntries = Array.isArray(props.Layers) ? props.Layers : [];
    const runtime = typeof props.Runtime === "string" ? props.Runtime : undefined;
    // SAM は `Tracing: "Active" | "PassThrough" | "Disabled"` の文字列、
    // CFN は `TracingConfig.Mode`。`Disabled` は PassThrough 相当（unsampled context）に畳む。
    const samTracing = typeof props.Tracing === "string" ? props.Tracing : undefined;
    const tracingConfigMode = asObject(props.TracingConfig)?.Mode;
    const tracingMode = isSam
      ? samTracing === "Disabled"
        ? "PassThrough"
        : samTracing
      : typeof tracingConfigMode === "string"
        ? tracingConfigMode
        : undefined;
    // TracingConfig / Tracing が intrinsic で Mode を読めない —「未設定」と誤報しない。
    const tracingUnresolvable =
      propsUnresolvable ||
      (isSam
        ? (props.Tracing !== undefined &&
            typeof props.Tracing !== "string" &&
            !isNoValueRef(props.Tracing)) ||
          globalsDropped.has("Tracing")
        : props.TracingConfig !== undefined &&
          !isNoValueRef(props.TracingConfig) &&
          (asObject(props.TracingConfig) === undefined ||
            typeof asObject(props.TracingConfig)?.Mode !== "string"));
    const facts: FunctionFacts = {
      name: (typeof props.FunctionName === "string" ? props.FunctionName : undefined) ?? logicalId,
      tracingMode,
      tracingUnresolvable,
      // Layers は Fn::Join 等の intrinsic を含み得るので、非文字列は serialize して名前一致に供する。
      layers: layerEntries.map((l) => (typeof l === "string" ? l : JSON.stringify(l))),
      // intrinsic 値の layer / env var は verdict を pass/fail ではなく warn に倒すため印を付ける。
      layersUnresolvable:
        propsUnresolvable ||
        globalsDropped.has("Layers") ||
        (props.Layers !== undefined &&
          !Array.isArray(props.Layers) &&
          !isNoValueRef(props.Layers)) ||
        layerEntries.some((l) => typeof l !== "string" && !isNoValueRef(l)),
      environment: Object.fromEntries(
        envEntries.filter((e): e is [string, string] => typeof e[1] === "string"),
      ),
      unresolvableEnvKeys: envEntries
        .filter(([, v]) => typeof v !== "string" && !isNoValueRef(v))
        .map(([k]) => k),
      envUnresolvable,
      // `PackageType: "Image"` や非 Node runtime には ADOT JS layer / exec wrapper が適用外。
      nonNodeJs:
        props.PackageType === "Image" || (runtime !== undefined && !runtime.startsWith("nodejs")),
      // `Runtime: { Ref: ... }` のような intrinsic は nodejs かどうか判定不能 — warn に倒す。
      // Globals 側が intrinsic で捨てられた Runtime も同じく判定不能。own の PackageType が
      // intrinsic なら zip/Image も不明（PackageType は SAM Globals 非対応なので own のみ見る）。
      runtimeUnresolvable:
        (props.Runtime !== undefined && typeof props.Runtime !== "string") ||
        (props.PackageType !== undefined && typeof props.PackageType !== "string") ||
        globalsDropped.has("Runtime"),
      xrayWriteAllowed: isSam
        ? samXrayWriteAllowed(props, resources)
        : roleAllowsXrayWrite(referencedLogicalId(props.Role), resources),
    };
    functions.push(checkFunction(facts));
  }

  if (samFunctions > 0) {
    notes.push(
      `${samFunctions} AWS::Serverless::Function resource(s) evaluated as SAM (Globals applied; Role-less functions use the generated default role + Policies)`,
    );
    if (unsupportedGlobals.length > 0) {
      notes.push(
        `SAM Globals.Function has unsupported keys (ignored by SAM — deploy will error): ${unsupportedGlobals.join(", ")}`,
      );
    }
  }

  // EventSourceMapping は SQS 以外（Kinesis / DynamoDB / MSK 等）も作る — source ごとに
  // 対応する sekimori の helper を案内し、判別できなければ汎用の文にする。
  const esmHelpers = new Set<string>();
  let hasUnresolvableEsm = false;
  for (const r of Object.values(resources)) {
    const resource = asObject(r);
    if (resource?.Type !== "AWS::Lambda::EventSourceMapping") continue;
    const esmArn = asObject(resource.Properties)?.EventSourceArn;
    let helper: string | undefined;
    if (typeof esmArn === "string") {
      helper = Object.entries(ESM_HELPERS).find(([marker]) => esmArn.includes(marker))?.[1];
    } else {
      // CDK は `{ "Fn::GetAtt": ["MyQueue","Arn"] }` を出す — Ref 先の resource Type で判別する。
      const target = referencedLogicalId(esmArn);
      if (target !== undefined) {
        const targetType = asObject(resources[target])?.Type;
        helper = ESM_TYPE_HELPERS[typeof targetType === "string" ? targetType : ""];
      }
    }
    if (helper !== undefined) esmHelpers.add(helper);
    else hasUnresolvableEsm = true;
  }
  if (esmHelpers.size > 0 || hasUnresolvableEsm) {
    const helpers =
      esmHelpers.size > 0
        ? [...esmHelpers].join(" / ")
        : "with*Record helpers (withSqsRecord / withKinesisRecord / withDynamoDbRecord)";
    notes.push(
      `EventSourceMapping detected — consume records with sekimori's ${helpers} so per-record spans link to producers`,
    );
  }
  const hasTxnSearch = Object.values(resources).some(
    (r) => asObject(r)?.Type === "AWS::XRay::TransactionSearchConfig",
  );
  notes.push(
    hasTxnSearch
      ? "Transaction Search configured — spans are searchable in CloudWatch aws/spans"
      : "Transaction Search not in this template — enable it (account-level) or rely on X-Ray BatchGetTraces",
  );
  notes.push(
    "Bundled aws-xray-sdk cannot be detected from a template — check the package lockfile for aws-xray-sdk*",
  );

  return { functions, notes };
}
