import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTracer, SekimoriError, tracer } from "../src/index.js";
import { type OtelHarness, setupOtel, spanNamed } from "./otel-setup.js";

const harness: OtelHarness = setupOtel("w3c");
afterAll(() => harness.teardown());
beforeEach(() => harness.reset());

describe("tracer shim (DEC-003)", () => {
  it("putAnnotation writes a plain attribute on the active span", async () => {
    const t = createTracer("shim-test");
    await trace.getTracer("test").startActiveSpan("op", async (span) => {
      t.putAnnotation("userId", "u-1");
      t.putAnnotation("count", 3);
      span.end();
    });
    const span = spanNamed(harness.spans(), "op");
    expect(span.attributes.userId).toBe("u-1");
    expect(span.attributes.count).toBe(3);
  });

  it("putMetadata writes metadata.<key>, JSON-encoding objects and honouring namespace", async () => {
    const t = createTracer("shim-test");
    await trace.getTracer("test").startActiveSpan("op", async (span) => {
      t.putMetadata("payload", { a: 1 });
      t.putMetadata("retry", 2, "jobs");
      span.end();
    });
    const span = spanNamed(harness.spans(), "op");
    expect(span.attributes["metadata.payload"]).toBe('{"a":1}');
    expect(span.attributes["metadata.jobs.retry"]).toBe(2);
  });

  it("getSegment returns the active span", async () => {
    await trace.getTracer("test").startActiveSpan("op", async (span) => {
      expect(tracer.getSegment()?.spanContext().spanId).toBe(span.spanContext().spanId);
      span.end();
    });
  });

  it("captureLambdaHandler returns the handler unchanged", () => {
    const handler = () => "ok";
    expect(tracer.captureLambdaHandler(handler)).toBe(handler);
  });

  it("captureMethod wraps fn in a span and records errors", async () => {
    const t = createTracer("shim-test");
    const wrapped = t.captureMethod("doWork", () => "done");
    await trace.getTracer("test").startActiveSpan("op", async (span) => {
      expect(wrapped()).toBe("done");
      span.end();
    });
    const method = spanNamed(harness.spans(), "doWork");
    const op = spanNamed(harness.spans(), "op");
    expect(method.parentSpanContext?.spanId).toBe(op.spanContext().spanId);

    const failing = t.captureMethod("bad", () => {
      throw new Error("boom");
    });
    expect(() => failing()).toThrow("boom");
    expect(spanNamed(harness.spans(), "bad").status.code).toBe(SpanStatusCode.ERROR);
  });

  it("propagates the original error when recordException throws (R13)", async () => {
    // custom Span 実装・test double が recordException で投げても元の error を隠さない。
    let proto: object | undefined;
    trace.getTracer("probe").startActiveSpan("p", (s) => {
      proto = Object.getPrototypeOf(s);
      s.end();
    });
    const spy = vi
      .spyOn(proto as { recordException: (e: unknown) => void }, "recordException")
      .mockImplementation(() => {
        throw new Error("recorder boom");
      });
    try {
      const t = createTracer("shim-test");
      const failing = t.captureMethod("bad", () => {
        throw new Error("original boom");
      });
      expect(() => failing()).toThrow("original boom");
      const asyncFailing = t.captureMethod("asyncBad", () =>
        Promise.reject(new Error("async original")),
      );
      await expect(asyncFailing()).rejects.toThrow("async original");
    } finally {
      spy.mockRestore();
    }
  });

  it("propagates the original error when span.end throws (R14)", () => {
    // custom Span 実装が end() で投げても、元の error・成功結果を隠さない。
    let proto: object | undefined;
    trace.getTracer("probe").startActiveSpan("p", (s) => {
      proto = Object.getPrototypeOf(s);
      s.end();
    });
    const spy = vi.spyOn(proto as { end: () => void }, "end").mockImplementation(() => {
      throw new Error("end boom");
    });
    try {
      const t = createTracer("shim-test");
      const failing = t.captureMethod("bad", () => {
        throw new Error("original boom");
      });
      expect(() => failing()).toThrow("original boom");
      const ok = t.captureMethod("good", () => "value");
      expect(ok()).toBe("value");
    } finally {
      spy.mockRestore();
    }
  });

  it("captureMethod runs fn without a span under suppressTracing (R14)", async () => {
    // withConsumerSpan / inject 側の抑止と対称 — 抑制された scope では span を開かない。
    const t = createTracer("shim-test");
    const wrapped = t.captureMethod("sup", () => "done");
    let result: string | undefined;
    await context.with(suppressTracing(context.active()), async () => {
      result = wrapped();
    });
    expect(result).toBe("done");
    expect(harness.spans().some((s) => s.name === "sup")).toBe(false);
  });

  it("captureMethod ends the span for async functions too", async () => {
    const t = createTracer("shim-test");
    const wrapped = t.captureMethod("asyncWork", async () => "done");
    expect(await wrapped()).toBe("done");
    expect(spanNamed(harness.spans(), "asyncWork").ended).toBe(true);
  });

  it("captureMethod records async rejections as ERROR with an exception event", async () => {
    const t = createTracer("shim-test");
    const failing = t.captureMethod("asyncBad", async () => {
      await Promise.resolve();
      throw new Error("async boom");
    });
    await expect(failing()).rejects.toThrow("async boom");
    const span = spanNamed(harness.spans(), "asyncBad");
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.events.some((e) => e.name === "exception")).toBe(true);
  });

  it("captureMethod treats non-Promise thenables as async", async () => {
    const t = createTracer("shim-test");
    // Promise.resolve が絡まない独自 thenable（cross-realm promise 相当）。
    const thenable = {
      // biome-ignore lint/suspicious/noThenProperty: thenable 自体の挙動を検証するテストのため意図的
      then: (resolve: (v: string) => void) => resolve("thenable done"),
    };
    const wrapped = t.captureMethod("thenableWork", () => thenable);
    expect(await wrapped()).toBe("thenable done");
    expect(spanNamed(harness.spans(), "thenableWork").ended).toBe(true);

    const rejecting = t.captureMethod("thenableBad", () => ({
      // biome-ignore lint/suspicious/noThenProperty: 同上（reject する thenable）
      then: (_res: unknown, reject: (e: unknown) => void) => reject(new Error("thenable boom")),
    }));
    await expect(rejecting()).rejects.toThrow("thenable boom");
    const span = spanNamed(harness.spans(), "thenableBad");
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.events.some((e) => e.name === "exception")).toBe(true);
  });

  it("captureMethod preserves the receiver (`this`) of the wrapped function", async () => {
    const t = createTracer("shim-test");
    const obj = {
      prefix: "order-",
      work(id: string) {
        return `${this.prefix}${id}`;
      },
    };
    const wrapped = t.captureMethod("objWork", obj.work);
    expect(wrapped.call(obj, "7")).toBe("order-7");
    expect(spanNamed(harness.spans(), "objWork").ended).toBe(true);
  });

  it("putMetadata never throws — mixed arrays and circular values become strings", async () => {
    const t = createTracer("shim-test");
    await trace.getTracer("test").startActiveSpan("op", async (span) => {
      t.putMetadata("mixed", [1, "two", { three: 3 }]);
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      t.putMetadata("circular", circular);
      t.putMetadata("undef", undefined);
      t.putMetadata("homogeneous", ["a", "b"]);
      span.end();
    });
    const attrs = spanNamed(harness.spans(), "op").attributes;
    expect(typeof attrs["metadata.mixed"]).toBe("string");
    expect(typeof attrs["metadata.circular"]).toBe("string");
    expect(attrs["metadata.homogeneous"]).toEqual(["a", "b"]);
  });

  it("putMetadata JSON-encodes arrays containing null/undefined (R4-A-6)", async () => {
    // OTel の配列 attribute は string/number/boolean のみ — [null] を渡すと SDK が drop
    // するため JSON 化して記録する。
    const t = createTracer("shim-test");
    await trace.getTracer("test").startActiveSpan("op", async (span) => {
      t.putMetadata("nulls", [null]);
      t.putMetadata("nullable", [null, "a"]);
      span.end();
    });
    const attrs = spanNamed(harness.spans(), "op").attributes;
    expect(attrs["metadata.nulls"]).toBe("[null]");
    expect(attrs["metadata.nullable"]).toBe('[null,"a"]');
  });

  it("putMetadata JSON-encodes sparse arrays — holes must not survive as attribute arrays", async () => {
    // Array.prototype.every は hole を skip するため [1,,3] が「同型 number 配列」と
    // 誤判定され得る。hole は OTel attribute として扱えないため JSON 化する。
    const t = createTracer("shim-test");
    await trace.getTracer("test").startActiveSpan("op", async (span) => {
      const sparse = [1, 2, 3];
      delete sparse[1];
      t.putMetadata("sparse", sparse);
      span.end();
    });
    const attrs = spanNamed(harness.spans(), "op").attributes;
    expect(attrs["metadata.sparse"]).toBe("[1,null,3]");
  });

  it("putMetadata keeps dense arrays with extra props, JSON-encodes sparse ones even with props", async () => {
    // Object.keys 総数での密度判定は、追加 enumerable property が hole と相殺して
    // 誤判定する — 添字ごとの存在検査で弾く。逆に密配列＋追加 property は配列のまま。
    const t = createTracer("shim-test");
    await trace.getTracer("test").startActiveSpan("op", async (span) => {
      t.putMetadata("tagged", Object.assign([1, 2, 3], { tag: true }));
      const sparse = Object.assign([1, 2, 3], { tag: true });
      delete sparse[1];
      t.putMetadata("taggedSparse", sparse);
      span.end();
    });
    const attrs = spanNamed(harness.spans(), "op").attributes;
    // 配列のまま記録されること（toEqual は追加 property も比較するため要素だけ比べる）
    const tagged = attrs["metadata.tagged"];
    expect(Array.isArray(tagged)).toBe(true);
    expect(Array.from(tagged as unknown[])).toEqual([1, 2, 3]);
    expect(attrs["metadata.taggedSparse"]).toBe("[1,null,3]");
  });

  it("createTracer / captureMethod validate their names (R9-A)", () => {
    const t = createTracer("shim-test");
    expect(() => createTracer("")).toThrow(SekimoriError);
    // @ts-expect-error runtime guard の検証
    expect(() => createTracer(42)).toThrow(SekimoriError);
    expect(() => t.captureMethod("", () => 1)).toThrow(SekimoriError);
    // @ts-expect-error runtime guard の検証
    expect(() => t.captureMethod("x", null)).toThrow(SekimoriError);
  });

  it("captureAWS* and captureHTTPsGlobal are pass-throughs", () => {
    const sdk = { marker: true };
    expect(tracer.captureAWS(sdk)).toBe(sdk);
    expect(tracer.captureAWSClient(sdk)).toBe(sdk);
    expect(tracer.captureAWSv3Client(sdk)).toBe(sdk);
    expect(tracer.captureHTTPsGlobal(sdk)).toBe(sdk);
  });
});
