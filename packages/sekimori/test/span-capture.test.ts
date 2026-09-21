import {
  type Context,
  diag,
  type Span,
  type SpanContext,
  SpanStatusCode,
  type Tracer,
} from "@opentelemetry/api";
import { afterEach, describe, expect, it } from "vitest";
import { captureMethod } from "../src/span-capture.js";

/** recordException / setStatus / end の呼び出しを記録する最小 Span fake。 */
interface RecordedSpan {
  ended: number;
  exceptions: unknown[];
  statuses: { code: SpanStatusCode; message?: string }[];
  failOnEnd: boolean;
  failOnRecord: boolean;
}

function fakeSpan(recorded: RecordedSpan): Span {
  // メソッドはすべて自身を返す chainable — キャストはこの1箇所に閉じ込める。
  const span = {} as Span;
  span.spanContext = () => ({}) as SpanContext;
  span.setAttribute = () => span;
  span.setAttributes = () => span;
  span.addEvent = () => span;
  span.addLink = () => span;
  span.addLinks = () => span;
  span.setStatus = (status) => {
    recorded.statuses.push(status);
    return span;
  };
  span.updateName = () => span;
  span.end = () => {
    recorded.ended += 1;
    if (recorded.failOnEnd) throw new Error("end failed");
  };
  span.isRecording = () => true;
  span.recordException = (exception) => {
    recorded.exceptions.push(exception);
    if (recorded.failOnRecord) throw new Error("record failed");
  };
  return span;
}

function fakeTracer(recorded: RecordedSpan): Tracer {
  const tracer = {} as Tracer;
  tracer.startActiveSpan = (<R>(
    _name: string,
    _opts: unknown,
    ctxOrFn: Context | ((span: Span) => R),
    fn?: (span: Span) => R,
  ): R => {
    const cb = (typeof ctxOrFn === "function" ? ctxOrFn : fn) as (span: Span) => R;
    return cb(fakeSpan(recorded));
  }) as Tracer["startActiveSpan"];
  tracer.startSpan = () => fakeSpan(recorded);
  return tracer;
}

function harness(): { recorded: RecordedSpan; tracer: Tracer } {
  const recorded: RecordedSpan = {
    ended: 0,
    exceptions: [],
    statuses: [],
    failOnEnd: false,
    failOnRecord: false,
  };
  return { recorded, tracer: fakeTracer(recorded) };
}

// OTel API は登録済み logger の例外を捕捉しない — warn が投げると保護 catch を
// 突き抜けて呼び出し側の結果・例外を上書きする（R10 回帰）。
const throwingDiagLogger = {
  error: () => {
    throw new Error("diagnostic failure");
  },
  warn: () => {
    throw new Error("diagnostic failure");
  },
  info: () => {
    throw new Error("diagnostic failure");
  },
  debug: () => {
    throw new Error("diagnostic failure");
  },
  verbose: () => {
    throw new Error("diagnostic failure");
  },
};

afterEach(() => {
  // diag logger は global 状態 — 他テストへ漏らさない。
  diag.disable();
});

/** 解決タイミングを外から制御できる独自 thenable（cross-realm / non-native Promise 相当）。 */
function deferredThenable<T>(): {
  thenable: PromiseLike<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolveFn: ((v: T) => void) | undefined;
  let rejectFn: ((e: unknown) => void) | undefined;
  const inner = new Promise<T>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });
  return {
    thenable: {
      // biome-ignore lint/suspicious/noThenProperty: 独自 thenable の扱いを検証するのが目的
      then: (onFulfilled, onRejected) => inner.then(onFulfilled, onRejected),
    },
    resolve: (value) => resolveFn?.(value),
    reject: (error) => rejectFn?.(error),
  };
}

