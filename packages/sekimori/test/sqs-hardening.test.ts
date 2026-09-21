import { context, propagation, type SpanContext, trace } from "@opentelemetry/api";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  extractFromSqsRecord,
  injectSqsMessage,
  linksFromSqsEvent,
  type SdkMessageAttributes,
  SekimoriError,
  withSqsRecord,
} from "../src/index.js";
import { asMalformed, type OtelHarness, setupOtel, spanNamed } from "./otel-setup.js";

const harness: OtelHarness = setupOtel("w3c");
const tracer = trace.getTracer("test");
afterAll(() => harness.teardown());
beforeEach(() => harness.reset());

const QUEUE_ARN = "arn:aws:sqs:ap-northeast-1:123456789012:orders-queue";

function send(
  input: Parameters<typeof injectSqsMessage>[0] = {},
  options?: Parameters<typeof injectSqsMessage>[1],
) {
  let producer!: SpanContext;
  let injected!: ReturnType<typeof injectSqsMessage>;
  tracer.startActiveSpan("send", (span) => {
    producer = span.spanContext();
    injected = injectSqsMessage(input, options);
    span.end();
  });
  return { producer, injected };
}

/** SDK 形（PascalCase）の属性を Lambda record 形（camelCase）に変換する。 */
function toRecordAttributes(attrs: SdkMessageAttributes | undefined) {
  return Object.fromEntries(
    Object.entries(attrs ?? {}).map(([k, v]) => [
      k,
      { dataType: v.DataType, stringValue: v.StringValue },
    ]),
  );
}

describe("Round-5 hardening", () => {
  it("skips array records in a batch instead of failing the whole batch (R5-A-1)", () => {
    // [] は typeof === "object" だが assertObject は弾く — guard を同じ形に揃えないと
    // batch 全体が SekimoriError で落ちる。
    const a = send();
    const links = linksFromSqsEvent(
      asMalformed({
        Records: [[], { messageAttributes: toRecordAttributes(a.injected.MessageAttributes) }],
      }),
    );
    expect(links.map((l) => l.context.spanId)).toEqual([a.producer.spanId]);
  });

  it("does not coerce a malformed ApproximateReceiveCount into an attribute (R5-A-2)", async () => {
    // "" → 0、"0x10" → 16 のような誤 coercion は「無い値」として捨てる。
    for (const raw of ["", "0x10", "1e3", null] as const) {
      await withSqsRecord(
        asMalformed({ attributes: { ApproximateReceiveCount: raw }, eventSourceARN: QUEUE_ARN }),
        () => undefined,
      );
      const consumer = spanNamed(harness.spans(), "process orders-queue");
      expect(consumer.attributes["aws.sqs.approximate_receive_count"]).toBeUndefined();
      harness.reset();
    }
    await withSqsRecord(
      { attributes: { ApproximateReceiveCount: "3" }, eventSourceARN: QUEUE_ARN },
      () => undefined,
    );
    expect(
      spanNamed(harness.spans(), "process orders-queue").attributes[
        "aws.sqs.approximate_receive_count"
      ],
    ).toBe(3);
  });

  it("does not write an empty MessageAttributes object (R5-A-5)", () => {
    // 書く attribute が無く入力にも無いなら phantom field を付けない（EventBridge/Kinesis と同じ方針）。
    const injected = injectSqsMessage({}, { w3c: false, xrayHeader: false });
    expect("MessageAttributes" in injected).toBe(false);
    // 入力に空の MessageAttributes がある場合は保持する（caller's key は触らない）。
    const kept = injectSqsMessage({ MessageAttributes: {} }, { w3c: false, xrayHeader: false });
    expect(kept.MessageAttributes).toEqual({});
  });

  it("does not set messaging.message.id from a non-string messageId (R5-A-4)", async () => {
    await withSqsRecord(asMalformed({ messageId: {}, eventSourceARN: QUEUE_ARN }), () => undefined);
    const consumer = spanNamed(harness.spans(), "process orders-queue");
    expect(consumer.attributes["messaging.message.id"]).toBeUndefined();
  });

  it("removes a stale x-amzn-trace-id attribute when a fresh traceparent is written (R8-A)", () => {
    // `x-amzn-trace-id` は伝播 slot — 古い hop の値を残すと xray を優先する読み手
    // （xray-only propagator / xray-last 構成 / extract の messageAttributes 優先経路）が
    // fresh な traceparent より stale context を選ぶ split-brain になるため消す。
    const { producer, injected } = send({
      MessageAttributes: {
        "x-amzn-trace-id": {
          DataType: "String",
          StringValue: "Root=1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb;Parent=cccccccccccccccc;Sampled=1",
        },
        keep: { DataType: "String", StringValue: "v" },
      },
    });
    const attrs = injected.MessageAttributes ?? {};
    expect(attrs["x-amzn-trace-id"]).toBeUndefined();
    expect(attrs.traceparent?.StringValue).toContain(producer.traceId);
    expect(attrs.keep?.StringValue).toBe("v");
  });

  it("rejects non-boolean w3c / invalid xrayHeader (R8-A assertInjectOptions)", () => {
    expect(() => injectSqsMessage({}, asMalformed({ w3c: "false" }))).toThrow(SekimoriError);
    expect(() => injectSqsMessage({}, asMalformed({ xrayHeader: "yes" }))).toThrow(SekimoriError);
    // "auto" は有効値
    expect(() => injectSqsMessage({}, { xrayHeader: "auto" })).not.toThrow();
  });

  it("rejects a partial Context fake missing setValue/deleteValue (R8-A)", () => {
    const partial = { getValue: () => undefined };
    expect(() => extractFromSqsRecord({}, { context: asMalformed(partial) })).toThrow(
      SekimoriError,
    );
    expect(() => injectSqsMessage({}, { context: asMalformed(partial) })).toThrow(SekimoriError);
  });

  it("rejects a null options argument with a named error (R5-A-6)", () => {
    expect(() => injectSqsMessage({}, asMalformed(null))).toThrow(SekimoriError);
    expect(() => extractFromSqsRecord({}, asMalformed(null))).toThrow(SekimoriError);
    expect(() => linksFromSqsEvent({ Records: [] }, asMalformed(null))).toThrow(SekimoriError);
  });
});

