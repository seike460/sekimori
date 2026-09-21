# sekimori — 関守

> Lambda の trace を、関所（EventBridge / SQS / SNS / Step Functions…）を越えて一本に通す関守。
> X-Ray SDK から OpenTelemetry への引っ越しも、関守が見送る。

本書は設計の正本です。事実は `Fact:`、v0.x で確認中の仮定は `Assumption:` として区別します。

## 1. Problem

Lambda は「計装は runtime に属する」（instrument the platform, not the code）。ADOT Lambda layer を付ければ
handler を変えずに trace が取れます。しかし境界を越えると三つの穴が残ります。

- **ネイティブ header が落ちる場所がある。** EventBridge の `TraceHeader` は target へ内部伝達されるだけで配信 event には入らず、archive replay で消える。SNS の attributes は raw delivery でしか SQS に届かない。
- **record ごとの span が無い。** layer は batch 全体の invocation span に link を付けるだけ。どの record が遅かった・失敗したかは span で追えない。
- **証明する手段が無い。** 「繋がっているはず」を CI で確かめる OSS は無い（ServerlessSpy は event の到達を見るが trace の連結は見ない）。

加えて X-Ray SDK は maintenance mode に入り、Powertools Tracer は X-Ray SDK 依存のまま。移行の codemod は存在しない。

> **Fact:** AWS X-Ray SDKs / daemon は 2026-02-25 から maintenance mode（セキュリティ修正のみ）。AWS は ADOT または OTel + CloudWatch を推奨。**終了日は公表されていない（"N/A"）。** X-Ray サービス自体は無影響。
> Source: https://aws.amazon.com/blogs/mt/aws-x-ray-sdks-daemon-migration-to-opentelemetry (checked: 2026-09-13)

> **Fact:** ADOT Lambda layer（`AWSOpenTelemetryDistroJs`、`/opt/otel-instrument` wrapper）の既定は `OTEL_PROPAGATORS="baggage,xray,tracecontext"`。composite propagator は設定順に `extract` して後勝ちするため、carrier に両方あるときは W3C `traceparent` が `x-amzn-trace-id` に勝つ。計装は既定で `fs,dns` を無効化し、Application Signals 有効時は `aws-lambda,aws-sdk,http,undici` 等に絞る。なお invocation span の親付けは別経路 — patched instrumentation が `_X_AMZN_TRACE_ID`（Lambda が付ける env var）を直接読み、propagator の順序には依存しない。
> Source: aws-observability/aws-otel-js-instrumentation `aws-distro-opentelemetry-node-autoinstrumentation/src/register.ts` (`setAwsDefaultEnvironmentVariables`), `src/patches/instrumentation-patch.ts` (checked: 2026-09-13, re-verified 2026-10-21)

> **Fact:** 同 layer の Smithy middleware patch は送信側 AWS SDK v3 呼び出しの HTTP header に全 propagator を inject する。よって計装済み client の `PutEvents` / `SendMessage` は X-Ray header を運び、X-Ray 上の link は layer だけで成立する。
> Source: `src/patches/smithy-send-patch.ts` (checked: 2026-09-13)

> **Fact:** `@opentelemetry/instrumentation-aws-sdk` の `services/` に `eventbridge.ts` は無い。SQS は inject + extract + link、SNS は inject のみ、Kinesis / Step Functions は属性のみ。
> Source: open-telemetry/opentelemetry-js-contrib `packages/instrumentation-aws-sdk/src/services/` (checked: 2026-09-13) / issue #3686 (open, 2026-08-20)

> **Fact:** Datadog `dd-trace-js` は EventBridge の `Detail` に `_datadog` を注入する（「`TraceHeader` は X-Ray 予約なので Detail に入れる」とソースに明記）。完全解だが vendor 固有。
> Source: DataDog/dd-trace-js `packages/datadog-plugin-aws-sdk/src/services/eventbridge.js` (checked: 2026-09-13)

## 2. Target user

TypeScript で Lambda を書き、EventBridge / SQS / SNS で非同期に繋ぎ、ADOT layer（または素の OTel SDK）で計装している、
あるいは X-Ray SDK / Powertools Tracer から離れたいチーム。Datadog 等の vendor tracer で伝播まで済んでいるチームは対象外です。

## 3. Non-Goals

- tracer / SDK / collector / backend を作らない。
- X-Ray SDK の互換実装を作らない（codemod と shim は「移行路」であって代替ではない）。
- upstream が構造的にできることを二重実装しない。できるようになったら削る。
- 3 つ目の境界に進む前に 2 つ（EventBridge・SQS）を完成させる。

## 4. Decisions

### DEC-001 wire format — W3C を主、X-Ray 形式をネイティブ channel に併記
- **決定**: アプリ層 carrier は W3C `traceparent` / `tracestate` / `baggage`。同じ span context から作った X-Ray 形式 header を、AWS ネイティブ channel（EventBridge `TraceHeader` / SQS `AWSTraceHeader` / SFn `traceHeader`）に併記する。
- **理由**: ネイティブは Lambda / X-Ray が link に使う側。W3C は header が落ちる場所（event payload・archive replay・W3C-only consumer）で生き残り、producer span を特定する側。
- **却下**: X-Ray 形式のみ（W3C-only な consumer が読めない）/ W3C のみ（ESM の自動 link を失う）。
- X-Ray formatter は ~30 行を自前実装し、`@opentelemetry/propagator-aws-xray` と byte 単位で突合するテストを置く。

