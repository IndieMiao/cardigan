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
   * Record the core's current PID. Only called while the socket exists, so it
   * can never start a core; a core that appeared after the previous stop gets a
   * new PID and this refresh is what catches it.
   */
  remember(): number | undefined {
    if (!existsSync(this.socket)) return this.#pid;
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

  /**
   * Stop through hc first, then make sure every PID this test ever saw is gone.
   * Idempotent and safe to call again right before the temporary directory (and
   * with it the socket) is removed.
   */
  async stop(): Promise<void> {
    // Two rounds: a stop can reveal a core that was started in between (for
    // example by an hc command issued from another cleanup step).
    for (let round = 0; round < 2; round += 1) {
      this.remember();
      if (existsSync(this.socket))
        try {
          await exec("hc", ["server", "stop", "--json"], {
            env: this.hcEnv,
            timeout: 5_000,
          });
        } catch {
          // Socket vanished or stop failed; the PID path finishes the job.
        }
      await this.terminate();
      if (!existsSync(this.socket)) break;
    }
    this.assertStopped();
  }

  /** SIGTERM the recorded PID, then SIGKILL if it is still alive. */
  private async terminate(): Promise<void> {
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
  }

  /**
   * Fail the test instead of leaking: the core this test recorded must be dead
   * and its socket must be gone. PIDs only — never a command-line match.
   */
  assertStopped(): void {
    if (this.#pid !== undefined && alive(this.#pid))
      throw new Error(
        `herdr-core ${this.#pid} (session ${this.session}) is still alive`,
      );
    if (existsSync(this.socket))
      throw new Error(
        `herdr-core socket for session ${this.session} still exists: ${this.socket}`,
      );
  }
}