describe("Round-9 hardening", () => {
  it("w3c:false drops a stale x-amzn-trace-id attribute when a fresh AWSTraceHeader is written (R9-A)", () => {
    // extract は messageAttributes を先に読む — w3c:false でも fresh な context を書く以上、
    // 入力由来の stale `x-amzn-trace-id` を残すと fresh な system attribute に勝ってしまう。
    const { producer, injected } = send(
      {
        MessageAttributes: {
          "x-amzn-trace-id": {
            DataType: "String",
            StringValue:
              "Root=1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb;Parent=cccccccccccccccc;Sampled=1",
          },
        },
      },
      { w3c: false },
    );
    expect(injected.MessageAttributes?.["x-amzn-trace-id"]).toBeUndefined();
    const header = injected.MessageSystemAttributes?.AWSTraceHeader?.StringValue;
    expect(header).toContain(producer.traceId.slice(8));

    const extracted = extractFromSqsRecord({
      attributes: { AWSTraceHeader: header },
      messageAttributes: toRecordAttributes(injected.MessageAttributes),
    });
    expect(extracted.source).toBe("aws-trace-header");
    expect(extracted.spanContext?.traceId).toBe(producer.traceId);
  });

  it("dedupes links to the same producer span in linksFromSqsEvent (R9-A)", () => {
    const { producer, injected } = send();
    const record = {
      messageId: "m-1",
      eventSourceARN: QUEUE_ARN,
      messageAttributes: toRecordAttributes(injected.MessageAttributes),
    };
    const links = linksFromSqsEvent({
      Records: [record, { ...record, messageId: "m-2" }],
    });
    expect(links).toHaveLength(1);
    expect(links[0]?.context.spanId).toBe(producer.spanId);
  });

  it("keeps base baggage entries in the extracted context (R9-A preserveBaseBaggage)", () => {
    const { injected } = send();
    const base = propagation.setBaggage(
      context.active(),
      propagation.createBaggage({ localOnly: { value: "keep" } }),
    );
    const extracted = extractFromSqsRecord(
      {
        messageAttributes: toRecordAttributes(injected.MessageAttributes),
      },
      { context: base },
    );
    expect(extracted.spanContext).toBeDefined();
    expect(propagation.getBaggage(extracted.context)?.getEntry("localOnly")?.value).toBe("keep");
  });
});

