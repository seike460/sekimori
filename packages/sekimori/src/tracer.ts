/** Powertools `Tracer` 互換の薄い shim — メソッドを OTel API へ転送する置き換え層。 */
import { type AttributeValue, type Span, type Tracer, trace } from "@opentelemetry/api";
import { SekimoriError } from "./errors.js";
import { TRACER_NAME } from "./semconv.js";
import { captureMethod } from "./span-capture.js";

/**
 * Powertools for AWS Lambda (TypeScript) `Tracer` の置き換え shim（DEC-003）。
 * X-Ray SDK ではなく OTel API へ書き換える。Powertools RFC #90 の対応表に従い、
 * 公式の OTel 実装が出たら機械的に差し替えられるよう、メソッド名は Powertools に合わせる。
 *
 * 対応表（Powertools → OTel）:
 * - `putAnnotation(k, v)`      → active span の attribute `k`（OTel に annotation の索引概念は無い）
 * - `putMetadata(k, v, ns?)`   → active span の attribute `metadata.<k>`（object は JSON 化）
 * - `getSegment()`             → `trace.getActiveSpan()`
 * - `captureLambdaHandler(fn)` → handler をそのまま返す（invocation span は layer / SDK が開く）
 * - `captureMethod(name, fn)`  → `name` の INTERNAL span で包む（decorator 形は codemod が報告）
 * - `captureAWS*` / `captureHTTPsGlobal` → そのまま返す（contrib の aws-sdk/http 計装が担う）
 */
export interface SekimoriTracer {
  putAnnotation(key: string, value: string | number | boolean): void;
  putMetadata(key: string, value: unknown, namespace?: string): void;
  getSegment(): Span | undefined;
  captureLambdaHandler<T extends (...args: never[]) => unknown>(handler: T): T;
  captureMethod<A extends unknown[], R>(name: string, fn: (...args: A) => R): (...args: A) => R;
  captureAWS<T>(sdk: T): T;
  captureAWSClient<T>(client: T): T;
  captureAWSv3Client<T>(client: T): T;
  captureHTTPsGlobal<T>(httpModule: T): T;
}

/**
 * OTel の配列 attribute が許す「同型 primitive 配列」かを絞る type guard。
 * 全要素の typeof が一致し、かつ string/number/boolean のときだけ true —
 * mixed 型（`["a", 1]`）は AttributeValue の union にも実行時仕様にも合わない。
 */
function isHomogeneousPrimitiveArray(value: unknown[]): value is string[] | number[] | boolean[] {
  if (value.length === 0) return true;
  const first = typeof value[0];
  if (first !== "string" && first !== "number" && first !== "boolean") return false;
  // every()/map() は hole を skip する — 添字の存在と型を各 index で確かめる。
  // hole は OTel が undefined として読み SDK が drop するため JSON 化対象にする。
  // `Object.keys` の総数比較は不可 — 追加 enumerable property が欠落 index と相殺する。
  for (let i = 0; i < value.length; i++) {
    if (!(i in value) || typeof value[i] !== first) return false;
  }
  return true;
}

function toAttributeValue(value: unknown): AttributeValue {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  // OTel の配列 attribute は primitive（string/number/boolean）同型のみ。
  // null/undefined 要素や mixed 型、object 混入は isAttributeValue を満たさず SDK に drop
  // されるため JSON 化する。
  if (Array.isArray(value) && isHomogeneousPrimitiveArray(value)) {
    return value;
  }
  // Error は JSON.stringify が "{}" を返して message が消える — stack（無ければ String）で残す。
  if (value instanceof Error) return value.stack ?? String(value);
  // circular や stringify 不能な値でも例外でユーザーコードを止めない（Powertools 相当の shim として
  // metadata 書き込み失敗は致命的ではない）。
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // circular 構造等で stringify が投げたら String() に倒す（記録用途なので精度は不要）。
    return String(value);
  }
}

function createTracer(tracerName: string = TRACER_NAME): SekimoriTracer {
  if (typeof tracerName !== "string" || tracerName === "") {
    throw new SekimoriError("createTracer: tracerName must be a non-empty string");
  }
  const otelTracer: Tracer = trace.getTracer(tracerName);
  return {
    putAnnotation(key, value) {
      trace.getActiveSpan()?.setAttribute(key, value);
    },
    putMetadata(key, value, namespace) {
      const attrKey = namespace ? `metadata.${namespace}.${key}` : `metadata.${key}`;
      trace.getActiveSpan()?.setAttribute(attrKey, toAttributeValue(value));
    },
    getSegment() {
      return trace.getActiveSpan();
    },
    captureLambdaHandler(handler) {
      return handler;
    },
    captureMethod(name, fn) {
      if (typeof name !== "string" || name === "") {
        throw new SekimoriError("captureMethod: name must be a non-empty string");
      }
      if (typeof fn !== "function") {
        throw new SekimoriError("captureMethod: fn must be a function");
      }
      return captureMethod(otelTracer, name, fn);
    },
    captureAWS(sdk) {
      return sdk;
    },
    captureAWSClient(client) {
      return client;
    },
    captureAWSv3Client(client) {
      return client;
    },
    captureHTTPsGlobal(httpModule) {
      return httpModule;
    },
  };
}

/** 既定の shim。`createTracer` で名前を変えた複数インスタンスも作れる。 */
export const tracer: SekimoriTracer = createTracer();
export { createTracer };
