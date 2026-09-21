import { context, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";
import { AWSXRayPropagator } from "@opentelemetry/propagator-aws-xray";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

/**
 * "w3c"      = OTel SDK を素で使う環境（propagator は tracecontext + baggage）
 * "w3c+xray" = ADOT Lambda layer の既定 `baggage,xray,tracecontext` を模した環境
 *             （composite extract は順に適用され後勝ち — traceparent が xray に勝つ）
 * "xray"     = `OTEL_PROPAGATORS=xray` の環境 — carrier は `x-amzn-trace-id` のみ
 */
export type PropagatorMode = "w3c" | "w3c+xray" | "xray";

export interface OtelHarness {
  readonly mode: PropagatorMode;
  spans(): ReadableSpan[];
  reset(): void;
  teardown(): Promise<void>;
}

export function setupOtel(mode: PropagatorMode): OtelHarness {
  trace.disable();
  propagation.disable();
  context.disable();

  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  context.setGlobalContextManager(contextManager);
  trace.setGlobalTracerProvider(provider);

  // ADOT layer 既定の `baggage,xray,tracecontext` と同じ順序 — composite extract は
  // 順に適用され後勝ちするので、両方の key を持つ carrier では traceparent が選ばれる。
  const propagators: (W3CTraceContextPropagator | W3CBaggagePropagator | AWSXRayPropagator)[] =
    mode === "xray"
      ? [new AWSXRayPropagator()]
      : mode === "w3c+xray"
        ? [new W3CBaggagePropagator(), new AWSXRayPropagator(), new W3CTraceContextPropagator()]
        : [new W3CTraceContextPropagator(), new W3CBaggagePropagator()];
  propagation.setGlobalPropagator(new CompositePropagator({ propagators }));

  return {
    mode,
    spans: () => exporter.getFinishedSpans(),
    reset: () => exporter.reset(),
    teardown: async () => {
      await provider.shutdown();
      contextManager.disable();
      trace.disable();
      propagation.disable();
      context.disable();
    },
  };
}

export function spanNamed(spans: ReadableSpan[], name: string): ReadableSpan {
  const span = spans.find((s) => s.name === name);
  if (!span)
    throw new Error(`span "${name}" not found in [${spans.map((s) => s.name).join(", ")}]`);
  return span;
}

/**
 * 実行時ガード検証用の「型の嘘」を 1 か所へ集約するキャスト。
 * malformed 入力をテストへ散らさず、意図（production type を満たさない値を
 * あえて流す）を名前で示す。
 */
export function asMalformed(value: unknown): never {
  return value as never;
}
