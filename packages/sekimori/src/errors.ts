/** `SekimoriError` と境界 assertion — 設定ミス・untrusted input を入口で検証する。 */
import type { Context, Exception } from "@opentelemetry/api";
import type { ConsumeOptions, InjectOptions } from "./types.js";

/** sekimori が投げる唯一のエラー型。設定ミスを黙って握りつぶさないために使う。 */
export class SekimoriError extends Error {
  override readonly name = "SekimoriError";
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 公開 API の record/event/input 引数が object であることを保証する。null・配列・primitive は弾く。 */
export function assertObject(value: unknown, api: string): asserts value is object {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SekimoriError(`${api}: expected an object argument.`);
  }
}

/**
 * `options.context` が OTel Context であることを保証する。
 * undefined（= active context を使う既定）は許容し、それ以外で `getValue` /
 * `setValue` / `deleteValue` のどれかを欠く値は弾く（部分実装は extract 内部の
 * `TypeError` になるため、ここで名指しして止める）。
 * `in` ではなく `Reflect.get` で読む — `get` trap でメソッドを供給する Proxy 製
 * Context は `has` trap が true を返さず、`in` 判定では正当な Context を弾いてしまう。
 */
export function assertContext(value: unknown, api: string): asserts value is Context | undefined {
  if (
    value !== undefined &&
    (value === null ||
      typeof value !== "object" ||
      typeof Reflect.get(value, "getValue") !== "function" ||
      typeof Reflect.get(value, "setValue") !== "function" ||
      typeof Reflect.get(value, "deleteValue") !== "function")
  ) {
    throw new SekimoriError(`${api}: options.context must be an OpenTelemetry Context.`);
  }
}

/**
 * `InjectOptions` の各フィールドを検査する（`options.context` は `baseContext` が検査済み）。
 * truthy な非 boolean（`w3c: "false"` 等）は意図と逆の挙動になるため実行時に弾く。
 */
export function assertInjectOptions(options: InjectOptions, api: string): void {
  if (options.w3c !== undefined && typeof options.w3c !== "boolean") {
    throw new SekimoriError(`${api}: options.w3c must be a boolean.`);
  }
  if (
    options.xrayHeader !== undefined &&
    options.xrayHeader !== "auto" &&
    typeof options.xrayHeader !== "boolean"
  ) {
    throw new SekimoriError(`${api}: options.xrayHeader must be a boolean or "auto".`);
  }
}

/**
 * plain object（`Object.prototype` または null prototype）か。
 * Map / Set / class instance は spread で `{}` や enumerable field だけの複製になり、
 * caller の値が silent に失われるため、carrier merge 対象の判定に使う。
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * spread で複製する payload 引数（`item` / `payload`）が plain object か検査する。
 * Map / Set / Date / class instance は spread で `{}` や enumerable field だけの
 * 複製になり、caller の内容が silent に全喪失するため弾く（`assertAttributeMap` と同じ理由）。
 */
export function assertPlainObject(value: unknown, api: string, field: string): void {
  if (!isPlainObject(value)) {
    throw new SekimoriError(`${api}: ${field} must be a plain object.`);
  }
}

/**
 * AWS の attribute map フィールド（`MessageAttributes` 等）が plain object か検査する。
 * 非 object・配列を spread すると `{0: "a", ...}` のようなゴミ key になり、Map 等の
 * 非 plain object は `{}` に畳まれて caller の属性が silent に全喪失するため弾く。
 */
export function assertAttributeMap(value: unknown, api: string, field: string): void {
  if (value === undefined) return;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SekimoriError(`${api}: ${field} must be an attribute map object.`);
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new SekimoriError(`${api}: ${field} must be a plain attribute map object.`);
  }
}

/**
 * OTel `Attributes` が plain object か検査する。class instance・Map 等の非 plain object は
 * SDK が enumerable 自前プロパティだけ読むため、class field 以外の属性が silent に落ちる。
 */
export function assertAttributes(value: unknown, api: string): void {
  if (value === undefined) return;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SekimoriError(`${api}: options.attributes must be an OTel Attributes object.`);
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new SekimoriError(`${api}: options.attributes must be a plain object.`);
  }
}

/**
 * `ConsumeOptions` の各フィールドを検査する（`options.context` は `baseContext` が検査済み）。
 * JS 利用者は型で守れないため、record 由来の値と同じ基準で実行時に弾く。
 */
export function assertConsumeOptions(options: ConsumeOptions, api: string): void {
  if (options.name !== undefined && (typeof options.name !== "string" || options.name === "")) {
    throw new SekimoriError(`${api}: options.name must be a non-empty string.`);
  }
  if (
    options.parent !== undefined &&
    options.parent !== "invocation" &&
    options.parent !== "producer"
  ) {
    throw new SekimoriError(`${api}: options.parent must be "invocation" or "producer".`);
  }
  assertAttributes(options.attributes, api);
}

/**
 * throw された値を OTel `Exception`（`string | {code|name|message, stack?}`）へ変換する。
 * `{name, message, stack}` のような object 形は field を検査してそのまま保持する —
 * `String()` に潰すと `"[object Object]"` になり診断情報を失うため。
 */
export function toException(error: unknown): Exception {
  if (error instanceof Error || typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    const o = error as Record<string, unknown>;
    const typesOk =
      (o.code === undefined || typeof o.code === "string" || typeof o.code === "number") &&
      (o.name === undefined || typeof o.name === "string") &&
      (o.message === undefined || typeof o.message === "string") &&
      (o.stack === undefined || typeof o.stack === "string");
    if (typesOk && (o.code !== undefined || o.name !== undefined || o.message !== undefined)) {
      return error as Exception;
    }
  }
  return String(error);
}

/**
 * span の ERROR status に載せる message。Error は `message`、Exception object は
 * `message` field、それ以外は文字列化した値を使う。
 */
export function exceptionMessage(exception: Exception, raw: unknown): string {
  if (typeof exception === "string") return exception;
  return exception.message ?? String(raw);
}
