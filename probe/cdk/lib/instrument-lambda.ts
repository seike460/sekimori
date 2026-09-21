/** Lambda への ADOT layer・env・最小権限 IAM を付与する construct ヘルパー。 */
import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { MIN_ADOT_LAYER_VERSION } from "sekimori";

/** AWS が公開する ADOT JS layer（Application Signals 用）。 */
export const OTEL_LAYER_NAME = "AWSOpenTelemetryDistroJs";
/**
 * probe が pin する layer バージョン。正本は `sekimori` の MIN_ADOT_LAYER_VERSION —
 * probe は「最小対応バージョンで link が成立すること」を示すため同値を deploy する。
 */
export const OTEL_LAYER_VERSION = MIN_ADOT_LAYER_VERSION;

/**
 * `AWSOpenTelemetryDistroJs` を公開する region → { account, latest }。
 * account は region 依存（aws-otel-js-instrumentation の release table、v0.12.0 = layer :15 時点）。
 * `latest` はその region で公開されている最新 layer version — 新しい region では :15 が無い。
 * https://github.com/aws-observability/aws-otel-js-instrumentation/releases
 */
const OTEL_LAYER_TABLE: Record<string, { account: string; latest: number }> = {
  "af-south-1": { account: "904233096616", latest: 15 },
  "ap-east-1": { account: "888577020596", latest: 15 },
  "ap-east-2": { account: "412664885777", latest: 4 },
  "ap-northeast-1": { account: "615299751070", latest: 15 },
  "ap-northeast-2": { account: "615299751070", latest: 15 },
  "ap-northeast-3": { account: "615299751070", latest: 15 },
  "ap-south-1": { account: "615299751070", latest: 15 },
  "ap-south-2": { account: "796973505492", latest: 15 },
  "ap-southeast-1": { account: "615299751070", latest: 15 },
  "ap-southeast-2": { account: "615299751070", latest: 15 },
  "ap-southeast-3": { account: "039612877180", latest: 15 },
  "ap-southeast-4": { account: "713881805771", latest: 15 },
  "ap-southeast-5": { account: "152034782359", latest: 8 },
  "ap-southeast-6": { account: "313828097273", latest: 3 },
  "ap-southeast-7": { account: "980416031188", latest: 8 },
  "ca-central-1": { account: "615299751070", latest: 15 },
  "ca-west-1": { account: "595944127152", latest: 8 },
  "cn-north-1": { account: "440179912924", latest: 8 },
  "cn-northwest-1": { account: "440180067931", latest: 8 },
  "eu-central-1": { account: "615299751070", latest: 15 },
  "eu-central-2": { account: "156041407956", latest: 15 },
  "eu-north-1": { account: "615299751070", latest: 15 },
  "eu-south-1": { account: "257394471194", latest: 15 },
  "eu-south-2": { account: "490004653786", latest: 15 },
  "eu-west-1": { account: "615299751070", latest: 15 },
  "eu-west-2": { account: "615299751070", latest: 15 },
  "eu-west-3": { account: "615299751070", latest: 15 },
  "il-central-1": { account: "746669239226", latest: 15 },
  "me-central-1": { account: "739275441131", latest: 15 },
  "me-south-1": { account: "980921751758", latest: 12 },
  "mx-central-1": { account: "610118373846", latest: 8 },
  "sa-east-1": { account: "615299751070", latest: 15 },
  "us-east-1": { account: "615299751070", latest: 15 },
  "us-east-2": { account: "615299751070", latest: 15 },
  "us-west-1": { account: "615299751070", latest: 15 },
  "us-west-2": { account: "615299751070", latest: 15 },
};

const RELEASES_URL = "https://github.com/aws-observability/aws-otel-js-instrumentation/releases";

function partitionOf(region: string): string {
  if (region.startsWith("cn-")) return "aws-cn";
  // GovCloud には AWSOpenTelemetryDistroJs が公開されていない（upstream release table に
  // us-gov-* の項が無い）。partition 判定は残し、実際の失敗は OTEL_LAYER_TABLE の
  // 「not published」エラーに委ねる — 誤った arn:aws-us-gov ARN を生成しないことが目的。
  if (region.startsWith("us-gov-")) return "aws-us-gov";
  return "aws";
}

/** region に実際に deploy できる layer version。pin が未公開の region では公開最新に落とす。 */
function layerVersionFor(region: string, version: number): number {
  const entry = OTEL_LAYER_TABLE[region];
  if (entry === undefined) {
    throw new Error(
      `otelLayerArn: ${OTEL_LAYER_NAME} is not published in ${region}. ` +
        `See the release table: ${RELEASES_URL}`,
    );
  }
  return Math.min(version, entry.latest);
}

