/** migrate テストの共有 fixture。tmp dir と代表 source を提供する。 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const XRAY_SOURCE = `import AWSXRay from "aws-xray-sdk-core";
const seg = AWSXRay.getSegment();
seg.close();
`;

export const MANUAL_SOURCE = `import AWSXRay from "aws-xray-sdk-core";
const cb = async () => {};
AWSXRay.captureAsyncFunc("x", cb);
`;

export function tmpTestDir(): string {
  return mkdtempSync(join(tmpdir(), "sekimori-codemod-"));
}
