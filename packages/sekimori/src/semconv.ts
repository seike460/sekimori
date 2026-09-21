// OpenTelemetry messaging semantic conventions (status: Development) のうち sekimori が使う key。
// 依存を増やさないため文字列定数で持つ。値が semconv に無いものは `aws.*` / `sekimori.*` 名前空間に置く。
export const ATTR_MESSAGING_SYSTEM = "messaging.system";
export const ATTR_MESSAGING_OPERATION_TYPE = "messaging.operation.type";
export const ATTR_MESSAGING_DESTINATION_NAME = "messaging.destination.name";
export const ATTR_MESSAGING_MESSAGE_ID = "messaging.message.id";

export const MESSAGING_SYSTEM_AWS_SQS = "aws_sqs";
/** semconv に公式値が無いため sekimori が定める値。 */
export const MESSAGING_SYSTEM_AWS_EVENTBRIDGE = "aws_eventbridge";
export const MESSAGING_SYSTEM_AWS_SNS = "aws_sns";
export const MESSAGING_SYSTEM_AWS_SFN = "aws_stepfunctions";
export const MESSAGING_SYSTEM_AWS_DYNAMODB = "aws_dynamodb";
export const MESSAGING_SYSTEM_AWS_KINESIS = "aws_kinesis";
/** `withHttpEvent` は SERVER span に `messaging.*` を付けないため内部では未使用。userland 向けに export する。 */
export const MESSAGING_SYSTEM_API_GATEWAY = "aws_api_gateway";
export const MESSAGING_OPERATION_TYPE_PROCESS = "process";

export const ATTR_AWS_SQS_APPROXIMATE_RECEIVE_COUNT = "aws.sqs.approximate_receive_count";
export const ATTR_AWS_EVENTBRIDGE_SOURCE = "aws.eventbridge.source";
export const ATTR_AWS_EVENTBRIDGE_DETAIL_TYPE = "aws.eventbridge.detail_type";
export const ATTR_AWS_EVENTBRIDGE_EVENT_ID = "aws.eventbridge.event_id";
export const ATTR_AWS_SNS_TOPIC_ARN = "aws.sns.topic_arn";
export const ATTR_AWS_SFN_STATE_MACHINE_ARN = "aws.sfn.state_machine_arn";
export const ATTR_AWS_DYNAMODB_TABLE_ARN = "aws.dynamodb.table_arn";
export const ATTR_AWS_KINESIS_STREAM_NAME = "aws.kinesis.stream_name";
export const ATTR_HTTP_ROUTE = "http.route";
export const ATTR_HTTP_METHOD = "http.request.method";

/** context をどの carrier から得たか（`CarrierSource`）。 */
export const ATTR_SEKIMORI_CONTEXT_SOURCE = "sekimori.context.source";

export const TRACER_NAME = "sekimori";

/**
 * sekimori が前提にする ADOT Lambda layer（AWSOpenTelemetryDistroJs）の最小バージョン。
 * aws-otel-js-instrumentation v0.12.0 (2026-06-30) = layer `:15`、smithy inject patch 以降。
 * doctor の下限判定と probe の layer pin がここを正本にする。
 */
export const MIN_ADOT_LAYER_VERSION = 15;
