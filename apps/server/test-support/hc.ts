import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * herdr-core cleanup for the tests that use a real `hc`.
 *
 * A core outlives the test process when a hook times out before it stops: the
 * socket file is gone, `hc server stop` cannot connect any more, and the only
 * way to end it is its PID. Remember the PID while the socket is still there,
 * send SIGTERM/SIGKILL only to that exact PID —
 * never by pattern-matching processes.
 */
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
  readonly #holders = new Set<number>();
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
      ) as { pid?: unknown; holders?: { pid?: unknown }[] };
      if (typeof status.pid === "number") this.#pid = status.pid;
      for (const holder of status.holders ?? [])
        if (typeof holder.pid === "number") this.#holders.add(holder.pid);
    } catch {
      // Keep the previously recorded PID if the status call fails.
    }
    return this.#pid;
  }

  /**
   * Stop only the recorded PID, then make sure it is gone.
   * Idempotent and safe to call again right before the temporary directory (and
   * with it the socket) is removed.
   */
  async stop(): Promise<void> {
    // Two rounds: a stop can reveal a core that was started in between (for
    // example by an hc command issued from another cleanup step).
    for (let round = 0; round < 2; round += 1) {
      this.remember();
      // A live PTY holder can restart core after SIGTERM; stop its recorded
      // PID first so shutdown cannot resurrect this test session.
      for (const pid of this.#holders) await this.terminate(pid);
      await this.terminate(this.#pid);
      if (!existsSync(this.socket)) break;
    }
    this.assertStopped();
  }

  /** SIGTERM the recorded PID, then SIGKILL if it is still alive. */
  private async terminate(pid: number | undefined): Promise<void> {
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
