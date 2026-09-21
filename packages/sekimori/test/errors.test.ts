import { ROOT_CONTEXT } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import {
  assertAttributeMap,
  assertAttributes,
  assertConsumeOptions,
  assertContext,
  assertInjectOptions,
  assertObject,
  assertPlainObject,
  isPlainObject,
  SekimoriError,
} from "../src/errors.js";
import { asMalformed } from "./otel-setup.js";

describe("SekimoriError", () => {
  it("name と instanceof を保つ", () => {
    const e = new SekimoriError("msg");
    expect(e.name).toBe("SekimoriError");
    expect(e instanceof SekimoriError && e instanceof Error).toBe(true);
  });
});

describe("assertObject", () => {
  it.each([null, undefined, [], "s", 5])("非 object %j は弾く", (v) => {
    expect(() => assertObject(v, "api")).toThrow(SekimoriError);
  });
  it("object は通す（関数名を message に含む）", () => {
    expect(() => assertObject({}, "api")).not.toThrow();
    expect(() => assertObject(null, "myApi")).toThrow(/myApi/);
  });
});

describe("assertContext", () => {
  it("undefined と正当な Context は通す", () => {
    expect(() => assertContext(undefined, "api")).not.toThrow();
    expect(() => assertContext(ROOT_CONTEXT, "api")).not.toThrow();
  });
  it.each([null, {}, { getValue: () => undefined }])("部分実装 %j は弾く", (v) => {
    expect(() => assertContext(v, "api")).toThrow(/Context/);
  });
  it("get trap でメソッドを供給する Proxy 製 Context は通す", () => {
    // `has` trap を持たない Proxy では `"getValue" in ctx` は false だが、
    // `get` trap で実メソッドを返すため正当な Context として機能する。
    // `in` 判定の guard はこれを誤って弾く（base は直接 property 読みで受理）。
    const real = ROOT_CONTEXT;
    const proxyCtx = new Proxy(
      {},
      {
        get: (_t, key) =>
          key === "getValue" || key === "setValue" || key === "deleteValue"
            ? (real[key] as (...a: never[]) => unknown).bind(real)
            : undefined,
      },
    );
    expect(() => assertContext(proxyCtx, "api")).not.toThrow();
  });
});

describe("assertInjectOptions", () => {
  it('boolean / "auto" / 未指定は通す', () => {
    expect(() => assertInjectOptions({}, "api")).not.toThrow();
    expect(() => assertInjectOptions({ w3c: false }, "api")).not.toThrow();
    expect(() => assertInjectOptions({ xrayHeader: "auto" }, "api")).not.toThrow();
  });
  it.each([{ w3c: "false" }, { xrayHeader: "yes" }, { xrayHeader: 1 }])(
    "非 boolean/truthy 文字列 %j は弾く",
    (v) => {
      expect(() => assertInjectOptions(asMalformed(v), "api")).toThrow(SekimoriError);
    },
  );
});

describe("assertConsumeOptions", () => {
  it("正当な options は通す", () => {
    expect(() => assertConsumeOptions({}, "api")).not.toThrow();
    expect(() =>
      assertConsumeOptions({ name: "n", parent: "producer", attributes: {} }, "api"),
    ).not.toThrow();
  });
  it.each([{ name: "" }, { name: 1 }, { parent: "x" }, { attributes: [] }])(
    "不正な %j は弾く",
    (v) => {
      expect(() => assertConsumeOptions(asMalformed(v), "api")).toThrow(SekimoriError);
    },
  );
});

describe("isPlainObject / assertPlainObject / assertAttributeMap / assertAttributes", () => {
  it("plain object だけ true", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
    expect(isPlainObject(new Map())).toBe(false);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(new Date())).toBe(false);
  });
  it("Map / 配列 / class instance を弾く", () => {
    for (const bad of [new Map(), [], new Date()]) {
      expect(() => assertPlainObject(bad, "api", "payload")).toThrow(/plain object/);
      expect(() => assertAttributeMap(bad, "api", "MessageAttributes")).toThrow(SekimoriError);
      expect(() => assertAttributes(bad, "api")).toThrow(SekimoriError);
    }
  });
  it("undefined は attribute map / attributes を許容する", () => {
    expect(() => assertAttributeMap(undefined, "api", "MessageAttributes")).not.toThrow();
    expect(() => assertAttributes(undefined, "api")).not.toThrow();
  });
});

describe("toException / exceptionMessage", () => {
  it("Error と string はそのまま返す", async () => {
    const { toException } = await import("../src/errors.js");
    const err = new Error("boom");
    expect(toException(err)).toBe(err);
    expect(toException("plain")).toBe("plain");
  });

  it("Exception 形の object（name/message/stack）は同一参照を保持する", async () => {
    const { toException, exceptionMessage } = await import("../src/errors.js");
    const remote = { name: "RemoteError", message: "boom", stack: "remote stack" };
    const exception = toException(remote);
    expect(exception).toBe(remote);
    expect(exceptionMessage(exception, remote)).toBe("boom");
  });

  it("field の型が不正 / code・name・message を欠く object は文字列化する", async () => {
    const { toException } = await import("../src/errors.js");
    expect(toException({ name: 123, message: "x" })).toBe("[object Object]");
    expect(toException({ stack: "only-stack" })).toBe("[object Object]");
    expect(toException({ unrelated: true })).toBe("[object Object]");
    expect(toException(null)).toBe("null");
    expect(toException(42)).toBe("42");
    expect(toException({ code: "E_REMOTE" })).toEqual({ code: "E_REMOTE" });
  });

  it("exceptionMessage は Exception の message を優先し、無ければ文字列化する", async () => {
    const { exceptionMessage, toException } = await import("../src/errors.js");
    expect(exceptionMessage("raw string", "raw string")).toBe("raw string");
    expect(exceptionMessage(toException(new Error("e-msg")), new Error("e-msg"))).toBe("e-msg");
    const noMsg = { name: "OnlyName" };
    expect(exceptionMessage(toException(noMsg), noMsg)).toBe("[object Object]");
  });
});