describe("Round-10 hardening", () => {
  it("keeps a stale x-amzn-trace-id when only fresh baggage is written (R10-C)", () => {
    // span context を書かない inject（baggage-only）は span slot を触らない —
    // 「caller が pin した slot は inject が消さない」契約と、caller の slot を fresh な
    // 置き換えなしに削除しない方針（augment, don't re-root）を固定する。
    // stale slot が残ると consumer は古い span + fresh baggage の mixed context を
    // 拾い得るが、それは入力側が置いた slot の尊重として BOUNDARIES.md に記録する caveat。
    const bagOnly = propagation.setBaggage(
      context.active(),
      propagation.createBaggage({ tenant: { value: "t1" } }),
    );
    const injected = injectSqsMessage(
      {
        MessageAttributes: {
          "x-amzn-trace-id": {
            DataType: "String",
            StringValue:
              "Root=1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb;Parent=cccccccccccccccc;Sampled=1",
          },
        },
      },
      { context: bagOnly },
    );
    const attrs = injected.MessageAttributes ?? {};
    expect(attrs["x-amzn-trace-id"]?.StringValue).toContain("Root=1-aaaaaaaa");
    expect(attrs.baggage?.StringValue).toContain("tenant=t1");
    // span context が無いので traceparent は書かれない
    expect(attrs.traceparent).toBeUndefined();
  });

  it("scrubs stale W3C span slots when a fresh AWSTraceHeader is written under w3c:false (R10-C)", () => {
    // ADOT 既定の composite（baggage,xray,tracecontext — tracecontext が後勝ち）では、
    // stale な traceparent が fresh な AWSTraceHeader に勝つ split-brain になるため消す。
    tracer.startActiveSpan("sqs-xray", (span) => {
      const injected = injectSqsMessage(
        {
          MessageAttributes: {
            traceparent: {
              DataType: "String",
              StringValue: "00-11111111111111111111111111111111-2222222222222222-01",
            },
            tracestate: { DataType: "String", StringValue: "vendor=old" },
          },
        },
        { w3c: false },
      );
      span.end();
      const attrs = injected.MessageAttributes ?? {};
      expect(attrs.traceparent).toBeUndefined();
      expect(attrs.tracestate).toBeUndefined();
      expect(injected.MessageSystemAttributes?.AWSTraceHeader?.StringValue).toMatch(
        /^Root=1-[0-9a-f]{8}-[0-9a-f]{24}/,
      );
    });
  });

  it("reads a valid StringValue when stringValue is present but empty (R10-A)", () => {
    // camelCase `stringValue` が空文字/非 string でも PascalCase `StringValue` 側を読む。
    const { producer, injected } = send();
    const valid = injected.MessageAttributes?.traceparent?.StringValue ?? "";
    const extracted = extractFromSqsRecord({
      messageAttributes: {
        traceparent: { stringValue: "", StringValue: valid },
      },
    });
    expect(extracted.spanContext?.traceId).toBe(producer.traceId);
  });

  it("rejects non-object MessageAttributes / MessageSystemAttributes (R10-A)", () => {
    // string は spread でゴミ key になる / array は index key になる
    expect(() => injectSqsMessage({ MessageAttributes: asMalformed("abc") })).toThrow(
      SekimoriError,
    );
    expect(() => injectSqsMessage({ MessageAttributes: asMalformed([]) })).toThrow(SekimoriError);
    // Map は spread で {} になり属性が silent 喪失する
    expect(() =>
      injectSqsMessage({
        MessageAttributes: asMalformed(new Map([["k", { StringValue: "v" }]])),
      }),
    ).toThrow(SekimoriError);
    expect(() => injectSqsMessage({ MessageSystemAttributes: asMalformed("abc") })).toThrow(
      SekimoriError,
    );
  });
});
