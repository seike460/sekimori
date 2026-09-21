import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeTemplate,
  analyzeTemplateFile,
  formatDoctorReport,
  MIN_ADOT_LAYER_VERSION,
} from "../src/index.js";

/** 実行時ガード検証用の「型の嘘」を意図込みで名付けるキャスト。 */
const asMalformed = (value: unknown): never => value as never;

const GOOD_FUNCTION = {
  Type: "AWS::Lambda::Function",
  Properties: {
    FunctionName: "fn-good",
    TracingConfig: { Mode: "Active" },
    Layers: [
      `arn:aws:lambda:ap-northeast-1:615299751070:layer:AWSOpenTelemetryDistroJs:${MIN_ADOT_LAYER_VERSION}`,
    ],
    Environment: {
      Variables: {
        AWS_LAMBDA_EXEC_WRAPPER: "/opt/otel-instrument",
        OTEL_SERVICE_NAME: "orders",
      },
    },
    Role: { "Fn::GetAtt": ["RoleX", "Arn"] },
  },
};

const ROLE = {
  Type: "AWS::IAM::Role",
  Properties: {
    ManagedPolicyArns: [
      "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
      "arn:aws:iam::aws:policy/CloudWatchLambdaApplicationSignalsExecutionRolePolicy",
    ],
  },
};

