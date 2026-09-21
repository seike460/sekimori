import { describe, expect, it } from "vitest";
import { checkFunction, type FunctionFacts, MIN_ADOT_LAYER_VERSION } from "../src/checks.js";

const base: FunctionFacts = {
  name: "fn",
  tracingMode: "Active",
  layers: [
    `arn:aws:lambda:ap-northeast-1:901920570463:layer:AWSOpenTelemetryDistroJs:${MIN_ADOT_LAYER_VERSION}`,
  ],
  environment: {
    AWS_LAMBDA_EXEC_WRAPPER: "/opt/otel-instrument",
    OTEL_SERVICE_NAME: "svc",
  },
  xrayWriteAllowed: true,
};

const check = (facts: Partial<FunctionFacts>, id: string) =>
  checkFunction({ ...base, ...facts }).checks.find((c) => c.id === id);

describe("checkFunction", () => {
  it("returns one check per FUNCTION_CHECKS entry in declaration order", () => {
    expect(checkFunction(base).checks.map((c) => c.id)).toEqual([
      "tracing",
      "adot-layer",
      "exec-wrapper",
      "service-name",
      "propagators",
      "xray-iam",
    ]);
  });

  it("passes all checks for a fully instrumented function", () => {
    expect(checkFunction(base).checks.every((c) => c.status === "pass")).toBe(true);
  });
});

describe("tracing", () => {
  it("fails on PassThrough — the layer would parent on an unsampled context", () => {
    expect(check({ tracingMode: "PassThrough" }, "tracing")?.status).toBe("fail");
  });
  it("warns (not fails) when TracingConfig is an intrinsic", () => {
    expect(check({ tracingMode: undefined, tracingUnresolvable: true }, "tracing")?.status).toBe(
      "warn",
    );
  });
  it("warns when unset", () => {
    expect(check({ tracingMode: undefined }, "tracing")?.status).toBe("warn");
  });
});

describe("adot-layer", () => {
  it("fails when no AWSOpenTelemetryDistroJs layer is attached", () => {
    expect(check({ layers: [] }, "adot-layer")?.status).toBe("fail");
  });
  it("warns below the minimum layer version", () => {
    const layer = `arn:aws:lambda:us-east-1:901920570463:layer:AWSOpenTelemetryDistroJs:${MIN_ADOT_LAYER_VERSION - 1}`;
    expect(check({ layers: [layer] }, "adot-layer")?.status).toBe("warn");
  });
  it("warns instead of failing on non-Node.js runtimes", () => {
    expect(check({ layers: [], nonNodeJs: true }, "adot-layer")?.status).toBe("warn");
  });
  it("warns when the layer list is unresolvable", () => {
    expect(check({ layers: [], layersUnresolvable: true }, "adot-layer")?.status).toBe("warn");
  });
});

describe("exec-wrapper", () => {
  it("warns on a non-standard wrapper value", () => {
    expect(
      check({ environment: { AWS_LAMBDA_EXEC_WRAPPER: "/opt/other" } }, "exec-wrapper")?.status,
    ).toBe("warn");
  });
  it("warns on unresolvable env instead of reporting unset", () => {
    expect(
      check({ environment: {}, unresolvableEnvKeys: ["AWS_LAMBDA_EXEC_WRAPPER"] }, "exec-wrapper")
        ?.status,
    ).toBe("warn");
  });
});

describe("propagators", () => {
  it("passes when unset (ADOT default covers all carriers)", () => {
    expect(check({}, "propagators")?.status).toBe("pass");
  });
  it("warns when a required propagator is missing", () => {
    expect(
      check({ environment: { OTEL_PROPAGATORS: "tracecontext" } }, "propagators")?.status,
    ).toBe("warn");
  });
  it("passes with all three required propagators", () => {
    expect(
      check({ environment: { OTEL_PROPAGATORS: "tracecontext,xray,baggage" } }, "propagators")
        ?.status,
    ).toBe("pass");
  });
});

describe("xray-iam", () => {
  it("fails when the role cannot write traces", () => {
    expect(check({ xrayWriteAllowed: false }, "xray-iam")?.status).toBe("fail");
  });
  it("surfaces the IAM read error reason in the warn message", () => {
    const c = check({ xrayWriteAllowed: undefined, xrayIamError: "AccessDenied" }, "xray-iam");
    expect(c?.status).toBe("warn");
    expect(c?.message).toContain("AccessDenied");
  });
});
