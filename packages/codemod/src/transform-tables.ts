/**
 * codemod の判定テーブル — X-Ray / Powertools の識別子・メソッド対応表・
 * 構文分類（代入演算子 / 非 arrow 関数 / test hook）をデータとして集約する。
 * 変換ロジックは transform-*.ts 側。新しい対応を足すときは原則ここだけを編集する。
 */
import { SyntaxKind } from "ts-morph";

export const XRAY_MODULES = new Set(["aws-xray-sdk-core", "aws-xray-sdk"]);

export const POWERTOOLS_TRACER_MODULE = "@aws-lambda-powertools/tracer";

export const SHIM_MODULE = "sekimori/tracer";

export const OTEL_MODULE = "@opentelemetry/api";

/** Powertools Tracer → sekimori/tracer で同じ名前のまま動くメソッド。 */
export const SHIM_SUPPORTED = new Set([
  "putAnnotation",
  "putMetadata",
  "getSegment",
  "captureLambdaHandler",
  "captureMethod",
  "captureAWS",
  "captureAWSClient",
  "captureAWSv3Client",
  "captureHTTPsGlobal",
]);

/** `X.method(arg)` → `arg` に unwrap する X-Ray SDK の計装 helper（contrib の auto instrumentation が担う）。 */
export const XRAY_UNWRAP = new Set([
  "captureAWS",
  "captureAWSClient",
  "captureAWSv3Client",
  "captureHTTPs",
  "captureHTTPsGlobal",
]);

/** segment callback 内で機械的に写せるメソッド。 */
export const SEGMENT_RENAME = new Map([
  ["close", "end"],
  ["addAnnotation", "setAttribute"],
]);

/** segment callback 内で OTel に直行しないメソッド。 */
export const SEGMENT_MANUAL = new Set([
  "addNewSubsegment",
  "addRemoteRequestData",
  "addErrorFlag",
  "addFaultFlag",
  "addThrottleFlag",
  "incrementCounter",
  "decrementCounter",
  "flush",
]);

/**
 * OTel `Span` の member 名。追跡中の segment receiver 上にこれらが現れたら
 * 「既に移行済み」の印 — 先行 pass が `seg.close()` から生成した `seg?.end()` を
 * 後続 pass が再スキャンして "unknown segment method" と二重報告するのを防ぐ。
 * X-Ray Segment/Subsegment には同名の method が無いため X-Ray 側の置き忘れを
 * 誤って握り潰すことはない。
 */
export const OTEL_SPAN_MEMBERS = new Set([
  "end",
  "setAttribute",
  "setAttributes",
  "addEvent",
  "addLink",
  "addLinks",
  "setStatus",
  "recordException",
  "updateName",
  "isRecording",
  "spanContext",
]);

/** 代入演算子。`==` / `===` / `<=` 等を含まないようテキストで列挙する。 */
export const ASSIGNMENT_OPS = new Set([
  "=",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "**=",
  "<<=",
  ">>=",
  ">>>=",
  "&=",
  "|=",
  "^=",
  "&&=",
  "||=",
  "??=",
]);

/**
 * `arguments` の所有者境界になり得る関数 kind（arrow 以外）。
 * 内側でこれらが現れたら `arguments` はそちらの関数のもの — callback の param ではない。
 */
export const NON_ARROW_FUNCTION_KINDS = new Set([
  SyntaxKind.FunctionExpression,
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
  SyntaxKind.Constructor,
]);

/** `jest.mock("x")` / `vi.mock("x")` 系 — 第 1 引数が module specifier の test hook。 */
export const TEST_HOOK_METHODS = new Set([
  "mock",
  "unmock",
  "doMock",
  "dontMock",
  "requireActual",
  "requireMock",
  "importActual",
  "importMock",
  // jest の ESM mock API と mock 管理系 — 第 1 引数が module specifier。
  "unstable_mockModule",
  "setMock",
  "createMockFromModule",
  "deepUnmock",
  "genMockFromModule",
]);

/** 再代入として扱う代入演算子（`=` のほか全ての複合・論理代入）。 */
export const ASSIGNMENT_TOKENS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.EqualsToken,
  SyntaxKind.PlusEqualsToken,
  SyntaxKind.MinusEqualsToken,
  SyntaxKind.AsteriskEqualsToken,
  SyntaxKind.AsteriskAsteriskEqualsToken,
  SyntaxKind.SlashEqualsToken,
  SyntaxKind.PercentEqualsToken,
  SyntaxKind.LessThanLessThanEqualsToken,
  SyntaxKind.GreaterThanGreaterThanEqualsToken,
  SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  SyntaxKind.AmpersandEqualsToken,
  SyntaxKind.BarEqualsToken,
  SyntaxKind.CaretEqualsToken,
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);
