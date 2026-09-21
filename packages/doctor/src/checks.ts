/** sekimori doctor — Lambda の OTel readiness を判定する pure な check 群。 */
// `sekimori/semconv` は依存を持たない leaf subpath。barrel 経由だと @opentelemetry/api
// (peer dep) まで引き込んでしまうため、定数だけを直接 import する。
import { MIN_ADOT_LAYER_VERSION } from "sekimori/semconv";

export type CheckStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  readonly id: string;
  readonly status: CheckStatus;
  readonly message: string;
}

export interface FunctionReport {
  readonly name: string;
  readonly checks: DoctorCheck[];
}

export interface DoctorReport {
  readonly functions: FunctionReport[];
  readonly notes: string[];
}

/** 正本は `sekimori` パッケージ。ここでは re-export する。 */
export { MIN_ADOT_LAYER_VERSION };

/** 検査に必要な関数情報の正規形。template / live の両経路から作る。 */
export interface FunctionFacts {
  readonly name: string;
  readonly tracingMode?: string | undefined;
  /** TracingConfig / SAM Tracing が intrinsic で Mode を確定できないとき true。 */
  readonly tracingUnresolvable?: boolean | undefined;
  readonly layers: readonly string[];
  /** layers に intrinsic（Fn::Sub / Ref 等）を含み ARN を確定できないとき true。 */
  readonly layersUnresolvable?: boolean | undefined;
  readonly environment: Readonly<Record<string, string>>;
  /** 値が intrinsic で解決できなかった env var 名。これらは pass/fail ではなく warn に倒す。 */
  readonly unresolvableEnvKeys?: readonly string[] | undefined;
  /** Environment / Properties 自体が intrinsic で env var を一切読めないとき true。 */
  readonly envUnresolvable?: boolean | undefined;
  /** PackageType=Image または非 Node.js runtime — ADOT JS layer / exec wrapper は適用外。 */
  readonly nonNodeJs?: boolean | undefined;
  /** Runtime が intrinsic（`{ Ref: ... }` 等）で Node.js かどうか判定不能なとき true。 */
  readonly runtimeUnresolvable?: boolean | undefined;
  /** xray:PutTraceSegments を許可する IAM が解決できたとき true / 解決不能は undefined。 */
  readonly xrayWriteAllowed?: boolean | undefined;
  /** IAM 読み取り自体が失敗したときの理由（error name）。warn の説明に載せる。 */
  readonly xrayIamError?: string | undefined;
}

const ADOT_LAYER_PATTERN = /AWSOpenTelemetryDistroJs:(\d+)$/;

function checkTracing(facts: FunctionFacts): DoctorCheck {
  if (facts.tracingMode === "Active") {
    return { id: "tracing", status: "pass", message: "X-Ray active tracing is on" };
  }
  if (facts.tracingMode === "PassThrough") {
    return {
      id: "tracing",
      status: "fail",
      message:
        "tracing is PassThrough — the ADOT layer would parent on an unsampled context. Set TracingConfig.Mode=Active",
    };
  }
  // `TracingConfig: { Fn::If: ... }` のような intrinsic —「未設定」と誤報しない。
  if (facts.tracingUnresolvable === true) {
    return {
      id: "tracing",
      status: "warn",
      message: "TracingConfig is set via an intrinsic reference — verify Mode=Active manually",
    };
  }
  return { id: "tracing", status: "warn", message: "TracingConfig is not set" };
}

function checkAdotLayer(facts: FunctionFacts): DoctorCheck {
  if (facts.runtimeUnresolvable === true) {
    return {
      id: "adot-layer",
      status: "warn",
      message:
        "Runtime is an intrinsic reference — verify it is a Node.js runtime, then check the AWSOpenTelemetryDistroJs layer manually",
    };
  }
  if (facts.nonNodeJs === true) {
    return {
      id: "adot-layer",
      status: "warn",
      message:
        "image package or non-Node.js runtime — AWSOpenTelemetryDistroJs does not apply; instrument with the matching ADOT distro",
    };
  }
  const layer = facts.layers.find((l) => l.includes("AWSOpenTelemetryDistroJs"));
  if (layer === undefined) {
    if (facts.layersUnresolvable === true) {
      return {
        id: "adot-layer",
        status: "warn",
        message:
          "Layers are set via intrinsic references — verify the AWSOpenTelemetryDistroJs layer manually",
      };
    }
    return {
      id: "adot-layer",
      status: "fail",
      message:
        "no AWSOpenTelemetryDistroJs layer — without it, the OTel SDK never starts in Lambda",
    };
  }
  const version = Number(ADOT_LAYER_PATTERN.exec(layer)?.[1]);
  if (!Number.isFinite(version)) {
    return {
      id: "adot-layer",
      status: "warn",
      message: "ADOT layer referenced but its version could not be verified (intrinsic value)",
    };
  }
  if (version < MIN_ADOT_LAYER_VERSION) {
    return {
      id: "adot-layer",
      status: "warn",
      message: `ADOT layer v${version} < v${MIN_ADOT_LAYER_VERSION} — older layers miss the smithy inject patch`,
    };
  }
  return { id: "adot-layer", status: "pass", message: `ADOT layer attached (${layer})` };
}

