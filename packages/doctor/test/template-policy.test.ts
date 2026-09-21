import { describe, expect, it } from "vitest";
import type { Json } from "../src/cfn.js";
import { roleAllowsXrayWrite, samXrayWriteAllowed } from "../src/template-policy.js";

const allowPolicy = {
  Version: "2012-10-17",
  Statement: [{ Effect: "Allow", Action: "xray:PutTraceSegments", Resource: "*" }],
};
const denyPolicy = {
  Version: "2012-10-17",
  Statement: [{ Effect: "Deny", Action: "xray:*", Resource: "*" }],
};

const roleWith = (policies: unknown[]): Json => ({
  Type: "AWS::IAM::Role",
  Properties: {
    Policies: policies.map((p, i) => ({
      PolicyName: `p${i}`,
      PolicyDocument: p,
    })),
  },
});

describe("roleAllowsXrayWrite", () => {
  it("returns undefined when the role id does not resolve to a Role resource", () => {
    expect(roleAllowsXrayWrite("Missing", {})).toBeUndefined();
    expect(roleAllowsXrayWrite("Q", { Q: { Type: "AWS::SQS::Queue" } })).toBeUndefined();
  });

  it("returns false when the role has no policies granting xray", () => {
    const resources = { R: roleWith([]) };
    expect(roleAllowsXrayWrite("R", resources)).toBe(false);
  });

  it("returns true when a policy allows xray:PutTraceSegments on *", () => {
    const resources = { R: roleWith([allowPolicy]) };
    expect(roleAllowsXrayWrite("R", resources)).toBe(true);
  });

  it("lets a single Deny win over an Allow", () => {
    const resources = { R: roleWith([allowPolicy, denyPolicy]) };
    expect(roleAllowsXrayWrite("R", resources)).toBe(false);
  });

  it("returns undefined when Properties is an intrinsic", () => {
    const resources = {
      R: { Type: "AWS::IAM::Role", Properties: { "Fn::If": ["C", {}, {}] } },
    };
    expect(roleAllowsXrayWrite("R", resources)).toBeUndefined();
  });
});

describe("samXrayWriteAllowed", () => {
  // SAM の Policies entry は `{ Statement: [...] }` の inline document 形状。
  const samPolicy = {
    Statement: [{ Effect: "Allow", Action: "xray:PutTraceSegments", Resource: "*" }],
  };

  it("evaluates the function's own Policies when Role is unset", () => {
    const props: Json = { Policies: [samPolicy] };
    expect(samXrayWriteAllowed(props, {})).toBe(true);
  });

  it("returns false when Role is unset and Policies grant nothing", () => {
    expect(samXrayWriteAllowed({}, {})).toBe(false);
  });

  it("treats Role: { Ref: AWS::NoValue } as unset", () => {
    const props: Json = {
      Role: { Ref: "AWS::NoValue" },
      Policies: [samPolicy],
    };
    expect(samXrayWriteAllowed(props, {})).toBe(true);
  });

  it("returns false when a PermissionsBoundary denies xray", () => {
    const props: Json = {
      PermissionsBoundary: "arn:aws:iam::aws:policy/AWSLambda_FullAccess",
      Policies: [samPolicy],
    };
    // AWSLambda_FullAccess は xray:PutTraceSegments を含まない（known no-xray リスト）—
    // boundary が効く default role では実効的に deny。
    expect(samXrayWriteAllowed(props, {})).toBe(false);
  });
});
