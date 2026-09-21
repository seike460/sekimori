import { Node, Project, type PropertyAccessExpression, SyntaxKind } from "ts-morph";
import { describe, expect, it } from "vitest";
import {
  canonicalReceiverText,
  isMemberWritePosition,
  unwrapReceiver,
} from "../src/transform-receiver.js";

const project = new Project({ useInMemoryFileSystem: true });
let n = 0;
const sf = (source: string) => {
  n += 1;
  return project.createSourceFile(`t${n}.ts`, source, { overwrite: true });
};

/** source 内で expression `expr` に一致する最初の node を返す。 */
const expr = (source: string, expr: string): Node => {
  const f = sf(source);
  const found = f.getFirstDescendant((node) => node.getText() === expr && Node.isExpression(node));
  if (found === undefined) throw new Error(`expr not found: ${expr}`);
  return found;
};

describe("unwrapReceiver", () => {
  it("returns the node itself when it is not wrapped", () => {
    const node = expr("seg.end();\n", "seg");
    expect(unwrapReceiver(node).getText()).toBe("seg");
  });

  it.each(["(seg)", "seg!", "seg as T", "seg satisfies T", "<T>seg"])(
    "unwraps %s to the inner expression",
    (wrapped) => {
      const node = expr(`(${wrapped}).end();\n`, wrapped);
      expect(unwrapReceiver(node).getText()).toBe("seg");
    },
  );

  it("unwraps nested sugar recursively", () => {
    const node = expr("((seg as T)!).end();\n", "(seg as T)!");
    expect(unwrapReceiver(node).getText()).toBe("seg");
  });
});

describe("canonicalReceiverText", () => {
  it("normalizes sugar around a member chain to dotted text", () => {
    const node = expr("(x)!.seg.end();\n", "(x)!.seg");
    expect(canonicalReceiverText(node)).toBe("x.seg");
  });

  it("keeps a plain identifier as-is", () => {
    expect(canonicalReceiverText(expr("seg.end();\n", "seg"))).toBe("seg");
  });

  it("normalizes different wrappers on the same chain to the same key", () => {
    const a = expr("x!.seg.end();\n", "x!.seg");
    const b = expr("(x.seg as S).end();\n", "(x.seg as S)");
    expect(canonicalReceiverText(a)).toBe(canonicalReceiverText(b));
  });
});

describe("isMemberWritePosition", () => {
  const memberAt = (source: string): PropertyAccessExpression => {
    const f = sf(source);
    const pa = f.getFirstDescendantByKindOrThrow(SyntaxKind.PropertyAccessExpression);
    return pa;
  };

  it("detects an assignment LHS", () => {
    expect(isMemberWritePosition(memberAt("seg.end = 1;\n"))).toBe(true);
  });

  it("detects a compound assignment LHS", () => {
    expect(isMemberWritePosition(memberAt("seg.end += 1;\n"))).toBe(true);
  });

  it("detects ++/-- on a member", () => {
    expect(isMemberWritePosition(memberAt("seg.end++;\n"))).toBe(true);
  });

  it("detects delete on a member", () => {
    expect(isMemberWritePosition(memberAt("delete seg.end;\n"))).toBe(true);
  });

  it("does not flag a call callee", () => {
    expect(isMemberWritePosition(memberAt("seg.end();\n"))).toBe(false);
  });

  it("does not flag a member read", () => {
    expect(isMemberWritePosition(memberAt("const x = seg.end;\n"))).toBe(false);
  });

  it("climbs through non-null sugar to find the assignment", () => {
    expect(isMemberWritePosition(memberAt("seg.end! = 1;\n"))).toBe(true);
  });
});
