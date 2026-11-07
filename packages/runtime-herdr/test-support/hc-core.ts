import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * herdr-core cleanup for the runtime tests that start a real `hc`.
 *
 * A core can outlive the test process: if a hook times out first, the socket is
 * gone and `hc server stop` cannot reach it. These helpers record the core's
 * PID while the socket still exists and fall back to SIGTERM/SIGKILL on that
 * exact PID; nothing is matched by process name.
 */
const holders = new Map<string, Set<number>>();
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
    ) as { pid?: unknown; holders?: { pid?: unknown }[] };
    const pids = holders.get(options.socket) ?? new Set<number>();
    for (const holder of status.holders ?? [])
      if (typeof holder.pid === "number") pids.add(holder.pid);
    holders.set(options.socket, pids);
    return typeof status.pid === "number" ? status.pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Stop the core only by its recorded PID (SIGTERM, then SIGKILL if needed).
 * Safe to call more than once.
 */
export async function stopCore(
  options: CoreOptions & { readonly pid?: number | undefined },
): Promise<void> {
  const pid = corePid(options) ?? options.pid;
  // Holders own the PTYs and can restart core; end only those recorded PIDs first.
  for (const holder of holders.get(options.socket) ?? [])
    await terminate(holder);
  await terminate(pid);
  holders.delete(options.socket);
  if (existsSync(options.socket))
    throw new Error(
      `herdr-core socket for session ${options.session} still exists: ${options.socket}`,
    );
}

async function terminate(pid: number | undefined): Promise<void> {
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
  // Fail the test instead of leaking; PIDs only, never a command-line match.
  if (alive(pid)) throw new Error(`herdr-core process ${pid} survived SIGKILL`);
}
