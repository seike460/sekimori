import {
  context,
  diag,
  INVALID_SPAN_CONTEXT,
  type Span,
  type SpanContext,
  SpanKind,
  type Tracer,
  type TracerProvider,
  trace,
} from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { SekimoriError } from "../src/errors.js";
import { withConsumerSpan } from "../src/span.js";
import { asMalformed, type OtelHarness, setupOtel, spanNamed } from "./otel-setup.js";

const PRODUCER: SpanContext = {
  traceId: "aabbccddeeff00112233445566778899",
  spanId: "1122334455667788",
  traceFlags: 1,
};

describe("withConsumerSpan", () => {
  let otel: OtelHarness;
  beforeEach(() => {
    otel = setupOtel("w3c");
  });
  afterAll(async () => {
    await otel.teardown();
  });

  it("opens a CONSUMER span around fn and ends it", async () => {
    const value = await withConsumerSpan("process", { parent: context.active() }, () => "done");
    expect(value).toBe("done");
    const span = spanNamed(otel.spans(), "process");
    expect(span.kind).toBe(SpanKind.CONSUMER);
  });

  it("attaches a link to the producer SpanContext", async () => {
    await withConsumerSpan("process", { parent: context.active(), link: PRODUCER }, () => {});
    const span = spanNamed(otel.spans(), "process");
    expect(span.links).toHaveLength(1);
    expect(span.links[0]?.context.spanId).toBe(PRODUCER.spanId);
  });

  it("skips the link when the producer context equals the parent span", async () => {
    const parent = trace.setSpanContext(context.active(), PRODUCER);
    await withConsumerSpan("process", { parent, link: PRODUCER }, () => {});
    const span = spanNamed(otel.spans(), "process");
    expect(span.links).toHaveLength(0);
  });

  it("skips the link for an invalid SpanContext", async () => {
    await withConsumerSpan(
      "process",
      { parent: context.active(), link: INVALID_SPAN_CONTEXT },
      () => {},
    );
    expect(spanNamed(otel.spans(), "process").links).toHaveLength(0);
  });

  it("honors the kind override", async () => {
    await withConsumerSpan("http", { parent: context.active(), kind: SpanKind.SERVER }, () => {});
    expect(spanNamed(otel.spans(), "http").kind).toBe(SpanKind.SERVER);
  });

  it("records the error, sets ERROR status, rethrows, and still ends the span", async () => {
    const boom = new Error("boom");
    await expect(
      withConsumerSpan("process", { parent: context.active() }, () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    const span = spanNamed(otel.spans(), "process");
    expect(span.status.code).toBe(2); // SpanStatusCode.ERROR
    expect(span.status.message).toBe("boom");
    expect(span.events.some((e) => e.name === "exception")).toBe(true);
  });

  it("keeps Exception-shaped thrown objects in the exception event", async () => {
    const remote = { name: "RemoteError", message: "boom", stack: "remote stack" };
    await expect(
      withConsumerSpan("process", { parent: context.active() }, () => {
        throw remote;
      }),
    ).rejects.toBe(remote);
    const span = spanNamed(otel.spans(), "process");
    const event = span.events.find((e) => e.name === "exception");
    // 実 SDK の recordException は Exception object の name/message/stack を
    // event attribute に載せる — "[object Object]" 化していないことを確認。
    expect(event?.attributes?.["exception.type"]).toBe("RemoteError");
    expect(event?.attributes?.["exception.message"]).toBe("boom");
    expect(span.status.message).toBe("boom");
  });

  it("runs fn without recording a span under suppressTracing", async () => {
    const suppressed = suppressTracing(context.active());
    const result = await withConsumerSpan("process", { parent: suppressed }, (span) =>
      span.isRecording(),
    );
    expect(result).toBe(false);
    expect(otel.spans()).toHaveLength(0);
  });

  describe("diag logger failure (R10)", () => {
    // OTel API は登録済み logger の例外を捕捉しない — diag.warn が投げると
    // 保護 catch を突き抜けて結果・元の例外を上書きする。
    const throwingLogger = {
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

    /** `withConsumerSpan` は global provider の tracer を使う — fake span を返す provider に差し替える。 */
    function registerFakeTracer(span: Span): void {
      trace.disable();
      trace.setGlobalTracerProvider({
        getTracer: () =>
          ({
            startSpan: () => span,
            startActiveSpan: (<R>(
              _name: string,
              _opts: unknown,
              _ctx: unknown,
              fn?: (span: Span) => R,
            ): R => (fn as (span: Span) => R)(span)) as Tracer["startActiveSpan"],
          }) as Tracer,
      } as TracerProvider);
    }

    it("keeps fn's result when span.end() AND the diag logger both throw", async () => {
      let ended = 0;
      const span = {} as Span;
      span.end = () => {
        ended += 1;
        throw new Error("end failed");
      };
      registerFakeTracer(span);
      diag.setLogger(throwingLogger);
      const value = await withConsumerSpan("process", { parent: context.active() }, () => "ok");
      expect(value).toBe("ok");
      expect(ended).toBe(1);
    });

    it("keeps the original error when recordException AND the diag logger both throw", async () => {
      let ended = 0;
      const boom = new Error("boom");
      const span = {} as Span;
      span.recordException = () => {
        throw new Error("record failed");
      };
      span.setStatus = () => span;
      span.end = () => {
        ended += 1;
      };
      registerFakeTracer(span);
      diag.setLogger(throwingLogger);
      await expect(
        withConsumerSpan("process", { parent: context.active() }, () => {
          throw boom;
        }),
      ).rejects.toBe(boom);
      expect(ended).toBe(1);
    });
  });

  describe("argument validation", () => {
    it.each<[string | number, string]>([
      ["", "non-empty string"],
      [5, "non-empty string"],
    ])("rejects name %j", async (name) => {
      await expect(
        withConsumerSpan(asMalformed(name), { parent: context.active() }, () => {}),
      ).rejects.toThrow(SekimoriError);
    });

    it("rejects a non-Context parent", async () => {
      await expect(withConsumerSpan("x", { parent: asMalformed({}) }, () => {})).rejects.toThrow(
        "must be an OpenTelemetry Context",
      );
    });

    it("rejects a kind that is not a SpanKind enum value", async () => {
      await expect(
        withConsumerSpan("x", { parent: context.active(), kind: asMalformed(99) }, () => {}),
      ).rejects.toThrow("SpanKind enum value");
    });

    it("rejects a non-function fn", async () => {
      await expect(
        withConsumerSpan("x", { parent: context.active() }, asMalformed(42)),
      ).rejects.toThrow("expected a function");
    });

    it("rejects malformed attributes", async () => {
      await expect(
        withConsumerSpan(
          "x",
          { parent: context.active(), attributes: asMalformed("nope") },
          () => {},
        ),
      ).rejects.toThrow(SekimoriError);
    });
  });
});
