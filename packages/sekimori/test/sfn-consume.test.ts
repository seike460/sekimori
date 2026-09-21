import { type SpanContext, SpanKind, trace } from "@opentelemetry/api";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  extractFromStateInput,
  injectStartExecution,
  SFN_TRACE_FIELD,
  withStepFunctionsTask,
} from "../src/index.js";
import { type OtelHarness, setupOtel, spanNamed } from "./otel-setup.js";

const harness: OtelHarness = setupOtel("w3c");
const tracer = trace.getTracer("test");
afterAll(() => harness.teardown());
beforeEach(() => harness.reset());

function start(input: Parameters<typeof injectStartExecution>[0] = {}) {
  let producer!: SpanContext;
  let injected!: ReturnType<typeof injectStartExecution>;
  tracer.startActiveSpan("start-execution", (span) => {
    producer = span.spanContext();
    injected = injectStartExecution(input);
    span.end();
  });
  return { producer, injected };
}

describe("extractFromStateInput / withStepFunctionsTask", () => {
  it("extracts the producer context from _trace", () => {
    const { producer, injected } = start({ input: JSON.stringify({ n: 1 }) });
    const event = JSON.parse(injected.input!);
    const extracted = extractFromStateInput(event);
    expect(extracted.source).toBe("state-input");
    expect(extracted.spanContext?.spanId).toBe(producer.spanId);
  });

  it("returns none when _trace is absent or malformed", () => {
    expect(extractFromStateInput({}).source).toBe("none");
    expect(extractFromStateInput({ [SFN_TRACE_FIELD]: "x" }).source).toBe("none");
  });

  it("accepts non-object state input as none — scalar/array/null are valid SFN inputs (R4-A-5)", () => {
    // Pass/Task state は scalar や array を素直に渡し得る。carrier を持ち得ないので none。
    expect(extractFromStateInput("just a string").source).toBe("none");
    expect(extractFromStateInput([1, 2, 3]).source).toBe("none");
    expect(extractFromStateInput(null).source).toBe("none");
    expect(extractFromStateInput(42).source).toBe("none");
  });

  it("accepts interface-typed events — no index signature required (R4-A-4)", async () => {
    interface TaskInput {
      orderId: string;
    }
    const event: TaskInput = { orderId: "o-9" };
    expect(extractFromStateInput(event).source).toBe("none");
    let ran = false;
    await withStepFunctionsTask(event, () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("reports state-input-flattened when the carrier sits at the event root", () => {
    const { producer } = start({ input: "{}" });
    const extracted = extractFromStateInput({
      traceparent: `00-${producer.traceId}-${producer.spanId}-01`,
    });
    expect(extracted.source).toBe("state-input-flattened");
    expect(extracted.spanContext?.spanId).toBe(producer.spanId);
  });

  it("reads a carrier nested in detail — EventBridge→StartExecution input (R16)", () => {
    // EB→SFN では event 本体が実行 input になる — carrier は detail にネストされる。
    const { producer } = start({ input: "{}" });
    const extracted = extractFromStateInput({
      version: "0",
      id: "evt-1",
      source: "app.orders",
      "detail-type": "OrderCreated",
      detail: {
        orderId: "o-1",
        traceparent: `00-${producer.traceId}-${producer.spanId}-01`,
      },
    });
    expect(extracted.source).toBe("body-detail");
    expect(extracted.spanContext?.spanId).toBe(producer.spanId);
  });

  it("opens a CONSUMER span linked to the producer with sfn attributes", async () => {
    const { producer, injected } = start({ input: "{}" });
    const event = JSON.parse(injected.input!);
    await tracer.startActiveSpan("invocation", async (inv) => {
      await withStepFunctionsTask(event, () => undefined, {
        stateMachineArn: "arn:aws:states:ap-northeast-1:1:stateMachine:sm",
      });
      inv.end();
    });
    const consumer = spanNamed(harness.spans(), "process stepfunctions-task");
    expect(consumer.kind).toBe(SpanKind.CONSUMER);
    expect(consumer.links.map((l) => l.context.spanId)).toEqual([producer.spanId]);
    expect(consumer.attributes).toMatchObject({
      "messaging.system": "aws_stepfunctions",
      "aws.sfn.state_machine_arn": "arn:aws:states:ap-northeast-1:1:stateMachine:sm",
      "sekimori.context.source": "state-input",
    });
  });
});

describe("Round-7 hardening", () => {
  it("treats `_trace: null` as absent and writes the carrier (inject/extract symmetry)", () => {
    const { producer, injected } = start({
      input: JSON.stringify({ [SFN_TRACE_FIELD]: null }),
    });
    const parsed = JSON.parse(injected.input!);
    expect(parsed[SFN_TRACE_FIELD].traceparent).toContain(producer.traceId);
    expect(extractFromStateInput(parsed).spanContext?.spanId).toBe(producer.spanId);
  });

  it("rejects a non-string / empty stateMachineArn (R7-A)", async () => {
    await expect(
      // @ts-expect-error runtime guard の検証
      withStepFunctionsTask({}, () => undefined, { stateMachineArn: 42 }),
    ).rejects.toThrow("options.stateMachineArn");
    await expect(
      withStepFunctionsTask({}, () => undefined, { stateMachineArn: "" }),
    ).rejects.toThrow("options.stateMachineArn");
  });

  it("rejects invalid ConsumeOptions fields (R7-A)", async () => {
    await expect(withStepFunctionsTask({}, () => undefined, { name: "" })).rejects.toThrow(
      "options.name",
    );
    await expect(
      // @ts-expect-error runtime guard の検証
      withStepFunctionsTask({}, () => undefined, { attributes: "nope" }),
    ).rejects.toThrow("options.attributes");
    await expect(
      // @ts-expect-error runtime guard の検証
      withStepFunctionsTask({}, () => undefined, { parent: "bogus" }),
    ).rejects.toThrow("options.parent");
  });
});