function unresolvableEnv(facts: FunctionFacts, key: string): DoctorCheck | undefined {
  if (facts.envUnresolvable === true) {
    return {
      id: "",
      status: "warn",
      message: `${key}: the function's Environment is an intrinsic reference — verify its value manually`,
    };
  }
  return facts.unresolvableEnvKeys?.includes(key)
    ? {
        id: "",
        status: "warn",
        message: `${key} is set via an intrinsic reference — verify its value manually`,
      }
    : undefined;
}

function checkExecWrapper(facts: FunctionFacts): DoctorCheck {
  if (facts.runtimeUnresolvable === true) {
    return {
      id: "exec-wrapper",
      status: "warn",
      message:
        "Runtime is an intrinsic reference — AWS_LAMBDA_EXEC_WRAPPER applies to Node.js runtimes only; verify manually",
    };
  }
  if (facts.nonNodeJs === true) {
    return {
      id: "exec-wrapper",
      status: "warn",
      message:
        "image package or non-Node.js runtime — AWS_LAMBDA_EXEC_WRAPPER=/opt/otel-instrument does not apply",
    };
  }
  const value = facts.environment.AWS_LAMBDA_EXEC_WRAPPER;
  if (value === "/opt/otel-instrument") {
    return {
      id: "exec-wrapper",
      status: "pass",
      message: "AWS_LAMBDA_EXEC_WRAPPER=/opt/otel-instrument",
    };
  }
  if (value !== undefined) {
    return {
      id: "exec-wrapper",
      status: "warn",
      message: `AWS_LAMBDA_EXEC_WRAPPER="${value}" — expected /opt/otel-instrument`,
    };
  }
  const unresolvable = unresolvableEnv(facts, "AWS_LAMBDA_EXEC_WRAPPER");
  if (unresolvable !== undefined) return { ...unresolvable, id: "exec-wrapper" };
  return {
    id: "exec-wrapper",
    status: "warn",
    message: "AWS_LAMBDA_EXEC_WRAPPER is not set — auto-instrumentation will not run",
  };
}

function checkServiceName(facts: FunctionFacts): DoctorCheck {
  const value = facts.environment.OTEL_SERVICE_NAME;
  if (value) {
    return { id: "service-name", status: "pass", message: `OTEL_SERVICE_NAME=${value}` };
  }
  const unresolvable = unresolvableEnv(facts, "OTEL_SERVICE_NAME");
  if (unresolvable !== undefined) return { ...unresolvable, id: "service-name" };
  return {
    id: "service-name",
    status: "warn",
    message: "OTEL_SERVICE_NAME unset — spans land under the layer default service",
  };
}

function checkPropagators(facts: FunctionFacts): DoctorCheck {
  const value = facts.environment.OTEL_PROPAGATORS;
  if (value === undefined) {
    const unresolvable = unresolvableEnv(facts, "OTEL_PROPAGATORS");
    if (unresolvable !== undefined) return { ...unresolvable, id: "propagators" };
    return {
      id: "propagators",
      status: "pass",
      message: "OTEL_PROPAGATORS unset — ADOT default (baggage,xray,tracecontext) applies",
    };
  }
  const fields = value.split(",").map((f) => f.trim().toLowerCase());
  // sekimori は baggage も carrier として書くため、ADOT 既定の 3 種を全部要求する。
  const missing = ["tracecontext", "xray", "baggage"].filter((f) => !fields.includes(f));
  return missing.length === 0
    ? { id: "propagators", status: "pass", message: `OTEL_PROPAGATORS=${value}` }
    : {
        id: "propagators",
        status: "warn",
        message: `OTEL_PROPAGATORS lacks ${missing.join(", ")} — boundary links may not reach X-Ray`,
      };
}

function checkXrayWrite(facts: FunctionFacts): DoctorCheck {
  if (facts.xrayWriteAllowed === true) {
    return { id: "xray-iam", status: "pass", message: "role allows xray:PutTraceSegments" };
  }
  if (facts.xrayWriteAllowed === false) {
    return {
      id: "xray-iam",
      status: "fail",
      message:
        "role cannot write traces — attach CloudWatchLambdaApplicationSignalsExecutionRolePolicy or allow xray:PutTraceSegments",
    };
  }
  return {
    id: "xray-iam",
    status: "warn",
    message:
      facts.xrayIamError !== undefined
        ? `could not read the role's policies (${facts.xrayIamError}) — verify xray:PutTraceSegments manually`
        : "could not fully evaluate the role's policies (intrinsic reference, conditional resource, or unresolved role) — verify xray:PutTraceSegments manually",
  };
}

/**
 * 判定規則の正本 — check の追加・削除・並び替えはこの配列だけを触る。
 * 順序は report の読み順。
 */
const FUNCTION_CHECKS: readonly ((facts: FunctionFacts) => DoctorCheck)[] = [
  checkTracing,
  checkAdotLayer,
  checkExecWrapper,
  checkServiceName,
  checkPropagators,
  checkXrayWrite,
];

/** FunctionFacts からの判定。適用する check の集合は FUNCTION_CHECKS が正本。 */
export function checkFunction(facts: FunctionFacts): FunctionReport {
  return { name: facts.name, checks: FUNCTION_CHECKS.map((check) => check(facts)) };
}