describe("captureMethod", () => {
  it("ends the span after a sync return", () => {
    const { recorded, tracer } = harness();
    const wrapped = captureMethod(tracer, "op", () => 42);
    expect(wrapped()).toBe(42);
    expect(recorded.ended).toBe(1);
    expect(recorded.exceptions).toHaveLength(0);
  });

  it("records exception + ERROR status and rethrows on sync throw", () => {
    const { recorded, tracer } = harness();
    const err = new Error("boom");
    const wrapped = captureMethod(tracer, "op", () => {
      throw err;
    });
    expect(() => wrapped()).toThrow(err);
    expect(recorded.exceptions).toEqual([err]);
    expect(recorded.statuses).toEqual([{ code: SpanStatusCode.ERROR, message: "boom" }]);
    expect(recorded.ended).toBe(1);
  });

  it("stringifies non-Error throws for recordException and status", () => {
    const { recorded, tracer } = harness();
    const wrapped = captureMethod(tracer, "op", () => {
      throw "plain failure";
    });
    expect(() => wrapped()).toThrow("plain failure");
    expect(recorded.exceptions).toEqual(["plain failure"]);
    expect(recorded.statuses[0]?.code).toBe(SpanStatusCode.ERROR);
  });

  it("keeps an Exception-shaped thrown object instead of stringifying it", () => {
    const { recorded, tracer } = harness();
    const remote = { name: "RemoteError", message: "boom", stack: "remote stack" };
    const wrapped = captureMethod(tracer, "op", () => {
      throw remote;
    });
    let thrown: unknown;
    try {
      wrapped();
    } catch (error) {
      thrown = error;
    }
    // 例外 object が "[object Object]" に潰れず name/message/stack を保つ。
    expect(thrown).toBe(remote);
    expect(recorded.exceptions).toEqual([remote]);
    expect(recorded.statuses).toEqual([{ code: SpanStatusCode.ERROR, message: "boom" }]);
  });

  it("keeps the span open until a thenable resolves", async () => {
    const { recorded, tracer } = harness();
    let resolveFn: ((v: string) => void) | undefined;
    const wrapped = captureMethod(
      tracer,
      "op",
      () => new Promise<string>((res) => (resolveFn = res)),
    );
    const pending = wrapped();
    expect(recorded.ended).toBe(0);
    resolveFn?.("done");
    await expect(pending).resolves.toBe("done");
    expect(recorded.ended).toBe(1);
  });

  it("records and rethrows on thenable rejection", async () => {
    const { recorded, tracer } = harness();
    const err = new Error("async boom");
    const wrapped = captureMethod(tracer, "op", () => Promise.reject(err));
    await expect(wrapped()).rejects.toThrow(err);
    expect(recorded.exceptions).toEqual([err]);
    expect(recorded.ended).toBe(1);
  });

  it("treats a custom thenable (non-native Promise) as async", async () => {
    const { recorded, tracer } = harness();
    // PromiseLike は構造的 — captureMethod は thenable を Promise へ畳んで返す。
    // settle 前に ended===0 を assert しないと `instanceof Promise` への mutation を検出できない。
    const { thenable, resolve } = deferredThenable<number>();
    const wrapped = captureMethod(tracer, "op", () => thenable);
    const result = wrapped();
    expect(recorded.ended).toBe(0);
    resolve(7);
    await expect(result).resolves.toBe(7);
    expect(recorded.ended).toBe(1);
  });

  it("records rejection from a custom thenable", async () => {
    const { recorded, tracer } = harness();
    const { thenable, reject } = deferredThenable<number>();
    const err = new Error("thenable boom");
    const wrapped = captureMethod(tracer, "op", () => thenable);
    const result = wrapped();
    expect(recorded.ended).toBe(0);
    reject(err);
    await expect(result).rejects.toThrow(err);
    expect(recorded.exceptions).toEqual([err]);
    expect(recorded.ended).toBe(1);
  });

  it("keeps the span open for a Proxy thenable that supplies `then` via a get trap", async () => {
    const { recorded, tracer } = harness();
    // `has` trap を持たない Proxy では `"then" in value` は false だが、
    // `get` trap で `then` を返すため Promise.resolve は settle を追跡できる。
    // isThenable が `in` 判定だと同期値と誤判定して span が早期終了する。
    const pending = new Promise<string>((res) => setTimeout(() => res("proxied"), 0));
    const proxyThenable = new Proxy(
      {},
      { get: (_t, key) => (key === "then" ? pending.then.bind(pending) : undefined) },
    );
    const wrapped = captureMethod(tracer, "op", () => proxyThenable);
    const result = wrapped();
    expect(recorded.ended).toBe(0);
    await expect(result).resolves.toBe("proxied");
    expect(recorded.ended).toBe(1);
    expect(recorded.exceptions).toHaveLength(0);
  });

  it("records rejection from a Proxy thenable", async () => {
    const { recorded, tracer } = harness();
    const err = new Error("proxy boom");
    const pending = new Promise<never>((_res, rej) => setTimeout(() => rej(err), 0));
    const proxyThenable = new Proxy(
      {},
      { get: (_t, key) => (key === "then" ? pending.then.bind(pending) : undefined) },
    );
    const wrapped = captureMethod(tracer, "op", () => proxyThenable);
    await expect(wrapped()).rejects.toThrow(err);
    expect(recorded.exceptions).toEqual([err]);
    expect(recorded.statuses).toEqual([{ code: SpanStatusCode.ERROR, message: "proxy boom" }]);
    expect(recorded.ended).toBe(1);
  });

  it("does not mask the original error when recordException fails", () => {
    const { recorded, tracer } = harness();
    recorded.failOnRecord = true;
    const err = new Error("original");
    const wrapped = captureMethod(tracer, "op", () => {
      throw err;
    });
    expect(() => wrapped()).toThrow(err);
    expect(recorded.ended).toBe(1);
  });

  it("does not mask the result when span.end() throws", () => {
    const { recorded, tracer } = harness();
    recorded.failOnEnd = true;
    const wrapped = captureMethod(tracer, "op", () => 9);
    expect(wrapped()).toBe(9);
    expect(recorded.ended).toBe(1);
  });

  it("does not replace the result when span.end() AND the diag logger both throw", () => {
    const { recorded, tracer } = harness();
    recorded.failOnEnd = true;
    diag.setLogger(throwingDiagLogger);
    const wrapped = captureMethod(tracer, "op", () => 9);
    // diag.warn の throw が漏れると呼び出し側 catch → failSpan で end が 2 度呼ばれ、
    // 戻り値が "diagnostic failure" に置き換わる。
    expect(wrapped()).toBe(9);
    expect(recorded.ended).toBe(1);
    expect(recorded.exceptions).toHaveLength(0);
  });

  it("keeps the original error when recordException AND the diag logger both throw", () => {
    const { recorded, tracer } = harness();
    recorded.failOnRecord = true;
    const err = new Error("original");
    diag.setLogger(throwingDiagLogger);
    const wrapped = captureMethod(tracer, "op", () => {
      throw err;
    });
    expect(() => wrapped()).toThrow(err);
    expect(recorded.ended).toBe(1);
  });

  it("forwards `this` to the wrapped function", () => {
    const { tracer } = harness();
    const obj = {
      base: 10,
      add(this: { base: number }, x: number) {
        return this.base + x;
      },
    };
    const wrapped = captureMethod(tracer, "add", obj.add);
    expect(wrapped.call(obj, 5)).toBe(15);
  });
});