### DEC-002 batch — record ごとの CONSUMER span、親は invocation、producer へは link
- **決定**: `withSqsRecord` は record ごとに `process <queue>` の CONSUMER span を開く。親は現在の active span（layer の invocation span）、producer へは span link。`parent: "producer"` は FIFO 単一 record 向けの opt-in。
- **理由**: span は親を 1 つしか持てない。batch 処理では link が既定の相関、と messaging semconv（Development）が定める。
- Source: https://opentelemetry.io/docs/specs/semconv/messaging/messaging-spans/

### DEC-003 Powertools — Tracer は OTel API + layer に置換、他は残す（実装済み）
- 既定の codemod は Tracer だけを OTel API に置き換え、Logger / Metrics / Idempotency / Batch は残す。`sekimori/tracer`（Powertools のメソッド名を持つ OTel 実装）は Powertools RFC #90 の対応表どおりに作り、公式実装が出たら機械的に差し替え可能にする。
- Source: https://github.com/aws-powertools/powertools-lambda/discussions/90 (open, "not committed", checked: 2026-09-13)

### DEC-004 bundling — runtime package は ESM + CJS、CLI は ESM のみ
- AWS は Application Signals で CJS bundle を推奨し、ADOT の ESM 経路は experimental。利用者の bundle 形式を縛らないため両出力。

### DEC-005 dependency — `@opentelemetry/api` は peer dependency
- OTel API はプロセスに 1 つのグローバル登録を前提とする。利用者の SDK / layer と同じ API instance を共有するため peer にする。sekimori 自身は runtime 依存を持たない。

### DEC-006 SQS — X-Ray field は W3C context があるときだけ message attribute に書かない
- `propagation.inject` が X-Ray propagator の field（`X-Amzn-Trace-Id`）を attribute に書くと、10 個の attribute 枠を 1 つ消費し、SQS が HTTP header から作る system attribute `AWSTraceHeader` と二重になる。W3C carrier（`traceparent`）が inject されたときはその field を取り除き、X-Ray propagator が無い環境（`"auto"`）や `w3c: false` では `MessageSystemAttributes.AWSTraceHeader` を書く。
- 例外は X-Ray-only propagator 構成（W3C carrier が無い） — `x-amzn-trace-id` が唯一の context なので message attribute に残す。このとき attribute と `AWSTraceHeader` は同じ context を指すため split-brain にはならない。fresh な `AWSTraceHeader` を書くのに入力由来の古い `x-amzn-trace-id` が残るケースは、extract が message attributes を先に読むため、stale 値は常に取り除く。

### DEC-007 API Gateway — 同期境界なので親は producer、kind は SERVER
- `withHttpEvent` は messaging 系（DEC-002）と違い、既定の親を client の `traceparent`（producer context）にする。HTTP は request/response が同期で、client → server の親子が semconv の標準形だから。`parent: "invocation"` にすると layer の invocation span を親にし、producer へは link になる。

### DEC-008 Streams — DynamoDB / Kinesis は opt-in の規約 carrier
- DynamoDB は item に `_trace` 属性（`M` 型）、Kinesis は payload envelope に W3C key を直接書く。どちらも AWS 側に channel が無いので、producer 側で明示的に item/payload を汚す選択を取る。アプリの schema に触れるため experimental 扱い。KPL 集約は対象外。

## 5. Open questions

- ~~**OQ-1** EventBridge → SQS の SQS body に入った event の `detail.traceparent` を `extractFromSqsRecord` で読むか~~ → **解決済み**: 読む。SNS envelope の次、`body.detail` が object なら `objectGetter` で W3C carrier を探し、見つかれば `source: "body-detail"` を返す。
- **OQ-2** `messaging.system` の独自値が 6 種ある: `aws_eventbridge` / `aws_sns` / `aws_stepfunctions` / `aws_dynamodb` / `aws_kinesis` / `aws_api_gateway` はいずれも semconv の公式値ではない（`aws_sqs` は公式）。semconv に AWS 系 system 値を提案するか、`messaging.system` は公式値だけに留めて `aws.*` 属性で種別を表すか、を upstream に問う。
- **OQ-3** `Sampled=0`（passive 親）のとき有効な `traceparent` を優先すべきかを aws-otel-js-instrumentation に問う。

## 6. Verification

- unit: round trip（inject → extract）と X-Ray header の property test（fast-check）。
- contract: 同じ suite を「W3C のみ」「W3C + X-Ray propagator（layer 相当）」で実行（`test/contract/boundary.ts`）。
- integration: `probe/` の実 AWS stack。Transaction Search の span を probe_id で検索し、consumer span が emitter へ link を持つことを assert。結果は `docs/evidence/` に残す。
