import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { describe, expect, it } from "vitest";
import { instrumentLambda, otelLayerArn } from "./lib/instrument-lambda.js";
import { enableTransactionSearch } from "./lib/probe-stack.js";

function fn(stack: cdk.Stack, id: string): lambda.Function {
  return new lambda.Function(stack, id, {
    runtime: lambda.Runtime.NODEJS_22_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => {}"),
    tracing: lambda.Tracing.ACTIVE,
  });
}

describe("instrumentLambda", () => {
  it("reuses the CfnMapping when instrumenting multiple functions on an env-agnostic stack", () => {
    const app = new cdk.App();
    // env 未指定 = region が token — CfnMapping + Fn::FindInMap 経路を通る
    const stack = new cdk.Stack(app, "Probe");
    instrumentLambda(fn(stack, "A"), "svc-a");
    instrumentLambda(fn(stack, "B"), "svc-b");
    const template = Template.fromStack(stack).toJSON() as {
      Mappings?: Record<string, Record<string, { account?: unknown; version?: unknown }>>;
    };
    const mappings = Object.values(template.Mappings ?? {});
    expect(mappings).toHaveLength(1);
    // CFN Mapping の値は String のみ有効 — version が number で残ると deploy 時に失敗する。
    for (const region of Object.values(mappings[0] ?? {})) {
      expect(typeof region.account).toBe("string");
      expect(typeof region.version).toBe("string");
    }
  });

  it("resolves a concrete region to the correct account ARN at synth time", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "Probe", {
      env: { account: "123456789012", region: "ap-east-1" },
    });
    const arn = otelLayerArn(stack);
    // ap-east-1 の ADOT layer は account 888577020596（公式 release table）
    expect(arn).toBe("arn:aws:lambda:ap-east-1:888577020596:layer:AWSOpenTelemetryDistroJs:15");
  });

  it("clamps to the published latest when the pin is not released in that region", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "Probe", {
      env: { account: "123456789012", region: "me-south-1" },
    });
    // me-south-1 の公開最新は :12 — pin :15 は落とされる
    expect(otelLayerArn(stack)).toBe(
      "arn:aws:lambda:me-south-1:980921751758:layer:AWSOpenTelemetryDistroJs:12",
    );
  });

  it("throws on a region where the layer is not published at all", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "Probe", {
      env: { account: "123456789012", region: "xx-fake-1" },
    });
    expect(() => otelLayerArn(stack)).toThrow(/not published in xx-fake-1/);
  });
});

describe("enableTransactionSearch", () => {
  const env = { account: "123456789012", region: "ap-northeast-1" };

  it("creates TransactionSearchConfig AND the Logs resource policy", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "Probe", { env });
    enableTransactionSearch(stack);
    const template = Template.fromStack(stack);
    template.resourceCountIs("AWS::XRay::TransactionSearchConfig", 1);
    // X-Ray が aws/spans log-group へ span を書けるようにする policy が必須。
    // Config だけでは span は届かない（AWS CloudFormation ガイド）。
    template.resourceCountIs("AWS::Logs::ResourcePolicy", 1);
    const resources = template.toJSON().Resources as Record<
      string,
      { Type: string; Properties: { PolicyDocument: unknown } }
    >;
    const policy = Object.values(resources).find((r) => r.Type === "AWS::Logs::ResourcePolicy");
    // partition は token のため PolicyDocument は Fn::Join で分解されている。
    // { Ref: "AWS::Partition" } を "aws" に畳んで復元する。
    const join = (policy?.Properties.PolicyDocument as { "Fn::Join": [string, unknown[]] })?.[
      "Fn::Join"
    ];
    const joined = join?.[1].map((part) => (typeof part === "string" ? part : "aws")).join(join[0]);
    const doc = JSON.parse(joined ?? "{}") as {
      Statement: Array<{
        Effect: string;
        Principal: { Service: string };
        Action: string;
        Resource: unknown[];
        Condition: Record<string, unknown>;
      }>;
    };
    expect(doc.Statement).toHaveLength(1);
    const stmt = doc.Statement[0];
    expect(stmt?.Effect).toBe("Allow");
    expect(stmt?.Principal.Service).toBe("xray.amazonaws.com");
    expect(stmt?.Action).toBe("logs:PutLogEvents");
    // aws/spans だけでなく Application Signals の data log-group も対象に含む。
    expect(stmt?.Resource.join(" ")).toContain("log-group:aws/spans:*");
    expect(stmt?.Resource.join(" ")).toContain("/aws/application-signals/data:*");
    expect(stmt?.Condition.StringEquals).toMatchObject({
      "aws:SourceAccount": "123456789012",
    });
  });
});
