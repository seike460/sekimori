import { context, propagation, type SpanContext, trace } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractFromSnsRecord,
  injectSnsMessage,
  injectSnsPublishBatch,
  type SdkMessageAttributes,
  SekimoriError,
  type SnsPublishBatchLike,
} from "../src/index.js";
import { type OtelHarness, setupOtel } from "./otel-setup.js";

const harness: OtelHarness = setupOtel("w3c");
const tracer = trace.getTracer("test");
afterAll(() => harness.teardown());
beforeEach(() => harness.reset());

const _TOPIC_ARN = "arn:aws:sns:ap-northeast-1:123456789012:events";

function publish(input: Parameters<typeof injectSnsMessage>[0] = {}) {
  let producer!: SpanContext;
  let injected!: ReturnType<typeof injectSnsMessage>;
  tracer.startActiveSpan("publish", (span) => {
    producer = span.spanContext();
    injected = injectSnsMessage(input);
    span.end();
  });
  return { producer, injected };
}

/** SDK 形（PascalCase）を SNS record / envelope 形（`{ Type, Value }`）に変換する。 */
function _toSnsAttributes(attrs: SdkMessageAttributes | undefined) {
  return Object.fromEntries(
    Object.entries(attrs ?? {}).map(([k, v]) => [k, { Type: v.DataType, Value: v.StringValue }]),
  );
}

describe("injectSnsMessage", () => {
  it("adds W3C attributes and never the X-Ray field", () => {
    const { producer, injected } = publish({ Message: "hello" });
    expect(injected.MessageAttributes?.traceparent?.StringValue).toContain(producer.traceId);
    expect(
      Object.keys(injected.MessageAttributes ?? {}).some(
        (k) => k.toLowerCase() === "x-amzn-trace-id",
      ),
    ).toBe(false);
  });

  it("refuses more attributes than the downstream SQS quota", () => {
    const many = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`k${i}`, { DataType: "String", StringValue: "v" }]),
    );
    expect(() => publish({ MessageAttributes: many })).toThrow(SekimoriError);
  });

  it("injects every entry of a PublishBatch input", () => {
    const input: SnsPublishBatchLike = {
      PublishBatchRequestEntries: [
        { Id: "1", Message: "a" },
        { Id: "2", Message: "b" },
      ],
    };
    let batch!: ReturnType<typeof injectSnsPublishBatch>;
    tracer.startActiveSpan("publish-batch", (span) => {
      batch = injectSnsPublishBatch(input);
      span.end();
    });
    expect(batch.PublishBatchRequestEntries).toHaveLength(2);
    expect(batch.PublishBatchRequestEntries?.every((e) => e.MessageAttributes?.traceparent)).toBe(
      true,
    );
  });
});

describe("Round-10 hardening", () => {
  it("validates options.context even when the batch has no entries (R10-A)", () => {
    const partial = { getValue: () => undefined };
    // @ts-expect-error runtime guard の検証
    expect(() => injectSnsPublishBatch({}, { context: partial })).toThrow(SekimoriError);
    expect(() =>
      // @ts-expect-error runtime guard の検証 — 空 entries でも context は検証する
      injectSnsPublishBatch({ PublishBatchRequestEntries: [] }, { context: partial }),
    ).toThrow(SekimoriError);
  });

  it("rejects a non-object MessageAttributes map (R10-A)", () => {
    // @ts-expect-error runtime guard の検証
    expect(() => injectSnsMessage({ MessageAttributes: "abc" })).toThrow(SekimoriError);
    // @ts-expect-error runtime guard の検証
    expect(() => injectSnsMessage({ MessageAttributes: [] })).toThrow(SekimoriError);
    expect(() =>
      // @ts-expect-error runtime guard — Map は spread で {} になり属性が silent 喪失する
      injectSnsMessage({ MessageAttributes: new Map([["k", { StringValue: "v" }]]) }),
    ).toThrow(SekimoriError);
  });
});

describe("suppression (R11-A)", () => {
  it("writes no MessageAttributes when the context is suppressed", () => {
    tracer.startActiveSpan("sns-sup", (span) => {
      const injected = injectSnsMessage({}, { context: suppressTracing(context.active()) });
      span.end();
      expect("MessageAttributes" in injected).toBe(false);
    });
  });
});

describe("Round-12 hardening (pinned traceparent conflict)", () => {
  const PIN_A = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
  const XRAY_A = "Root=1-aaaaaaaa-aaaaaaaaaaaaaaaaaaaaaaaa;Parent=bbbbbbbbbbbbbbbb;Sampled=1";

  it("keeps the caller's xray attribute on a pin conflict", () => {
    // SNS に native channel は無いが、attribute map 内では同じ split-brain になる —
    // pin が別 trace を指すのに fresh な x-amzn-trace-id を書かない。
    const callerXray = { DataType: "String", StringValue: XRAY_A };
    tracer.startActiveSpan("sns-pin-conflict", (span) => {
      const injected = injectSnsMessage({
        Message: "{}",
        MessageAttributes: {
          traceparent: { DataType: "String", StringValue: PIN_A },
          "x-amzn-trace-id": callerXray,
        },
      });
      span.end();
      const attrs = injected.MessageAttributes ?? {};
      expect(attrs.traceparent?.StringValue).toBe(PIN_A);
      expect(attrs["x-amzn-trace-id"]).toBe(callerXray);
    });
  });

  it("removes a stale x-amzn-trace-id attribute that disagrees with the pin (R19)", () => {
    // pin と別 trace の xray attribute が残ると xray を優先する読み手が pin に勝つ。
    const XRAY_C = "Root=1-cccccccc-cccccccccccccccccccccccc;Parent=dddddddddddddddd;Sampled=1";
    tracer.startActiveSpan("sns-pin-stale-xray", (span) => {
      const injected = injectSnsMessage({
        Message: "{}",
        MessageAttributes: {
          traceparent: { DataType: "String", StringValue: PIN_A },
          "x-amzn-trace-id": { DataType: "String", StringValue: XRAY_C },
        },
      });
      span.end();
      const attrs = injected.MessageAttributes ?? {};
      expect(attrs.traceparent?.StringValue).toBe(PIN_A);
      expect(attrs["x-amzn-trace-id"]).toBeUndefined();
    });
  });

  it("propagates extractor errors instead of degrading to 'none'", () => {
    // Message の JSON.parse 失敗だけを飲み込む — propagator の throw をここで飲むと
    // extract が silent に `none` へ落ちる。
    const spy = vi.spyOn(propagation, "extract").mockImplementation(() => {
      throw new Error("propagator boom");
    });
    try {
      expect(() => extractFromSnsRecord({ Sns: { Message: JSON.stringify({ a: 1 }) } })).toThrow(
        "propagator boom",
      );
    } finally {
      spy.mockRestore();
    }
  });
});
