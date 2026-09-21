import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MockInstance, vi } from "vitest";

/** 1 stream の write を sink に記録する spy を張る。戻り値は常に true（書き込み成功）。 */
function tapWrite(stream: NodeJS.WriteStream, sink: string[]): MockInstance {
  return vi.spyOn(stream, "write").mockImplementation((chunk: Uint8Array | string) => {
    sink.push(String(chunk));
    return true;
  });
}

/** process.stdout/stderr.write を捕捉し、restore で必ず元に戻す。 */
export function captureStdio() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const spies = [tapWrite(process.stdout, stdout), tapWrite(process.stderr, stderr)];
  return {
    stdout: () => stdout.join(""),
    stderr: () => stderr.join(""),
    restore: () => {
      for (const s of spies) s.mockRestore();
    },
  };
}

export function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "sekimori-cli-"));
}

export function fixture(dir: string, name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}
