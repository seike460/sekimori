import {
  GetPolicyCommand,
  GetPolicyVersionCommand,
  GetRoleCommand,
  GetRolePolicyCommand,
  type IAMClient,
  ListAttachedRolePoliciesCommand,
  ListRolePoliciesCommand,
} from "@aws-sdk/client-iam";
import type { LambdaClient } from "@aws-sdk/client-lambda";
import { describe, expect, it } from "vitest";
import { analyzeFunction, MIN_ADOT_LAYER_VERSION } from "../src/index.js";

describe("analyzeFunction (live)", () => {
  const GOOD_CONFIG = {
    FunctionName: "fn-live",
    TracingConfig: { Mode: "Active" },
    // GetFunctionConfiguration は Layers を [{ Arn }] の形で返す。
    Layers: [
      {
        Arn: `arn:aws:lambda:ap-northeast-1:615299751070:layer:AWSOpenTelemetryDistroJs:${MIN_ADOT_LAYER_VERSION}`,
      },
    ],
    Environment: {
      Variables: {
        AWS_LAMBDA_EXEC_WRAPPER: "/opt/otel-instrument",
        OTEL_SERVICE_NAME: "orders",
      },
    },
    Role: "arn:aws:iam::123456789012:role/fn-live-role",
  };

  // client の send は overload 群なので、テスト fake は最小形を名前付きキャストで包む。
  // キャストはこの2ヘルパーに閉じ込め、テスト本体では型安全な client として扱う。
  const lambdaOf = (config: object): LambdaClient =>
    ({ send: async () => config }) as unknown as LambdaClient;

  const iamOf = (handler: (cmd: unknown) => object | Promise<object>): IAMClient =>
    ({ send: (cmd: unknown) => Promise.resolve(handler(cmd)) }) as unknown as IAMClient;

  it("passes a fully instrumented function with a managed X-Ray policy", async () => {
    const iam = iamOf((cmd) => {
      if (cmd instanceof ListAttachedRolePoliciesCommand) {
        return {
          AttachedPolicies: [
            { PolicyName: "CloudWatchLambdaApplicationSignalsExecutionRolePolicy" },
          ],
        };
      }
      return {};
    });
    const report = await analyzeFunction("fn-live", {
      lambda: lambdaOf(GOOD_CONFIG),
      iam,
    });
    expect(report.name).toBe("fn-live");
    expect(report.checks.every((c) => c.status === "pass")).toBe(true);
  });

  it("checks inline policies when no managed X-Ray policy is attached", async () => {
    const doc = JSON.stringify({
      Statement: [{ Effect: "Allow", Action: ["xray:PutTraceSegments"], Resource: "*" }],
    });
    const iam = iamOf((cmd) => {
      if (cmd instanceof ListAttachedRolePoliciesCommand) return { AttachedPolicies: [] };
      if (cmd instanceof ListRolePoliciesCommand) return { PolicyNames: ["xray"] };
      if (cmd instanceof GetRolePolicyCommand) {
        return { PolicyDocument: encodeURIComponent(doc) };
      }
      return {};
    });
    const report = await analyzeFunction("fn-live", { lambda: lambdaOf(GOOD_CONFIG), iam });
    const check = report.checks.find((c) => c.id === "xray-iam");
    expect(check?.status).toBe("pass");
  });

  it("fails xray-iam when the role has no granting policy", async () => {
    const iam = iamOf((cmd) => {
      if (cmd instanceof ListAttachedRolePoliciesCommand) return { AttachedPolicies: [] };
      if (cmd instanceof ListRolePoliciesCommand) return { PolicyNames: [] };
      return {};
    });
    const report = await analyzeFunction("fn-live", { lambda: lambdaOf(GOOD_CONFIG), iam });
    const check = report.checks.find((c) => c.id === "xray-iam");
    expect(check?.status).toBe("fail");
  });

  it("warns xray-iam when the function has no role or IAM lookup fails", async () => {
    const noRole = await analyzeFunction("fn-live", {
      lambda: lambdaOf({ ...GOOD_CONFIG, Role: undefined }),
    });
    expect(noRole.checks.find((c) => c.id === "xray-iam")?.status).toBe("warn");

    const throwingIam = iamOf(() => Promise.reject(new Error("AccessDenied")));
    const denied = await analyzeFunction("fn-live", {
      lambda: lambdaOf(GOOD_CONFIG),
      iam: throwingIam,
    });
    expect(denied.checks.find((c) => c.id === "xray-iam")?.status).toBe("warn");
  });

  it("paginates ListAttachedRolePolicies — an allow on page 2 is still seen", async () => {
    let pages = 0;
    const iam = iamOf((cmd) => {
      if (cmd instanceof ListAttachedRolePoliciesCommand) {
        pages++;
        return pages === 1
          ? { AttachedPolicies: [], IsTruncated: true, Marker: "p2" }
          : {
              AttachedPolicies: [
                {
                  PolicyName: "AWSXRayDaemonWriteAccess",
                  PolicyArn: "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess",
                },
              ],
            };
      }
      return {};
    });
    const report = await analyzeFunction("fn-live", { lambda: lambdaOf(GOOD_CONFIG), iam });
    expect(pages).toBe(2);
    expect(report.checks.find((c) => c.id === "xray-iam")?.status).toBe("pass");
  });

  it("reads the policy document of an unknown managed policy instead of guessing", async () => {
    const doc = JSON.stringify({
      Statement: [{ Effect: "Allow", Action: "xray:PutTraceSegments", Resource: "*" }],
    });
    const iam = iamOf((cmd) => {
      if (cmd instanceof ListAttachedRolePoliciesCommand) {
        return {
          AttachedPolicies: [
            {
              PolicyName: "CustomCorpPolicy",
              PolicyArn: "arn:aws:iam::123456789012:policy/CustomCorpPolicy",
            },
          ],
        };
      }
      if (cmd instanceof GetPolicyCommand) return { Policy: { DefaultVersionId: "v1" } };
      if (cmd instanceof GetPolicyVersionCommand) {
        return { PolicyVersion: { Document: encodeURIComponent(doc) } };
      }
      return {};
    });
    const report = await analyzeFunction("fn-live", { lambda: lambdaOf(GOOD_CONFIG), iam });
    expect(report.checks.find((c) => c.id === "xray-iam")?.status).toBe("pass");
  });

  it("fails xray-iam when a live PermissionsBoundary denies xray", async () => {
    const boundaryDoc = JSON.stringify({
      Statement: [{ Effect: "Allow", Action: "s3:*", Resource: "*" }],
    });
    const iam = iamOf((cmd) => {
      if (cmd instanceof GetRoleCommand) {
        return {
          Role: {
            PermissionsBoundary: {
              PermissionsBoundaryArn: "arn:aws:iam::123456789012:policy/CorpBoundary",
            },
          },
        };
      }
      if (cmd instanceof ListAttachedRolePoliciesCommand) {
        return {
          AttachedPolicies: [
            {
              PolicyName: "AWSXRayDaemonWriteAccess",
              PolicyArn: "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess",
            },
          ],
        };
      }
      if (cmd instanceof GetPolicyCommand) return { Policy: { DefaultVersionId: "v1" } };
      if (cmd instanceof GetPolicyVersionCommand) {
        return { PolicyVersion: { Document: encodeURIComponent(boundaryDoc) } };
      }
      return {};
    });
    const report = await analyzeFunction("fn-live", { lambda: lambdaOf(GOOD_CONFIG), iam });
    // attached policy は allow でも boundary が絞る — fail が正しい
    expect(report.checks.find((c) => c.id === "xray-iam")?.status).toBe("fail");
  });

  it("passes an abortSignal with the configured timeout on every AWS request", async () => {
    // send の第 2 引数（request options）を捕捉する fake — timeout が
    // 実際に配線されていることを検証する。
    const seen: { abortSignal?: AbortSignal }[] = [];
    const lambda = {
      send: async (_cmd: unknown, opts?: { abortSignal?: AbortSignal }) => {
        seen.push(opts ?? {});
        return GOOD_CONFIG;
      },
    } as unknown as LambdaClient;
    const iam = {
      send: async (cmd: unknown, opts?: { abortSignal?: AbortSignal }) => {
        seen.push(opts ?? {});
        if (cmd instanceof ListAttachedRolePoliciesCommand) return { AttachedPolicies: [] };
        if (cmd instanceof ListRolePoliciesCommand) return { PolicyNames: [] };
        return {};
      },
    } as unknown as IAMClient;
    await analyzeFunction("fn-live", { lambda, iam, timeoutMs: 1234 });
    expect(seen.length).toBeGreaterThanOrEqual(3); // GetFunctionConfiguration + GetRole + List*2
    for (const opts of seen) {
      expect(opts.abortSignal).toBeInstanceOf(AbortSignal);
    }
  });

  it.each([Number.NaN, -5, 0, 1.5, 2 ** 31, 2 ** 32])(
    "timeoutMs=%s は AbortSignal.timeout の範囲外として RangeError で弾く",
    async (bad) => {
      const lambda = {
        send: async () => {
          throw new Error("send must not be called for invalid timeoutMs");
        },
      } as unknown as LambdaClient;
      await expect(analyzeFunction("fn-live", { lambda, timeoutMs: bad })).rejects.toThrow(
        RangeError,
      );
    },
  );
});
