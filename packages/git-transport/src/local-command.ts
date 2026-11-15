import { spawn } from "node:child_process";

/** Own a process group so timeout evidence is stronger than killing a client. */
export function localGitCommand(
  binary: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== "win32";
    const child = spawn(binary, [...args], {
      env,
      detached: grouped,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      stdoutSize = 0,
      stderrSize = 0,
      timedOut = false,
      overflow = false;
    const kill = () => {
      try {
        if (grouped && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH")
          child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutSize += Buffer.byteLength(chunk);
      if (stdoutSize > 4 * 1024 * 1024) {
        overflow = true;
        kill();
      } else stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderrSize += Buffer.byteLength(chunk);
      if (stderrSize > 4 * 1024 * 1024) {
        overflow = true;
        kill();
      } else stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (!timedOut && !overflow && code === 0) {
        resolve(stdout);
        return;
      }
      let executionExited = false;
      if (grouped && child.pid) {
        try {
          process.kill(-child.pid, 0);
        } catch (error) {
          executionExited = (error as NodeJS.ErrnoException).code === "ESRCH";
        }
      }
      reject(
        Object.assign(
          new Error(
            overflow
              ? "Git output exceeded limit"
              : `Command failed: ${binary}\n${stderr}`,
          ),
          {
            code,
            signal,
            killed: timedOut,
            stderr,
            executionExited,
          },
        ),
      );
    });
  });
}
