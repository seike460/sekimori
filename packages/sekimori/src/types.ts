import type { Attributes, Context, SpanContext } from "@opentelemetry/api";

/** どの carrier から context を取り出したか。観測性の観測性: span 属性 `sekimori.context.source` にも載る。 */
export type CarrierSource =
  | "message-attributes"
  | "aws-trace-header"
  | "detail"
  | "body-detail"
  | "sns-envelope"
  | "sns-record"
  | "state-input"
  | "state-input-flattened"
  | "headers"
  | "stream-image"
  | "record-data"
  | "body"
  | "none";

export interface Extracted {
  /** 取り出した context。見つからなければ base context をそのまま返す。 */
  readonly context: Context;
  readonly source: CarrierSource;
  /** 見つかった producer 側 SpanContext。carrier が baggage だけを載せる等 traceparent を含まない場合は undefined。 */
  readonly spanContext?: SpanContext;
}

export interface InjectOptions {
  /** 既定は `context.active()`。 */
  readonly context?: Context;
  /**
   * AWS ネイティブ channel（EventBridge `TraceHeader` / SQS `AWSTraceHeader`）に X-Ray 形式 header を書くか。
   * `"auto"`（既定）= グローバル propagator に X-Ray propagator が無い（= ADOT layer 外）ときだけ書く。
   * EventBridge と Step Functions（`injectStartExecution`）は常に書く（HTTP header では届かない経路のため）。
   */
  readonly xrayHeader?: boolean | "auto";
  /** W3C carrier（`traceparent` / `tracestate` / `baggage`）を書くか。既定 true。 */
  readonly w3c?: boolean;
}

export interface ConsumeOptions {
  /** span 名。既定は `process <destination>`。 */
  readonly name?: string;
  /**
   * 親の選び方。messaging 系の既定（DEC-002）は `"invocation"` = 親は現在の active span
   * （ADOT layer の invocation span）、producer へは link。`"producer"` は FIFO 単一 record など
   * 1 本の trace にしたい場合の opt-in。
   * 例外: HTTP 境界（`withHttpEvent`, DEC-007）は同期 request/response のため既定が逆で、
   * 未指定は producer（client の traceparent）が親、`"invocation"` 指定で link に倒れる。
   */
  readonly parent?: "invocation" | "producer";
  /** 親にする base context。既定は `context.active()`。 */
  readonly context?: Context;
  readonly attributes?: Attributes;
}
