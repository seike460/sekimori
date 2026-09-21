export const XRAY_SOURCE = `import AWSXRay from "aws-xray-sdk-core";
const seg = AWSXRay.getSegment();
seg.close();
`;

export const MANUAL_SOURCE = `import AWSXRay from "aws-xray-sdk-core";
const cb = async () => {};
AWSXRay.captureAsyncFunc("x", cb);
`;

export const READY_TEMPLATE = {
  Resources: {
    Fn: {
      Type: "AWS::Lambda::Function",
      Properties: {
        FunctionName: "ready-fn",
        TracingConfig: { Mode: "Active" },
        Layers: ["arn:aws:lambda:ap-northeast-1:615299751070:layer:AWSOpenTelemetryDistroJs:15"],
        Role: { "Fn::GetAtt": ["FnRole", "Arn"] },
        Environment: {
          Variables: {
            AWS_LAMBDA_EXEC_WRAPPER: "/opt/otel-instrument",
            OTEL_SERVICE_NAME: "ready-fn",
          },
        },
      },
    },
    FnRole: {
      Type: "AWS::IAM::Role",
      Properties: {
        ManagedPolicyArns: [
          "arn:aws:iam::aws:policy/CloudWatchLambdaApplicationSignalsExecutionRolePolicy",
        ],
      },
    },
  },
};

export const BARE_TEMPLATE = {
  Resources: {
    Fn: {
      Type: "AWS::Lambda::Function",
      Properties: { FunctionName: "bare-fn" },
    },
  },
};
