import * as cdk from "aws-cdk-lib";
import { ProbeStack } from "../lib/probe-stack.js";

const app = new cdk.App();
const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION;
new ProbeStack(app, "SekimoriProbe", {
  env: { ...(account ? { account } : {}), ...(region ? { region } : {}) },
  description: "sekimori probe: emitter -> EventBridge -> SQS -> consumer, both on the ADOT layer",
});