/**
 * region 確定済みなら ARN を synth 時に解決する。token region（env 未指定の stack）なら
 * `CfnMapping` にテーブルを載せて deploy 時の `Fn::FindInMap` に委ねる — どちらでも
 * 実在しない account/version の ARN は生成しない。pin がその region で未公開なら
 * 公開最新に落として警告を出す。
 */
export function otelLayerArn(scope: cdk.Stack, version: number = OTEL_LAYER_VERSION): string {
  const region = scope.region;
  if (!cdk.Token.isUnresolved(region)) {
    const effective = layerVersionFor(region, version);
    if (effective < version) {
      cdk.Annotations.of(scope).addWarning(
        `${OTEL_LAYER_NAME}:${version} is not published in ${region}; falling back to :${effective}.` +
          (effective < MIN_ADOT_LAYER_VERSION
            ? " This is below sekimori's supported minimum — the probe validates an older layer."
            : ""),
      );
    }
    return `arn:${partitionOf(region)}:lambda:${region}:${OTEL_LAYER_TABLE[region]?.account}:layer:${OTEL_LAYER_NAME}:${effective}`;
  }
  // env-agnostic stack でも clamp を静かに埋め込まない — pin 未公開 region を synth 時に警告する。
  const clamped = Object.keys(OTEL_LAYER_TABLE).filter(
    (r) => OTEL_LAYER_TABLE[r] !== undefined && OTEL_LAYER_TABLE[r].latest < version,
  );
  if (clamped.length > 0) {
    const belowMin = clamped.filter(
      (r) => (OTEL_LAYER_TABLE[r]?.latest ?? 0) < MIN_ADOT_LAYER_VERSION,
    );
    cdk.Annotations.of(scope).addWarning(
      `${OTEL_LAYER_NAME}:${version} is not published in ${clamped.join(", ")} — deploys there fall back to older versions.` +
        (belowMin.length > 0
          ? ` ${belowMin.join(", ")} fall below sekimori's supported minimum (:${MIN_ADOT_LAYER_VERSION}).`
          : ""),
    );
  }
  // env-agnostic stack で instrumentLambda が複数関数に呼ばれても duplicate construct id に
  // ならないよう、同じ version の mapping は既存 child を再利用する。
  const mappingId = `AdotLayerRegionsV${version}`;
  const mapping =
    (scope.node.tryFindChild(mappingId) as cdk.CfnMapping | undefined) ??
    new cdk.CfnMapping(scope, mappingId, {
      mapping: Object.fromEntries(
        Object.entries(OTEL_LAYER_TABLE).map(([r, v]) => [
          r,
          // CFN Mapping の値は String のみ有効 — number のまま Fn::Sub に渡すと deploy 時に解決失敗する。
          { account: v.account, version: String(layerVersionFor(r, version)) },
        ]),
      ),
    });
  return cdk.Fn.sub(
    // biome-ignore lint/suspicious/noTemplateCurlyInString: ${} は CloudFormation Fn::Sub の構文
    "arn:${AWS::Partition}:lambda:${AWS::Region}:${Acct}:layer:${LayerName}:${Ver}",
    {
      Acct: mapping.findInMap(cdk.Aws.REGION, "account"),
      LayerName: OTEL_LAYER_NAME,
      Ver: mapping.findInMap(cdk.Aws.REGION, "version"),
    },
  );
}

/**
 * SG 2026 デッキの helper をそのまま再現する: X-Ray active tracing を要求し、layer・wrapper・
 * service name・Application Signals の managed policy を配線する。「設定は規約ではなくコードで強制する」。
 */
export function instrumentLambda(fn: lambda.Function, serviceName: string): void {
  const cfn = fn.node.defaultChild as lambda.CfnFunction;
  const tracing = cdk.Stack.of(fn).resolve(cfn.tracingConfig) as { mode?: string } | undefined;
  if (tracing?.mode !== "Active") {
    throw new Error(
      `instrumentLambda(${fn.node.path}): set tracing: lambda.Tracing.ACTIVE at creation. ` +
        "PassThrough would make the ADOT layer parent on an unsampled context.",
    );
  }
  fn.addLayers(
    lambda.LayerVersion.fromLayerVersionArn(fn, "AdotLayer", otelLayerArn(cdk.Stack.of(fn))),
  );
  fn.addEnvironment("AWS_LAMBDA_EXEC_WRAPPER", "/opt/otel-instrument");
  fn.addEnvironment("OTEL_SERVICE_NAME", serviceName);
  fn.role?.addManagedPolicy(
    iam.ManagedPolicy.fromAwsManagedPolicyName(
      "CloudWatchLambdaApplicationSignalsExecutionRolePolicy",
    ),
  );
}
