import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AGENT_PATH } from "@cardigan/runtime-herdr";

const capture = promisify(execFile);
const HEAD_BYTES = 64 * 1024;

export async function captureTranscript(
  file: string,
  args: readonly string[],
  signal?: AbortSignal,
) {
  const pending = capture(file, args, {
    encoding: "utf8",
    env: { PATH: AGENT_PATH },
    timeout: 10_000,
    killSignal: "SIGKILL",
    maxBuffer: HEAD_BYTES,
    ...(signal ? { signal } : {}),
  });
  // Abort reports an error before the child closes. Shutdown must also wait
  // for the actual process/stdio cleanup before dropping the in-flight slot.
  const closed = new Promise<void>((resolve) =>
    pending.child.once("close", () => resolve()),
  );
  try {
    const { stdout } = await pending;
    return stdout;
  } finally {
    await closed;
  }
}
