import { describe, expect, it } from "vitest";
import {
  evaluatePolicyDocument,
  iamActionMatches,
  isAwsManagedPolicyArn,
  KNOWN_NO_XRAY_MANAGED_POLICIES,
  policyDocumentAllowsXrayWrite,
  XRAY_ALLOWED_MANAGED_POLICIES,
} from "../src/policy.js";

const allow = (action: unknown = "xray:PutTraceSegments", resource: unknown = "*") => ({
  Effect: "Allow",
  Action: action,
  Resource: resource,
});

describe("iamActionMatches", () => {
  it("matches exact action case-insensitively", () => {
    expect(iamActionMatches("xray:PutTraceSegments", "xray:puttracesegments")).toBe(true);
  });

  it("expands * and ? wildcards like IAM", () => {
    expect(iamActionMatches("xray:*", "xray:PutTraceSegments")).toBe(true);
    expect(iamActionMatches("*", "xray:PutTraceSegments")).toBe(true);
    expect(iamActionMatches("xray:PutTraceSegment?", "xray:PutTraceSegments")).toBe(true);
    expect(iamActionMatches("xray:PutTraceSegment?", "xray:PutTraceSegmentsX")).toBe(false);
  });

  it("does not treat regex metacharacters in the pattern as regex", () => {
    expect(iamActionMatches("xray:PutTraceSegments+", "xray:PutTraceSegments")).toBe(false);
    expect(iamActionMatches("xray:Get.*", "xray:GetX")).toBe(false);
  });
});

describe("isAwsManagedPolicyArn", () => {
  it("accepts aws / aws-cn / aws-us-gov account fields", () => {
    expect(isAwsManagedPolicyArn("arn:aws:iam::aws:policy/AdministratorAccess")).toBe(true);
    expect(isAwsManagedPolicyArn("arn:aws-cn:iam::aws-cn:policy/ReadOnlyAccess")).toBe(true);
    expect(isAwsManagedPolicyArn("arn:aws-us-gov:iam::aws-us-gov:policy/ReadOnlyAccess")).toBe(
      true,
    );
  });

  it("rejects customer managed policies and non-ARNs", () => {
    expect(isAwsManagedPolicyArn("arn:aws:iam::123456789012:policy/MyPolicy")).toBe(false);
    expect(isAwsManagedPolicyArn("not-an-arn")).toBe(false);
  });
});

describe("evaluatePolicyDocument", () => {
  it("returns allow when an Allow statement covers xray:PutTraceSegments on *", () => {
    expect(evaluatePolicyDocument({ Statement: [allow(["s3:GetObject", "xray:*"])] })).toBe(
      "allow",
    );
  });

  it("deny beats allow across statements", () => {
    expect(
      evaluatePolicyDocument({
        Statement: [allow(), { Effect: "Deny", Action: "xray:*", Resource: "*" }],
      }),
    ).toBe("deny");
  });

  it("scoped Resource never reaches xray write for either Effect", () => {
    expect(
      evaluatePolicyDocument({
        Statement: [
          allow("xray:*", "arn:aws:xray:*:*:group/*"),
          { Effect: "Deny", Action: "xray:*", Resource: "arn:aws:xray:*:*:group/*" },
        ],
      }),
    ).toBe("no-allow");
  });

  it("returns undecidable for non-object docs, NotAction/NotResource, and Condition", () => {
    expect(evaluatePolicyDocument("not an object")).toBe("undecidable");
    expect(evaluatePolicyDocument({ Statement: "x" })).toBe("undecidable");
    expect(
      evaluatePolicyDocument({
        Statement: [{ Effect: "Allow", NotAction: "iam:*", Resource: "*" }],
      }),
    ).toBe("undecidable");
    expect(
      evaluatePolicyDocument({
        Statement: [{ ...allow(), Condition: { StringEquals: { "aws:PrincipalTag/x": "y" } } }],
      }),
    ).toBe("undecidable");
  });

  it("returns undecidable when Action/Resource/Effect are intrinsics", () => {
    expect(
      evaluatePolicyDocument({
        Statement: [{ Effect: "Allow", Action: { Ref: "Actions" }, Resource: "*" }],
      }),
    ).toBe("undecidable");
  });

  it("returns no-allow for an empty or non-matching statement list", () => {
    expect(evaluatePolicyDocument({ Statement: [] })).toBe("no-allow");
    expect(evaluatePolicyDocument({ Statement: [allow("s3:GetObject")] })).toBe("no-allow");
  });

  it("an unrecognized Effect on a matching statement is undecidable, not skipped", () => {
    expect(
      evaluatePolicyDocument({
        Statement: [{ Effect: "ALLOW", Action: "xray:*", Resource: "*" }],
      }),
    ).toBe("undecidable");
  });
});

describe("policyDocumentAllowsXrayWrite", () => {
  it("folds verdicts to boolean | undefined", () => {
    expect(policyDocumentAllowsXrayWrite({ Statement: [allow()] })).toBe(true);
    expect(policyDocumentAllowsXrayWrite({ Statement: [] })).toBe(false);
    expect(policyDocumentAllowsXrayWrite({})).toBeUndefined();
  });
});

describe("managed policy tables", () => {
  it("keeps the allow and known-no-xray sets disjoint", () => {
    for (const name of XRAY_ALLOWED_MANAGED_POLICIES) {
      expect(KNOWN_NO_XRAY_MANAGED_POLICIES.has(name)).toBe(false);
    }
  });

  it("stores names in lowercase for case-insensitive lookup", () => {
    for (const name of [...XRAY_ALLOWED_MANAGED_POLICIES, ...KNOWN_NO_XRAY_MANAGED_POLICIES]) {
      expect(name).toBe(name.toLowerCase());
    }
  });
});