describe("analyzeTemplate", () => {
  it("passes a fully instrumented function", () => {
    const report = analyzeTemplate({
      Resources: { Fn: GOOD_FUNCTION, RoleX: ROLE },
    });
    const fn = report.functions[0];
    expect(fn?.name).toBe("fn-good");
    expect(fn?.checks.every((c) => c.status === "pass")).toBe(true);
  });

  it("fails when tracing is PassThrough and the ADOT layer is missing", () => {
    const report = analyzeTemplate({
      Resources: {
        Fn: {
          Type: "AWS::Lambda::Function",
          Properties: {
            TracingConfig: { Mode: "PassThrough" },
            Environment: { Variables: {} },
            Role: { "Fn::GetAtt": ["RoleX", "Arn"] },
          },
        },
        RoleX: ROLE,
      },
    });
    const checks = Object.fromEntries(
      report.functions[0]?.checks.map((c) => [c.id, c.status]) ?? [],
    );
    expect(checks.tracing).toBe("fail");
    expect(checks["adot-layer"]).toBe("fail");
    expect(checks["exec-wrapper"]).toBe("warn");
    expect(checks["service-name"]).toBe("warn");
    expect(checks["xray-iam"]).toBe("pass");
  });

  it("warns on an old ADOT layer and a propagators list missing xray or baggage", () => {
    const report = analyzeTemplate({
      Resources: {
        Fn: {
          Type: "AWS::Lambda::Function",
          Properties: {
            TracingConfig: { Mode: "Active" },
            Layers: ["arn:aws:lambda:ap-northeast-1:615299751070:layer:AWSOpenTelemetryDistroJs:5"],
            Environment: {
              Variables: {
                AWS_LAMBDA_EXEC_WRAPPER: "/opt/otel-instrument",
                OTEL_PROPAGATORS: "tracecontext,baggage",
              },
            },
          },
        },
      },
    });
    const checks = Object.fromEntries(
      report.functions[0]?.checks.map((c) => [c.id, c.status]) ?? [],
    );
    expect(checks["adot-layer"]).toBe("warn");
    expect(checks.propagators).toBe("warn");
    expect(checks["xray-iam"]).toBe("warn"); // Role が解決できない
  });

  it("warns when the propagators list drops baggage", () => {
    const report = analyzeTemplate({
      Resources: {
        Fn: {
          ...GOOD_FUNCTION,
          Properties: {
            ...GOOD_FUNCTION.Properties,
            Environment: {
              Variables: {
                ...GOOD_FUNCTION.Properties.Environment?.Variables,
                OTEL_PROPAGATORS: "tracecontext,xray",
              },
            },
          },
        },
        RoleX: ROLE,
      },
    });
    const checks = Object.fromEntries(
      report.functions[0]?.checks.map((c) => [c.id, c.status]) ?? [],
    );
    expect(checks.propagators).toBe("warn");
  });

  it("fails xray-iam when an explicit Deny overrides an Allow", () => {
    const report = analyzeTemplate({
      Resources: {
        Fn: GOOD_FUNCTION,
        RoleX: {
          Type: "AWS::IAM::Role",
          Properties: {
            Policies: [
              {
                PolicyName: "mixed",
                PolicyDocument: {
                  Statement: [
                    { Effect: "Allow", Action: "xray:*", Resource: "*" },
                    { Effect: "Deny", Action: "xray:PutTraceSegments", Resource: "*" },
                  ],
                },
              },
            ],
          },
        },
      },
    });
    const checks = Object.fromEntries(
      report.functions[0]?.checks.map((c) => [c.id, c.status]) ?? [],
    );
    expect(checks["xray-iam"]).toBe("fail");
  });

  it("fails xray-iam when the role has policies but none allow PutTraceSegments", () => {
    const report = analyzeTemplate({
      Resources: {
        Fn: GOOD_FUNCTION,
        RoleX: {
          Type: "AWS::IAM::Role",
          Properties: {
            ManagedPolicyArns: ["arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"],
          },
        },
      },
    });
    const checks = Object.fromEntries(
      report.functions[0]?.checks.map((c) => [c.id, c.status]) ?? [],
    );
    expect(checks["xray-iam"]).toBe("fail");
  });

  it("reports inline policies that allow xray writes", () => {
    const report = analyzeTemplate({
      Resources: {
        Fn: GOOD_FUNCTION,
        RoleX: {
          Type: "AWS::IAM::Role",
          Properties: {
            Policies: [
              {
                PolicyName: "xray",
                PolicyDocument: {
                  Statement: [
                    { Effect: "Allow", Action: ["xray:PutTraceSegments"], Resource: "*" },
                  ],
                },
              },
            ],
          },
        },
      },
    });
    const checks = Object.fromEntries(
      report.functions[0]?.checks.map((c) => [c.id, c.status]) ?? [],
    );
    expect(checks["xray-iam"]).toBe("pass");
  });

  it("warns xray-iam when a statement uses NotAction (undecidable beats allow)", () => {
    const report = analyzeTemplate({
      Resources: {
        Fn: GOOD_FUNCTION,
        RoleX: {
          Type: "AWS::IAM::Role",
          Properties: {
            Policies: [
              {
                PolicyName: "mixed",
                PolicyDocument: {
                  Statement: [
                    { Effect: "Allow", Action: "xray:*", Resource: "*" },
                    { Effect: "Deny", NotAction: "s3:*", Resource: "*" },
                  ],
                },
              },
            ],
          },
        },
      },
    });
    const check = report.functions[0]?.checks.find((c) => c.id === "xray-iam");
    // NotAction を含む statement は Deny かもしれない — pass にはせず warn で手動確認に回す
    expect(check?.status).toBe("warn");
  });

  it("follows a Ref to an in-template AWS::IAM::ManagedPolicy", () => {
    const report = analyzeTemplate({
      Resources: {
        Fn: GOOD_FUNCTION,
        RoleX: {
          Type: "AWS::IAM::Role",
          Properties: { ManagedPolicyArns: [{ Ref: "Mp" }] },
        },
        Mp: {
          Type: "AWS::IAM::ManagedPolicy",
          Properties: {
            PolicyDocument: {
              Statement: [{ Effect: "Allow", Action: ["xray:PutTraceSegments"], Resource: "*" }],
            },
          },
        },
      },
    });
    const check = report.functions[0]?.checks.find((c) => c.id === "xray-iam");
    expect(check?.status).toBe("pass");
  });

  it("fails xray-iam when an inline Deny overrides a managed-policy allow", () => {
    const report = analyzeTemplate({
      Resources: {
        Fn: GOOD_FUNCTION,
        RoleX: {
          Type: "AWS::IAM::Role",
          Properties: {
            ManagedPolicyArns: ["arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess"],
            Policies: [
              {
                PolicyName: "deny",
                PolicyDocument: {
                  Statement: [{ Effect: "Deny", Action: "xray:PutTraceSegments", Resource: "*" }],
                },
              },
            ],
          },
        },
      },
    });
    const check = report.functions[0]?.checks.find((c) => c.id === "xray-iam");
    expect(check?.status).toBe("fail");
  });

  it("downgrades env checks to warn when the value is an intrinsic", () => {
    const report = analyzeTemplate({
      Resources: {
        Fn: {
          ...GOOD_FUNCTION,
          Properties: {
            ...GOOD_FUNCTION.Properties,
            Environment: {
              Variables: {
                AWS_LAMBDA_EXEC_WRAPPER: { Ref: "WrapperParam" },
                OTEL_PROPAGATORS: { "Fn::Sub": "tracecontext,xray,baggage" },
              },
            },
          },
        },
        RoleX: ROLE,
      },
    });
    const checks = Object.fromEntries(
      report.functions[0]?.checks.map((c) => [c.id, c.status]) ?? [],
    );
    expect(checks["exec-wrapper"]).toBe("warn");
    expect(checks.propagators).toBe("warn");
    expect(checks["xray-iam"]).toBe("pass");
  });

  it("warns adot-layer when layer references are intrinsic", () => {
    const report = analyzeTemplate({
      Resources: {
        Fn: {
          ...GOOD_FUNCTION,
          Properties: {
            ...GOOD_FUNCTION.Properties,
            Layers: [{ "Fn::ImportValue": "AdotLayerArn" }],
          },
        },
        RoleX: ROLE,
      },
    });
    const check = report.functions[0]?.checks.find((c) => c.id === "adot-layer");
    expect(check?.status).toBe("warn");
  });

  it("warns xray-iam when the managed-policy list itself is an intrinsic", () => {
    const report = analyzeTemplate({
      Resources: {
        Fn: GOOD_FUNCTION,
        RoleX: {
          Type: "AWS::IAM::Role",
          Properties: {
            ManagedPolicyArns: {
              "Fn::If": [
                "IsProd",
                ["arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess"],
                { Ref: "AWS::NoValue" },
              ],
            },
          },
        },
      },
    });
    const check = report.functions[0]?.checks.find((c) => c.id === "xray-iam");
    expect(check?.status).toBe("warn");
  });

  it("resolves a Fn::GetAtt role reference in string form (YAML shorthand)", () => {
    const report = analyzeTemplate({
      Resources: {
        Fn: {
          ...GOOD_FUNCTION,
          Properties: { ...GOOD_FUNCTION.Properties, Role: { "Fn::GetAtt": "RoleX.Arn" } },
        },
        RoleX: ROLE,
      },
    });
    const check = report.functions[0]?.checks.find((c) => c.id === "xray-iam");
    expect(check?.status).toBe("pass");
  });

  it("does not fail ADOT checks on a non-Node.js runtime or an image package", () => {
    for (const extra of [{ Runtime: "python3.12" }, { PackageType: "Image" }]) {
      const report = analyzeTemplate({
        Resources: {
          Fn: {
            Type: "AWS::Lambda::Function",
            Properties: {
              FunctionName: "fn-py",
              TracingConfig: { Mode: "Active" },
              Environment: { Variables: {} },
              ...extra,
            },
          },
          RoleX: ROLE,
        },
      });
      const checks = Object.fromEntries(
        report.functions[0]?.checks.map((c) => [c.id, c.status]) ?? [],
      );
      // JS の ADOT layer / exec wrapper は適用外 — fail ではなく warn（要手動確認）に倒す
      expect(checks["adot-layer"]).toBe("warn");
      expect(checks["exec-wrapper"]).toBe("warn");
      expect(checks.tracing).toBe("pass");
    }
  });

  it("warns xray-iam when Role refs a non-role resource", () => {
    const report = analyzeTemplate({
      Resources: {
        Fn: {
          ...GOOD_FUNCTION,
          Properties: { ...GOOD_FUNCTION.Properties, Role: { Ref: "Queue" } },
        },
        Queue: { Type: "AWS::SQS::Queue" },
      },
    });
    const check = report.functions[0]?.checks.find((c) => c.id === "xray-iam");
    expect(check?.status).toBe("warn");
  });

  it("fails xray-iam when a PermissionsBoundary lacks xray write", () => {
    const report = analyzeTemplate({
      Resources: {
        Fn: GOOD_FUNCTION,
        RoleX: {
          Type: "AWS::IAM::Role",
          Properties: {
            ManagedPolicyArns: ["arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess"],
            PermissionsBoundary: "arn:aws:iam::aws:policy/ReadOnlyAccess",
          },
        },
      },
    });
    const check = report.functions[0]?.checks.find((c) => c.id === "xray-iam");
    expect(check?.status).toBe("fail");
  });

  it("warns xray-iam when a PermissionsBoundary cannot be evaluated", () => {
    const report = analyzeTemplate({
      Resources: {
        Fn: GOOD_FUNCTION,
        RoleX: {
          Type: "AWS::IAM::Role",
          Properties: {
            ManagedPolicyArns: ["arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess"],
            PermissionsBoundary: { Ref: "BoundaryParam" },
          },
        },
      },
    });
    const check = report.functions[0]?.checks.find((c) => c.id === "xray-iam");
    expect(check?.status).toBe("warn");
  });

  it("warns xray-iam on an unlisted AWS managed policy instead of a false fail", () => {
    const report = analyzeTemplate({
      Resources: {
        Fn: GOOD_FUNCTION,
        RoleX: {
          Type: "AWS::IAM::Role",
          Properties: {
            // カタログ未収録の AWS managed policy — xray を含むか判別できない
            ManagedPolicyArns: ["arn:aws:iam::aws:policy/SomeNewFuturePolicy"],
          },
        },
      },
    });
    const check = report.functions[0]?.checks.find((c) => c.id === "xray-iam");
    expect(check?.status).toBe("warn");
  });

  it("survives null / malformed resource entries", () => {
    const report = analyzeTemplate({
      Resources: asMalformed({
        Fn: GOOD_FUNCTION,
        RoleX: ROLE,
        Broken: null,
        AlsoBroken: "not an object",
      }),
    });
    const fn = report.functions[0];
    expect(fn?.checks.every((c) => c.status === "pass")).toBe(true);
  });

  it("names the matching with*Record helper for a Kinesis event source", () => {
    const report = analyzeTemplate({
      Resources: {
        Fn: GOOD_FUNCTION,
        RoleX: ROLE,
        Esm: {
          Type: "AWS::Lambda::EventSourceMapping",
          Properties: {
            EventSourceArn: "arn:aws:kinesis:ap-northeast-1:123456789012:stream/events",
          },
        },
      },
    });
    expect(report.notes.some((n) => n.includes("withKinesisRecord"))).toBe(true);
  });

  it("adds notes for event sources and transaction search", () => {
    const report = analyzeTemplate({
      Resources: {
        Fn: GOOD_FUNCTION,
        RoleX: ROLE,
        Esm: { Type: "AWS::Lambda::EventSourceMapping", Properties: {} },
        Txn: { Type: "AWS::XRay::TransactionSearchConfig", Properties: {} },
      },
    });
    expect(report.notes.some((n) => n.includes("withSqsRecord"))).toBe(true);
    expect(report.notes.some((n) => n.includes("Transaction Search configured"))).toBe(true);
  });

  it("treats Ref AWS::NoValue entries as unset instead of unresolvable", () => {
    const report = analyzeTemplate({
      Resources: {
        Fn: GOOD_FUNCTION,
        RoleX: {
          Type: "AWS::IAM::Role",
          Properties: {
            ManagedPolicyArns: [
              "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess",
              { Ref: "AWS::NoValue" },
            ],
            PermissionsBoundary: { Ref: "AWS::NoValue" },
          },
        },
      },
    });
    const check = report.functions[0]?.checks.find((c) => c.id === "xray-iam");
    expect(check?.status).toBe("pass");
  });

  it("warns adot-layer and exec-wrapper when Runtime is an intrinsic", () => {
    const report = analyzeTemplate({
      Resources: {
        Fn: {
          Type: "AWS::Lambda::Function",
          Properties: {
            ...GOOD_FUNCTION.Properties,
            Runtime: { Ref: "RuntimeParam" },
          },
        },
        RoleX: ROLE,
      },
    });
    const fn = report.functions[0];
    expect(fn?.checks.find((c) => c.id === "adot-layer")?.status).toBe("warn");
    expect(fn?.checks.find((c) => c.id === "adot-layer")?.message).toContain("intrinsic");
    expect(fn?.checks.find((c) => c.id === "exec-wrapper")?.status).toBe("warn");
  });

  it("evaluates AWS::Serverless::Function resources (SAM)", () => {
    const report = analyzeTemplate({
      Resources: {
        Fn: {
          Type: "AWS::Serverless::Function",
          Properties: {
            FunctionName: "sam-fn",
            Tracing: "Active",
            Runtime: "nodejs24.x",
            Layers: [
              `arn:aws:lambda:ap-northeast-1:615299751070:layer:AWSOpenTelemetryDistroJs:${MIN_ADOT_LAYER_VERSION}`,
            ],
            Environment: {
              Variables: {
                AWS_LAMBDA_EXEC_WRAPPER: "/opt/otel-instrument",
                OTEL_SERVICE_NAME: "orders",
              },
            },
            // Role 未指定 → SAM default role + Policies。managed policy 名の文字列を受理する。
            Policies: ["AWSXRayWriteOnlyAccess"],
          },
        },
      },
    });
    const fn = report.functions[0];
    expect(fn?.name).toBe("sam-fn");
    expect(fn?.checks.every((c) => c.status === "pass")).toBe(true);
    expect(report.notes.some((n) => n.includes("Serverless::Function"))).toBe(true);
  });

  it("fails xray-iam for a SAM function on the generated default role", () => {
    // Role も Policies も無い SAM function → default role = BasicExecutionRole のみ。
    const report = analyzeTemplate({
      Resources: {
        Fn: {
          Type: "AWS::Serverless::Function",
          Properties: { FunctionName: "sam-bare", Runtime: "nodejs24.x" },
        },
      },
    });
    const check = report.functions[0]?.checks.find((c) => c.id === "xray-iam");
    expect(check?.status).toBe("fail");
  });

  it("applies SAM Globals.Function properties to Serverless functions", () => {
    const report = analyzeTemplate({
      Globals: {
        Function: {
          Runtime: "nodejs24.x",
          Tracing: "Active",
          Layers: [
            `arn:aws:lambda:ap-northeast-1:615299751070:layer:AWSOpenTelemetryDistroJs:${MIN_ADOT_LAYER_VERSION}`,
          ],
          Environment: {
            Variables: {
              AWS_LAMBDA_EXEC_WRAPPER: "/opt/otel-instrument",
              OTEL_SERVICE_NAME: "orders",
            },
          },
        },
      },
      Resources: {
        Fn: {
          Type: "AWS::Serverless::Function",
          Properties: { FunctionName: "sam-globals", Policies: ["AWSXRayWriteOnlyAccess"] },
        },
      },
    });
    const fn = report.functions[0];
    expect(fn?.checks.every((c) => c.status === "pass")).toBe(true);
  });

  it("formats a readable report", () => {
    const report = analyzeTemplate({ Resources: { Fn: GOOD_FUNCTION, RoleX: ROLE } });
    const text = formatDoctorReport(report);
    expect(text).toContain("fn-good");
    expect(text).toContain("PASS tracing");
  });

  it("merges SAM Globals lists and maps instead of overwriting them (R5-B-2)", () => {
    // list は global 先行の連結、map（Environment.Variables）は再帰 merge。
    // function 側に Layers/Variables があると旧実装は global 側を丸ごと落とした。
    const report = analyzeTemplate({
      Globals: {
        Function: {
          Runtime: "nodejs24.x",
          Tracing: "Active",
          Layers: [
            `arn:aws:lambda:ap-northeast-1:615299751070:layer:AWSOpenTelemetryDistroJs:${MIN_ADOT_LAYER_VERSION}`,
          ],
          Environment: {
            Variables: { AWS_LAMBDA_EXEC_WRAPPER: "/opt/otel-instrument" },
          },
        },
      },
      Resources: {
        Fn: {
          Type: "AWS::Serverless::Function",
          Properties: {
            FunctionName: "sam-merge",
            Layers: ["arn:aws:lambda:ap-northeast-1:901920631463:layer:other:1"],
            Environment: { Variables: { OTEL_SERVICE_NAME: "orders" } },
            Policies: ["AWSXRayWriteOnlyAccess"],
          },
        },
      },
    });
    const fn = report.functions[0];
    // ADOT layer（global）と exec wrapper（global）・service name（own）の全てが見える。
    expect(fn?.checks.find((c) => c.id === "adot-layer")?.status).toBe("pass");
    expect(fn?.checks.find((c) => c.id === "exec-wrapper")?.status).toBe("pass");
    expect(fn?.checks.find((c) => c.id === "service-name")?.status).toBe("pass");
  });

  it("lets a function-level scalar override a global (R5-B-2)", () => {
    // `Tracing: "PassThrough"` on the function beats the global `"Active"`.
    const report = analyzeTemplate({
      Globals: { Function: { Tracing: "Active", Runtime: "nodejs24.x" } },
      Resources: {
        Fn: {
          Type: "AWS::Serverless::Function",
          Properties: {
            FunctionName: "sam-override",
            Tracing: "PassThrough",
            Policies: ["AWSXRayWriteOnlyAccess"],
          },
        },
      },
    });
    const fn = report.functions[0];
    // PassThrough は ADOT layer が unsampled context に乗るため fail（Active への上書きで検証）。
    expect(fn?.checks.find((c) => c.id === "tracing")?.status).toBe("fail");
  });

  it("applies a SAM function PermissionsBoundary to the generated default role (R5-B-3)", () => {
    // Role 未指定 + boundary 無許可 — boundary は generated role にも効くため fail が正しい。
    const report = analyzeTemplate({
      Resources: {
        Fn: {
          Type: "AWS::Serverless::Function",
          Properties: {
            FunctionName: "sam-boundary",
            Runtime: "nodejs24.x",
            Policies: ["AWSXRayWriteOnlyAccess"],
            PermissionsBoundary: "arn:aws:iam::aws:policy/ReadOnlyAccess",
          },
        },
      },
    });
    const check = report.functions[0]?.checks.find((c) => c.id === "xray-iam");
    expect(check?.status).toBe("fail");
  });

  it("warns xray-iam when a SAM PermissionsBoundary cannot be evaluated (R5-B-3)", () => {
    const report = analyzeTemplate({
      Resources: {
        Fn: {
          Type: "AWS::Serverless::Function",
          Properties: {
            FunctionName: "sam-boundary-unres",
            Runtime: "nodejs24.x",
            Policies: ["AWSXRayWriteOnlyAccess"],
            PermissionsBoundary: { Ref: "BoundaryParam" },
          },
        },
      },
    });
    const check = report.functions[0]?.checks.find((c) => c.id === "xray-iam");
    // boundary 未解決のまま pass にしない。
    expect(check?.status).toBe("warn");
  });

  it("warns instead of failing when Properties itself is an intrinsic (R5-B-4)", () => {
    // `Properties: { "Fn::If": [...] }` — 全 property 解決不能。空として fail しない。
    const report = analyzeTemplate({
      Resources: {
        Fn: {
          Type: "AWS::Lambda::Function",
          Properties: {
            "Fn::If": ["IsProd", { TracingConfig: { Mode: "Active" } }, { Ref: "AWS::NoValue" }],
          },
        },
      },
    });
    const fn = report.functions[0];
    expect(fn?.checks.find((c) => c.id === "adot-layer")?.status).toBe("warn");
    expect(fn?.checks.find((c) => c.id === "exec-wrapper")?.status).toBe("warn");
  });
});

