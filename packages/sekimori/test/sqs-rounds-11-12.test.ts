import { context, type SpanContext, trace } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  extractFromSqsRecord,
  formatXrayTraceHeader,
  injectSqsMessage,
  type SdkMessageAttributes,
} from "../src/index.js";
import { type OtelHarness, setupOtel } from "./otel-setup.js";

const harness: OtelHarness = setupOtel("w3c");
const tracer = trace.getTracer("test");
afterAll(() => harness.teardown());
beforeEach(() => harness.reset());

const _QUEUE_ARN = "arn:aws:sqs:ap-northeast-1:123456789012:orders-queue";

function _send(
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

describe("suppression (R11-A)", () => {
  it("writes no carrier fields or AWSTraceHeader when the context is suppressed", () => {
    tracer.startActiveSpan("sqs-sup", (span) => {
      const injected = injectSqsMessage({}, { context: suppressTracing(context.active()) });
      span.end();
      expect("MessageAttributes" in injected).toBe(false);
      expect("MessageSystemAttributes" in injected).toBe(false);
    });
  });
});

describe("Round-11 hardening", () => {
  it("treats a caller-pinned traceparent/tracestate as an atomic pair (R11-A)", () => {
    // caller が traceparent だけ pin した状態で carrier が tracestate を出すと、
    // {pin された A の traceparent, carrier 由来 B の tracestate} の壊れた pair になる。
    // pin は対として扱う — 片方でも既存なら carrier 側の両方を書かない。
    const pinned = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
    tracer.startActiveSpan("sqs-pin", (span) => {
      const injected = injectSqsMessage({
        MessageAttributes: {
          traceparent: { DataType: "String", StringValue: pinned },
        },
      });
      span.end();
      const attrs = injected.MessageAttributes ?? {};
      expect(attrs.traceparent?.StringValue).toBe(pinned);
      expect(attrs.tracestate).toBeUndefined();
      expect(attrs["x-amzn-trace-id"]).toBeUndefined();
    });
    // 逆方向: tracestate だけ pin → carrier の fresh traceparent も書かない。
    tracer.startActiveSpan("sqs-pin2", (span) => {
      const injected = injectSqsMessage({
        MessageAttributes: {
          tracestate: { DataType: "String", StringValue: "vendor=pinned" },
        },
      });
      span.end();
      const attrs = injected.MessageAttributes ?? {};
      expect(attrs.tracestate?.StringValue).toBe("vendor=pinned");
      expect(attrs.traceparent).toBeUndefined();
    });
  });
});

describe("Round-12 hardening (pinned traceparent conflict)", () => {
  // pin = caller の明示指定が carrier の fresh context に勝つ。pin が active span と
  // 別 trace を指すのに fresh な AWSTraceHeader を書くと、attribute を読む側（pin）と
  // X-Ray channel を読む側で trace が分かれる — X-Ray slot の書き込みを抑止して
  // pin に揃える。`MessageAttributes` の値は `{ DataType, StringValue }` 形なので
  // unwrap しないと pin が読めない（R12-A: 以前は unwrap 漏れで抑止が効かなかった）。
  const PIN_A = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
  const XRAY_A = "Root=1-aaaaaaaa-aaaaaaaaaaaaaaaaaaaaaaaa;Parent=bbbbbbbbbbbbbbbb;Sampled=1";

  it("suppresses AWSTraceHeader and keeps the caller's xray attribute on a pin conflict", () => {
    const callerXray = { DataType: "String", StringValue: XRAY_A };
    tracer.startActiveSpan("sqs-pin-conflict", (span) => {
      const injected = injectSqsMessage({
        MessageAttributes: {
          traceparent: { DataType: "String", StringValue: PIN_A },
          "x-amzn-trace-id": callerXray,
        },
      });
      span.end();
      const attrs = injected.MessageAttributes ?? {};
      expect(attrs.traceparent?.StringValue).toBe(PIN_A);
      expect(attrs["x-amzn-trace-id"]).toBe(callerXray);
      expect(injected.MessageSystemAttributes?.AWSTraceHeader).toBeUndefined();
    });
  });

  it("still writes AWSTraceHeader when the pin matches the active trace", () => {
    tracer.startActiveSpan("sqs-pin-same", (span) => {
      const sc = span.spanContext();
      const injected = injectSqsMessage({
        MessageAttributes: {
          traceparent: {
            DataType: "String",
            StringValue: `00-${sc.traceId}-${sc.spanId}-01`,
          },
        },
      });
      span.end();
      expect(injected.MessageSystemAttributes?.AWSTraceHeader?.StringValue).toContain(
        `Parent=${sc.spanId}`,
      );
    });
  });

  it("reads the pin through camelCase stringValue too", () => {
    // record 形（camelCase）を inject 入力に回す JS 利用者もいる — 両形を読む。
    const callerXray = { dataType: "String", stringValue: XRAY_A };
    tracer.startActiveSpan("sqs-pin-camel", (span) => {
      const injected = injectSqsMessage({
        MessageAttributes: {
          traceparent: { DataType: "String", stringValue: PIN_A } as never,
          "x-amzn-trace-id": callerXray as never,
        },
      });
      span.end();
      expect(injected.MessageSystemAttributes?.AWSTraceHeader).toBeUndefined();
      expect(injected.MessageAttributes?.["x-amzn-trace-id"]).toBe(callerXray);
    });
  });

  it("reads the pin via stringValue when StringValue is empty (getter precedence)", () => {
    // extractor（recordAttributesGetter）は空でない `stringValue` を先に読む — pin 判定も
    // 同じ順で読まないと、extractor が読む pin を見落として split-brain 抑止が効かない。
    tracer.startActiveSpan("sqs-pin-order", (span) => {
      const injected = injectSqsMessage({
        MessageAttributes: {
          traceparent: {
            DataType: "String",
            StringValue: "",
            stringValue: PIN_A,
          } as never,
        },
      });
      span.end();
      expect(injected.MessageSystemAttributes?.AWSTraceHeader).toBeUndefined();
    });
  });

  it("does not treat a spec-invalid pinned traceparent as a conflicting context", () => {
    // all-zero trace-id / 不正な span-id の pin は compliant な extractor が読まない —
    // 「競合する valid context」ではないので X-Ray channel を抑止しない（抑止すると
    // pin は読めない・X-Ray も無い全喪失になる）。
    for (const bad of [
      "00-00000000000000000000000000000000-bbbbbbbbbbbbbbbb-01",
      "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-zz-01",
      "00-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-bbbbbbbbbbbbbbbb-01",
      // version field: `ff` は spec 禁止、非 hex は形式不正（R14）
      "ff-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
      "zz-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
      // flags field の形式不正 / version `00` の extra field（R15: extractor の
      // grammar と一致させるため、compliant には読めない pin を conflict としない）
      "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-zz",
      "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01-extra",
    ]) {
      tracer.startActiveSpan("sqs-pin-invalid", (span) => {
        const injected = injectSqsMessage({
          MessageAttributes: {
            traceparent: { DataType: "String", StringValue: bad },
          },
        });
        span.end();
        expect(injected.MessageSystemAttributes?.AWSTraceHeader?.StringValue).toContain("Root=");
      });
    }
  });

  it("honors a whitespace-wrapped pin that the extractor accepts (R15)", () => {
    // OTel の TRACE_PARENT_REGEX は先頭・末尾の `\s?` を許容する — pin 判定が
    // 厳しすぎると extractor が読める pin を見逃して split-brain になる。
    tracer.startActiveSpan("sqs-pin-ws", (span) => {
      const injected = injectSqsMessage({
        MessageAttributes: {
          traceparent: { DataType: "String", StringValue: ` ${PIN_A}` },
        },
      });
      span.end();
      expect(injected.MessageSystemAttributes?.AWSTraceHeader).toBeUndefined();
    });
  });

  it("suppresses the fresh W3C carrier when the caller pinned a conflicting AWSTraceHeader (R15)", () => {
    // native slot の pin（別 trace）があるのに fresh な W3C carrier を書くと、
    // extract は fresh trace を読み AWS 側の X-Ray view は pin を見る逆向きの
    // split-brain になる — pin は record に配信されるため carrier の span
    // context を抑止し、consumer は attributes.AWSTraceHeader の fallback で
    // pin に揃う。
    tracer.startActiveSpan("sqs-xray-pin-conflict", (span) => {
      const injected = injectSqsMessage({
        MessageSystemAttributes: {
          AWSTraceHeader: { DataType: "String", StringValue: XRAY_A },
        },
      });
      span.end();
      const attrs = injected.MessageAttributes ?? {};
      expect(attrs.traceparent).toBeUndefined();
      expect(attrs.tracestate).toBeUndefined();
      expect(injected.MessageSystemAttributes?.AWSTraceHeader?.StringValue).toBe(XRAY_A);
    });
  });

  it("removes a stale x-amzn-trace-id attribute that would beat the pinned AWSTraceHeader (R18)", () => {
    // pin（trace A）を authoritative にするはずが、別 trace の stale な
    // x-amzn-trace-id attribute が残ると extract は messageAttributes を先に
    // 読んで pin が silent に負ける — pin に揃えるため消す。
    const STALE_XRAY = "Root=1-cccccccc-cccccccccccccccccccccccc;Parent=dddddddddddddddd;Sampled=1";
    tracer.startActiveSpan("sqs-xray-pin-stale-attr", (span) => {
      const injected = injectSqsMessage({
        MessageAttributes: {
          "x-amzn-trace-id": { DataType: "String", StringValue: STALE_XRAY },
        },
        MessageSystemAttributes: {
          AWSTraceHeader: { DataType: "String", StringValue: XRAY_A },
        },
      });
      span.end();
      expect(injected.MessageAttributes?.["x-amzn-trace-id"]).toBeUndefined();
      expect(injected.MessageSystemAttributes?.AWSTraceHeader?.StringValue).toBe(XRAY_A);
      // consumer 側も pin（trace aaaa…）に揃う。
      const extracted = extractFromSqsRecord({
        messageAttributes: toRecordAttributes(injected.MessageAttributes),
        attributes: { AWSTraceHeader: XRAY_A },
      });
      expect(extracted.spanContext?.traceId).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    });
  });

  it("keeps an x-amzn-trace-id attribute that matches the pinned AWSTraceHeader trace (R18)", () => {
    tracer.startActiveSpan("sqs-xray-pin-same", (span) => {
      const injected = injectSqsMessage({
        MessageAttributes: {
          "x-amzn-trace-id": { DataType: "String", StringValue: XRAY_A },
        },
        MessageSystemAttributes: {
          AWSTraceHeader: { DataType: "String", StringValue: XRAY_A },
        },
      });
      span.end();
      expect(injected.MessageAttributes?.["x-amzn-trace-id"]?.StringValue).toBe(XRAY_A);
    });
  });

  it("scrubs stale W3C slots under w3c:false when a conflicting AWSTraceHeader pin exists (R18)", () => {
    // `w3c: false` では入力由来の W3C slot は stale 扱い。pin 衝突で fresh な
    // 書き込みが抑止されると scrub gate が発火せず残ってしまい、extract が
    // messageAttributes の stale traceparent を読んで pin に勝ってしまう。
    tracer.startActiveSpan("sqs-xray-pin-w3cfalse", (span) => {
      const injected = injectSqsMessage(
        {
          MessageAttributes: {
            traceparent: {
              DataType: "String",
              StringValue: "00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-01",
            },
            tracestate: { DataType: "String", StringValue: "vendor=x" },
          },
          MessageSystemAttributes: {
            AWSTraceHeader: { DataType: "String", StringValue: XRAY_A },
          },
        },
        { w3c: false },
      );
      span.end();
      const attrs = injected.MessageAttributes ?? {};
      expect(attrs.traceparent).toBeUndefined();
      expect(attrs.tracestate).toBeUndefined();
      expect(injected.MessageSystemAttributes?.AWSTraceHeader?.StringValue).toBe(XRAY_A);
    });
  });

  it("uses the native pin — not a stale traceparent — as the scrub baseline under w3c:false (R20)", () => {
    // `w3c: false` では attributes の traceparent は stale 扱い — それを pin 基準に
    // すると同 trace の stale pair（traceparent Y + x-amzn-trace-id Y）が残り、
    // consumer の messageAttributes-first extract が pin X を shadow する
    // split-brain になる。consumer が実際に読む pin（native AWSTraceHeader）を
    // 基準にする。
    const STALE_TP = "00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-01";
    const STALE_XRAY = "Root=1-cccccccc-cccccccccccccccccccccccc;Parent=dddddddddddddddd;Sampled=1";
    tracer.startActiveSpan("sqs-xray-pin-baseline", (span) => {
      const injected = injectSqsMessage(
        {
          MessageAttributes: {
            traceparent: { DataType: "String", StringValue: STALE_TP },
            "x-amzn-trace-id": { DataType: "String", StringValue: STALE_XRAY },
          },
          MessageSystemAttributes: {
            AWSTraceHeader: { DataType: "String", StringValue: XRAY_A },
          },
        },
        { w3c: false },
      );
      span.end();
      const attrs = injected.MessageAttributes ?? {};
      expect(attrs.traceparent).toBeUndefined();
      expect(attrs["x-amzn-trace-id"]).toBeUndefined();
      expect(injected.MessageSystemAttributes?.AWSTraceHeader?.StringValue).toBe(XRAY_A);
      // consumer も pin（trace aaaa…）に揃う。
      const extracted = extractFromSqsRecord({
        messageAttributes: toRecordAttributes(injected.MessageAttributes),
        attributes: { AWSTraceHeader: XRAY_A },
      });
      expect(extracted.spanContext?.traceId).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    });
  });

  it("scrubs stale attributes against a same-trace AWSTraceHeader pin too (R21)", () => {
    // pin が active span と一致（衝突しない）場合も native pin は consumer-visible —
    // w3c:false では入力由来の W3C slot は stale 扱いで、pin と別 trace の stale pair
    // が残ると messageAttributes-first の extract が pin を shadow する。
    // 一致・衝突を問わず valid pin 基準で scrub する。
    const STALE_TP = "00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-01";
    const STALE_XRAY = "Root=1-cccccccc-cccccccccccccccccccccccc;Parent=dddddddddddddddd;Sampled=1";
    let pin = "";
    let producerTraceId = "";
    let injected!: ReturnType<typeof injectSqsMessage>;
    tracer.startActiveSpan("sqs-xray-pin-same-trace", (span) => {
      producerTraceId = span.spanContext().traceId;
      pin = formatXrayTraceHeader(span.spanContext());
      injected = injectSqsMessage(
        {
          MessageAttributes: {
            traceparent: { DataType: "String", StringValue: STALE_TP },
            tracestate: { DataType: "String", StringValue: "vendor=x" },
            "x-amzn-trace-id": { DataType: "String", StringValue: STALE_XRAY },
          },
          MessageSystemAttributes: {
            AWSTraceHeader: { DataType: "String", StringValue: pin },
          },
        },
        { w3c: false },
      );
      span.end();
    });
    const attrs = injected.MessageAttributes ?? {};
    expect(attrs.traceparent).toBeUndefined();
    expect(attrs.tracestate).toBeUndefined();
    expect(attrs["x-amzn-trace-id"]).toBeUndefined();
    expect(injected.MessageSystemAttributes?.AWSTraceHeader?.StringValue).toBe(pin);
    // consumer も pin（producer と同じ trace）に揃う — active span の外で extract
    // するのは、base の span context と同一だと newSpanContext が dedup するため。
    const extracted = extractFromSqsRecord({
      messageAttributes: toRecordAttributes(injected.MessageAttributes),
      attributes: { AWSTraceHeader: pin },
    });
    expect(extracted.spanContext?.traceId).toBe(producerTraceId);
  });

  it("removes a stale x-amzn-trace-id attribute on a W3C pin conflict too (R19)", () => {
    // W3C pin（trace A）が authoritative なのに別 trace（C）の x-amzn-trace-id が
    // 残ると、xray を優先する読み手（xray-only propagator / xray-last 構成）が
    // pin に勝つ三者分裂になる — pin の trace に照合して消す。
    const XRAY_C = "Root=1-cccccccc-cccccccccccccccccccccccc;Parent=dddddddddddddddd;Sampled=1";
    tracer.startActiveSpan("sqs-w3c-pin-stale-attr", (span) => {
      const injected = injectSqsMessage({
        MessageAttributes: {
          traceparent: { DataType: "String", StringValue: PIN_A },
          "x-amzn-trace-id": { DataType: "String", StringValue: XRAY_C },
        },
      });
      span.end();
      const attrs = injected.MessageAttributes ?? {};
      expect(attrs.traceparent?.StringValue).toBe(PIN_A);
      expect(attrs["x-amzn-trace-id"]).toBeUndefined();
      // pin と同じ trace の attribute は残す（pin に揃っているため無害）。
      const same = injectSqsMessage({
        MessageAttributes: {
          traceparent: { DataType: "String", StringValue: PIN_A },
          "x-amzn-trace-id": { DataType: "String", StringValue: XRAY_A },
        },
      });
      expect(same.MessageAttributes?.["x-amzn-trace-id"]?.StringValue).toBe(XRAY_A);
    });
  });
});
