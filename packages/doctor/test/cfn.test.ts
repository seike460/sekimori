import { describe, expect, it } from "vitest";
import {
  asObject,
  isIntrinsicObject,
  isNoValueRef,
  isUnresolvable,
  referencedLogicalId,
} from "../src/cfn.js";

describe("asObject", () => {
  it("returns plain objects and rejects arrays / primitives / null", () => {
    expect(asObject({ a: 1 })).toEqual({ a: 1 });
    expect(asObject([1])).toBeUndefined();
    expect(asObject(null)).toBeUndefined();
    expect(asObject("x")).toBeUndefined();
    expect(asObject(5)).toBeUndefined();
  });
});

describe("isNoValueRef", () => {
  it("detects the AWS::NoValue pseudo-parameter ref only", () => {
    expect(isNoValueRef({ Ref: "AWS::NoValue" })).toBe(true);
    expect(isNoValueRef({ Ref: "AWS::Region" })).toBe(false);
    expect(isNoValueRef({})).toBe(false);
    expect(isNoValueRef("Ref")).toBe(false);
  });
});

describe("isIntrinsicObject", () => {
  it("accepts objects whose keys are all intrinsic functions", () => {
    expect(isIntrinsicObject({ Ref: "X" })).toBe(true);
    expect(isIntrinsicObject({ "Fn::If": ["C", {}, { Ref: "AWS::NoValue" }] })).toBe(true);
    expect(isIntrinsicObject({ "Fn::GetAtt": ["R", "Arn"] })).toBe(true);
  });

  it("rejects empty objects and objects with non-intrinsic keys", () => {
    expect(isIntrinsicObject({})).toBe(false);
    expect(isIntrinsicObject({ Ref: "X", Name: "fixed" })).toBe(false);
    expect(isIntrinsicObject({ Name: "fixed" })).toBe(false);
  });
});

describe("referencedLogicalId", () => {
  it("reads Fn::GetAtt array and string forms plus Ref", () => {
    expect(referencedLogicalId({ "Fn::GetAtt": ["RoleX", "Arn"] })).toBe("RoleX");
    expect(referencedLogicalId({ "Fn::GetAtt": "RoleX.Arn" })).toBe("RoleX");
    expect(referencedLogicalId({ Ref: "RoleX" })).toBe("RoleX");
  });

  it("returns undefined for non-references and malformed shapes", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: ${} は CloudFormation Fn::Sub の構文
    expect(referencedLogicalId({ "Fn::Sub": "${X}" })).toBeUndefined();
    expect(referencedLogicalId({ "Fn::GetAtt": [1, "Arn"] })).toBeUndefined();
    expect(referencedLogicalId({ Ref: 5 })).toBeUndefined();
    expect(referencedLogicalId("RoleX")).toBeUndefined();
  });
});

describe("isUnresolvable", () => {
  it("treats intrinsics as unresolvable except the NoValue ref", () => {
    expect(isUnresolvable({ "Fn::If": ["C", {}, {}] })).toBe(true);
    expect(isUnresolvable({ Ref: "AWS::NoValue" })).toBe(false);
    expect(isUnresolvable({ Name: "v" })).toBe(false);
  });
});