describe("analyzeTemplateFile", () => {
  it("rejects non-object JSON instead of treating it as a template", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sekimori-doctor-"));
    const cases: [string, string][] = [
      ["array.json", "[]"],
      ["null.json", "null"],
      ["string.json", '"x"'],
    ];
    for (const [name, body] of cases) {
      const path = join(dir, name);
      writeFileSync(path, body);
      await expect(analyzeTemplateFile(path)).rejects.toThrow("is not a CloudFormation template");
    }
  });
});

describe("Round-6 doctor fixes", () => {
  it("does not treat an intrinsic Environment as a concrete map (R6-B)", () => {
    // `Environment: { Fn::If: [...] }` は object なので asObject を通るが、
    // 値が一切読めない — 「env 未設定」と誤認して fail/pass しないよう warn に倒す。
    const report = analyzeTemplate({
      Resources: {
        Fn: {
          Type: "AWS::Lambda::Function",
          Properties: {
            FunctionName: "fn-intrinsic-env",
            Environment: { "Fn::If": ["IsProd", { Variables: {} }, { Ref: "AWS::NoValue" }] },
          },
        },
      },
    });
    const fn = report.functions[0];
    expect(fn?.checks.find((c) => c.id === "exec-wrapper")?.status).toBe("warn");
    expect(fn?.checks.find((c) => c.id === "exec-wrapper")?.message).toContain("intrinsic");
    expect(fn?.checks.find((c) => c.id === "service-name")?.status).toBe("warn");
  });

  it("does not treat an intrinsic Environment.Variables as a concrete map (R6-B)", () => {
    const report = analyzeTemplate({
      Resources: {
        Fn: {
          Type: "AWS::Lambda::Function",
          Properties: {
            FunctionName: "fn-intrinsic-vars",
            Environment: { Variables: { "Fn::ImportValue": "SharedEnv" } },
          },
        },
      },
    });
    const fn = report.functions[0];
    expect(fn?.checks.find((c) => c.id === "exec-wrapper")?.status).toBe("warn");
    expect(fn?.checks.find((c) => c.id === "exec-wrapper")?.message).toContain("intrinsic");
  });

  it("treats a dropped intrinsic global Environment as unresolvable (R6-B)", () => {
    // Globals の Environment が `{Fn::If}` で merge 不能 → own 側だけ残すと
    // global に入っていた env var を読み落として false pass/fail する。
    const report = analyzeTemplate({
      Globals: {
        Function: {
          Environment: { "Fn::If": ["IsProd", { Variables: {} }, { Ref: "AWS::NoValue" }] },
        },
      },
      Resources: {
        Fn: {
          Type: "AWS::Serverless::Function",
          Properties: {
            FunctionName: "sam-intrinsic-global-env",
            Environment: { Variables: { OTEL_SERVICE_NAME: "orders" } },
          },
        },
      },
    });
    const fn = report.functions[0];
    expect(fn?.checks.find((c) => c.id === "exec-wrapper")?.status).toBe("warn");
    expect(fn?.checks.find((c) => c.id === "exec-wrapper")?.message).toContain("intrinsic");
  });

  it("ignores Globals.Function.Policies — SAM does not support it there (R7-B)", () => {
    // `Policies` は SAM Globals.Function の非対応 key。merge してしまうと
    // 実際には効かない policy で xray-iam が pass になる（false pass）。
    const report = analyzeTemplate({
      Globals: { Function: { Policies: { "Fn::If": ["IsProd", [], { Ref: "AWS::NoValue" }] } } },
      Resources: {
        Fn: {
          Type: "AWS::Serverless::Function",
          Properties: {
            FunctionName: "sam-intrinsic-global-policies",
            Policies: ["AWSXRayWriteOnlyAccess"],
          },
        },
      },
    });
    const fn = report.functions[0];
    // global Policies は無視され、own の AWSXRayWriteOnlyAccess で素直に pass。
    expect(fn?.checks.find((c) => c.id === "xray-iam")?.status).toBe("pass");
    // かつ非対応 key は note で報告する（deploy 時に SAM がエラーにするため）。
    expect(report.notes.some((n) => n.includes("unsupported keys") && n.includes("Policies"))).toBe(
      true,
    );
  });

  it("treats an IAM statement with Condition as undecidable (R6-B)", () => {
    // Condition 付き Allow は条件を満たさないと効かない → 無条件の allow とは断定できない。
    const report = analyzeTemplate({
      Resources: {
        Fn: {
          Type: "AWS::Lambda::Function",
          Properties: { FunctionName: "fn-cond", Role: { Ref: "RoleX" } },
        },
        RoleX: {
          Type: "AWS::IAM::Role",
          Properties: {
            Policies: [
              {
                PolicyName: "p",
                PolicyDocument: {
                  Statement: [
                    {
                      Effect: "Allow",
                      Action: "xray:PutTraceSegments",
                      Resource: "*",
                      Condition: { StringEquals: { "aws:PrincipalTag/team": "a" } },
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    });
    const fn = report.functions[0];
    expect(fn?.checks.find((c) => c.id === "xray-iam")?.status).toBe("warn");
  });
});

describe("Round-7 regression", () => {
  it("does not treat AWSLambda_FullAccess as xray write access (R7-B)", () => {
    // AWSLambda_FullAccess の xray action は GetTraceSummaries/BatchGetTraces のみで
    // xray:PutTraceSegments を含まない。allow-list 誤登録は xray-iam の false pass になる。
    const report = analyzeTemplate({
      Resources: {
        Fn: {
          Type: "AWS::Lambda::Function",
          Properties: { FunctionName: "fn-fullaccess", Role: { "Fn::GetAtt": ["RoleX", "Arn"] } },
        },
        RoleX: {
          Type: "AWS::IAM::Role",
          Properties: {
            ManagedPolicyArns: ["arn:aws:iam::aws:policy/AWSLambda_FullAccess"],
          },
        },
      },
    });
    const fn = report.functions[0];
    expect(fn?.checks.find((c) => c.id === "xray-iam")?.status).toBe("fail");
  });
});

describe("Round-8 regression", () => {
  const FN = {
    Type: "AWS::Lambda::Function",
    Properties: { FunctionName: "fn", Role: { "Fn::GetAtt": ["RoleX", "Arn"] } },
  };
  const ROLE_NO_XRAY = {
    Type: "AWS::IAM::Role",
    Properties: {
      ManagedPolicyArns: ["arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"],
    },
  };
  const XRAY_STMT = {
    Effect: "Allow",
    Action: "xray:PutTraceSegments",
    Resource: "*",
  };

  it("evaluates a standalone AWS::IAM::Policy attached via Roles (R8-B)", () => {
    // CDK の fn.addToRolePolicy() は standalone Policy リソースを生成する —
    // role 本体に policy が無くても effective permission に効く。
    const report = analyzeTemplate({
      Resources: {
        Fn: FN,
        RoleX: ROLE_NO_XRAY,
        FnPolicy: {
          Type: "AWS::IAM::Policy",
          Properties: {
            Roles: [{ Ref: "RoleX" }],
            PolicyDocument: { Version: "2012-10-17", Statement: [XRAY_STMT] },
          },
        },
      },
    });
    expect(report.functions[0]?.checks.find((c) => c.id === "xray-iam")?.status).toBe("pass");
  });

  it("honours an explicit Deny in a standalone AWS::IAM::Policy (R8-B)", () => {
    const report = analyzeTemplate({
      Resources: {
        Fn: FN,
        RoleX: {
          ...ROLE_NO_XRAY,
          Properties: {
            ...ROLE_NO_XRAY.Properties,
            ManagedPolicyArns: ["arn:aws:iam::aws:policy/AWSXRayWriteOnlyAccess"],
          },
        },
        DenyPolicy: {
          Type: "AWS::IAM::Policy",
          Properties: {
            Roles: [{ Ref: "RoleX" }],
            PolicyDocument: {
              Version: "2012-10-17",
              Statement: [{ Effect: "Deny", Action: "xray:*", Resource: "*" }],
            },
          },
        },
      },
    });
    expect(report.functions[0]?.checks.find((c) => c.id === "xray-iam")?.status).toBe("fail");
  });

  it("evaluates a standalone AWS::IAM::ManagedPolicy with Roles (R8-B)", () => {
    const report = analyzeTemplate({
      Resources: {
        Fn: FN,
        RoleX: ROLE_NO_XRAY,
        CustomerPolicy: {
          Type: "AWS::IAM::ManagedPolicy",
          Properties: {
            Roles: [{ Ref: "RoleX" }],
            PolicyDocument: { Version: "2012-10-17", Statement: [XRAY_STMT] },
          },
        },
      },
    });
    expect(report.functions[0]?.checks.find((c) => c.id === "xray-iam")?.status).toBe("pass");
  });

  it("treats a non-string Condition on a standalone policy as undecidable (R10-B)", () => {
    // resource 属性の `Condition` は CFN では文字列だが、malformed な値（object 等）
    // でも「条件付き作成」を無視して allow 評価するのは危険 — undecidable（warn）。
    const report = analyzeTemplate({
      Resources: {
        Fn: FN,
        RoleX: ROLE_NO_XRAY,
        CondPolicy: {
          Type: "AWS::IAM::Policy",
          Condition: { Ref: "SomeCondition" },
          Properties: {
            Roles: [{ Ref: "RoleX" }],
            PolicyDocument: { Version: "2012-10-17", Statement: [XRAY_STMT] },
          },
        },
      },
    });
    expect(report.functions[0]?.checks.find((c) => c.id === "xray-iam")?.status).toBe("warn");
  });

  it("treats an empty Statement list as no-allow rather than undecidable (R8-B)", () => {
    const report = analyzeTemplate({
      Resources: {
        Fn: FN,
        RoleX: {
          Type: "AWS::IAM::Role",
          Properties: {
            Policies: [{ PolicyName: "empty", PolicyDocument: { Statement: [] } }],
          },
        },
      },
    });
    // 評価できて許可が無い → fail（warn ではない）。
    expect(report.functions[0]?.checks.find((c) => c.id === "xray-iam")?.status).toBe("fail");
  });

  it("accepts a SAM Policies string (not only a list) (R8-B)", () => {
    const report = analyzeTemplate({
      Resources: {
        Fn: {
          Type: "AWS::Serverless::Function",
          Properties: {
            FunctionName: "sam-policies-str",
            Runtime: "nodejs24.x",
            Policies: "AWSXRayWriteOnlyAccess",
          },
        },
      },
    });
    expect(report.functions[0]?.checks.find((c) => c.id === "xray-iam")?.status).toBe("pass");
  });

  it("does not report newly supported SAM Globals keys as unsupported (R8-B)", () => {
    const report = analyzeTemplate({
      Globals: {
        Function: {
          CodeUri: "src/",
          Description: "fn",
          AutoPublishAlias: "live",
          DeploymentPreference: { Type: "Canary10Percent5Minutes" },
          RolePath: "/svc/",
          FunctionUrlConfig: { AuthType: "NONE" },
          RecursiveLoop: "Terminate",
          SourceKMSKeyArn: "arn:aws:kms:ap-northeast-1:1:key/x",
          PropagateTags: true,
          CodeSigningConfigArn: "arn:aws:lambda:ap-northeast-1:1:code-signing-config:x",
          AutoPublishAliasAllProperties: true,
        },
      },
      Resources: {
        Fn: {
          Type: "AWS::Serverless::Function",
          Properties: { FunctionName: "sam-globals", Runtime: "nodejs24.x" },
        },
      },
    });
    expect(report.notes.some((n) => n.includes("unsupported keys"))).toBe(false);
  });
});

describe("xray-iam policy verdict (R11-B)", () => {
  const FN = {
    Type: "AWS::Lambda::Function",
    Properties: {
      FunctionName: "fn",
      Runtime: "nodejs24.x",
      Role: { "Fn::GetAtt": ["RoleX", "Arn"] },
    },
  };

  it("treats a statement with a non-Allow/Deny Effect as undecidable, not no-allow", () => {
    // `Effect: "ALLOW"`（typo）を含む policy — 実は Deny かもしれないので skip せず
    // undecidable（warn）に倒す。fail に落とすと false fail になる。
    const report = analyzeTemplate({
      Resources: {
        Fn: FN,
        RoleX: {
          Type: "AWS::IAM::Role",
          Properties: {
            Policies: [
              {
                PolicyName: "p",
                PolicyDocument: {
                  Statement: [{ Effect: "ALLOW", Action: "xray:PutTraceSegments", Resource: "*" }],
                },
              },
            ],
          },
        },
      },
    });
    expect(report.functions[0]?.checks.find((c) => c.id === "xray-iam")?.status).toBe("warn");
  });
});
