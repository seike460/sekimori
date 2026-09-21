/** probe stack — emitter → EventBridge → SQS → consumer の配線を宣言する。 */
import { fileURLToPath } from "node:url";
import * as cdk from "aws-cdk-lib";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as xray from "aws-cdk-lib/aws-xray";
import type { Construct } from "constructs";
import { instrumentLambda } from "./instrument-lambda.js";

const handler = (name: string) => fileURLToPath(new URL(`../handlers/${name}.ts`, import.meta.url));

/**
 * 恒久的な統合テスト経路: emitter(PutEvents) → bus → rule → SQS → consumer。
 * 両 Lambda は ADOT layer で計装し、consumer は record ごとに sekimori の CONSUMER span を開く。
 * assert.ts が Transaction Search / X-Ray API で「consumer span が emitter span へ link を持つ」ことを確かめる。
 */
export class ProbeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const bus = new events.EventBus(this, "Bus", { eventBusName: `${this.stackName}-bus` });

    const dlq = new sqs.Queue(this, "Dlq", {
      retentionPeriod: cdk.Duration.days(14),
      enforceSSL: true,
    });
    const consumerTimeout = cdk.Duration.seconds(30);
    const queue = new sqs.Queue(this, "Queue", {
      // AWS docs: visibility timeout >= 6 x function timeout (+ batch window)
      visibilityTimeout: cdk.Duration.seconds(consumerTimeout.toSeconds() * 6),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
      enforceSSL: true,
    });

    const bundling = {
      format: OutputFormat.CJS, // AWS recommends CJS for Application Signals auto-instrumentation
      externalModules: ["@aws-sdk/*", "@smithy/*"],
      target: "node22",
      sourceMap: true,
    };
    const runtime = lambda.Runtime.NODEJS_22_X;

    const emitterLogs = new logs.LogGroup(this, "EmitterLogs", {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const consumerLogs = new logs.LogGroup(this, "ConsumerLogs", {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const emitter = new NodejsFunction(this, "Emitter", {
      entry: handler("emitter"),
      runtime,
      tracing: lambda.Tracing.ACTIVE,
      timeout: cdk.Duration.seconds(15),
      environment: { BUS_NAME: bus.eventBusName },
      bundling,
      logGroup: emitterLogs,
    });
    bus.grantPutEventsTo(emitter);
    instrumentLambda(emitter, "sekimori-probe-emitter");

    const consumer = new NodejsFunction(this, "Consumer", {
      entry: handler("consumer"),
      runtime,
      tracing: lambda.Tracing.ACTIVE,
      timeout: consumerTimeout,
      bundling,
      logGroup: consumerLogs,
    });
    consumer.addEventSource(
      new SqsEventSource(queue, { batchSize: 10, reportBatchItemFailures: true }),
    );
    instrumentLambda(consumer, "sekimori-probe-consumer");

    new events.Rule(this, "ProbeRule", {
      eventBus: bus,
      eventPattern: { source: ["sekimori.probe"], detailType: ["trace-probe"] },
      targets: [new targets.SqsQueue(queue, { deadLetterQueue: dlq, retryAttempts: 3 })],
    });

    // Transaction Search は account/region 単位の設定。既に有効な account では作らない（context で切替）。
    if (this.node.tryGetContext("sekimori:transactionSearch") === "true") {
      enableTransactionSearch(this);
    }

    new cdk.CfnOutput(this, "EmitterFunctionName", { value: emitter.functionName });
    new cdk.CfnOutput(this, "ConsumerFunctionName", { value: consumer.functionName });
    new cdk.CfnOutput(this, "QueueUrl", { value: queue.queueUrl });
    new cdk.CfnOutput(this, "BusName", { value: bus.eventBusName });
  }
}

/**
 * CloudWatch Transaction Search を有効化する。
 * CfnTransactionSearchConfig だけでなく、X-Ray が aws/spans log-group へ
 * span を PutLogEvents できる Logs resource policy も必要（AWS の CloudFormation ガイド）。
 * これが無いと TransactionSearchConfig だけ作られて span は届かない。
 */
export function enableTransactionSearch(stack: cdk.Stack): void {
  new xray.CfnTransactionSearchConfig(stack, "TransactionSearch", { indexingPercentage: 100 });
  new logs.CfnResourcePolicy(stack, "TransactionSearchLogsPolicy", {
    policyName: `${stack.stackName}-xray-transaction-search`,
    policyDocument: JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "TransactionSearchXRayWrite",
          Effect: "Allow",
          Principal: { Service: "xray.amazonaws.com" },
          Action: "logs:PutLogEvents",
          Resource: [
            `arn:${stack.partition}:logs:${stack.region}:${stack.account}:log-group:aws/spans:*`,
            `arn:${stack.partition}:logs:${stack.region}:${stack.account}:log-group:/aws/application-signals/data:*`,
          ],
          Condition: {
            StringEquals: { "aws:SourceAccount": stack.account },
            ArnLike: {
              "aws:SourceArn": `arn:${stack.partition}:xray:${stack.region}:${stack.account}:*`,
            },
          },
        },
      ],
    }),
  });
}
