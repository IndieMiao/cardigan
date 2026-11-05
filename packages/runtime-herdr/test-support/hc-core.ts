import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

/**
 * herdr-core cleanup for the runtime tests that start a real `hc`.
 *
 * A core can outlive the test process: if a hook times out first, the socket is
 * gone and `hc server stop` cannot reach it. These helpers record the core's
 * PID while the socket still exists and fall back to SIGTERM/SIGKILL on that
 * exact PID; nothing is matched by process name.
 */
const exec = promisify(execFile);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export interface CoreOptions {
  readonly session: string;
  readonly socket: string;
  readonly env?: NodeJS.ProcessEnv;
}

function hcEnv(options: CoreOptions): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...options.env,
    HC_SESSION: options.session,
    HC_SOCKET: options.socket,
  };
}

/** The core's PID while its socket still exists; never starts a core. */
export function corePid(options: CoreOptions): number | undefined {
  if (!existsSync(options.socket)) return undefined;
  try {
    const status = JSON.parse(
      execFileSync("hc", ["server", "status", "--json"], {
        encoding: "utf8",
        timeout: 5_000,
        env: hcEnv(options),
      }),
    ) as { pid?: unknown };
    return typeof status.pid === "number" ? status.pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Stop the core: `hc server stop` while the socket exists, then SIGTERM and
 * finally SIGKILL on the recorded PID. Safe to call more than once.
 */
export async function stopCore(
  options: CoreOptions & { readonly pid?: number | undefined },
): Promise<void> {
  if (existsSync(options.socket))
    try {
      await exec("hc", ["server", "stop", "--json"], {
        env: hcEnv(options),
        timeout: 5_000,
      });
    } catch {
      // Socket vanished or stop failed; the PID path below finishes the job.
    }
  const pid = options.pid;
  if (pid === undefined || !alive(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!alive(pid)) return;
    await sleep(50);
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return;
  }
  await sleep(200);
  if (alive(pid))
    throw new Error(
      `herdr-core ${pid} (session ${options.session}) survived SIGKILL`,
    );
}
