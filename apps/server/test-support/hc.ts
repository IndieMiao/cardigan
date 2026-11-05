import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

/**
 * herdr-core cleanup for the tests that use a real `hc`.
 *
 * A core outlives the test process when a hook times out before it stops: the
 * socket file is gone, `hc server stop` cannot connect any more, and the only
 * way to end it is its PID. Remember the PID while the socket is still there,
 * stop the core first, and fall back to SIGTERM/SIGKILL on that exact PID —
 * never by pattern-matching processes.
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

export class HcCore {
  #pid: number | undefined;
  constructor(
    readonly session: string,
    readonly socket: string,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  get pid(): number | undefined {
    return this.#pid;
  }

  private get hcEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      ...this.env,
      HC_SESSION: this.session,
      HC_SOCKET: this.socket,
    };
  }

  /**
   * Record the core's PID. Never spawns a core: without a socket there is
   * nothing this test owns to remember.
   */
  remember(): number | undefined {
    if (this.#pid !== undefined) return this.#pid;
    if (!existsSync(this.socket)) return undefined;
    try {
      const status = JSON.parse(
        execFileSync("hc", ["server", "status", "--json"], {
          encoding: "utf8",
          timeout: 5_000,
          env: this.hcEnv,
        }),
      ) as { pid?: unknown };
      if (typeof status.pid === "number") this.#pid = status.pid;
    } catch {
      // A core that cannot report is left to the socket-based stop below.
    }
    return this.#pid;
  }

  /** Stop through hc first, then make sure the recorded PID is gone. */
  async stop(): Promise<void> {
    if (existsSync(this.socket))
      try {
        await exec("hc", ["server", "stop", "--json"], {
          env: this.hcEnv,
          timeout: 5_000,
        });
      } catch {
        // Socket vanished or stop failed; the PID path below finishes the job.
      }
    const pid = this.#pid;
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
        `herdr-core ${pid} (session ${this.session}) survived SIGKILL`,
      );
  }
}
