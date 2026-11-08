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

const liveCores = new Set<HcCore>();
let exitHookInstalled = false;

/** Last-resort synchronous cleanup if a worker exits before afterAll runs. */
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const core of liveCores) core.killRecordedNow();
  });
}

export interface CleanupStep {
  readonly label: string;
  readonly run: () => unknown | Promise<unknown>;
}

/**
 * Run every cleanup step even after one fails, then surface one explicit error.
 *
 * The session and socket are in the message so a leaked core can be identified
 * without matching process names; callers must record every PID they intend to
 * stop before removing the socket.
 */
export async function runCleanupSteps(input: {
  readonly session: string;
  readonly socket: string;
  readonly steps: readonly CleanupStep[];
}): Promise<void> {
  const problems: string[] = [];
  for (const step of input.steps) {
    try {
      await step.run();
    } catch (error) {
      problems.push(
        `${step.label}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (problems.length > 0)
    throw new Error(
      `Cleanup failed for herdr session ${input.session} (socket ${input.socket}):
- ${problems.join("\n- ")}`,
    );
}

export class HcCore {
  #pid: number | undefined;
  readonly #holders = new Set<number>();
  constructor(
    readonly session: string,
    readonly socket: string,
    private readonly env: NodeJS.ProcessEnv,
  ) {
    liveCores.add(this);
    installExitHook();
  }

  /** Synchronous last resort; normal cleanup remains `stop()`. */
  killRecordedNow(): void {
    for (const pid of [this.#pid, ...this.#holders])
      if (pid !== undefined && alive(pid))
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // The PID is already gone or not ours any more.
        }
  }

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
          timeout: 15_000,
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
    // Several rounds: a stop can reveal a core that was started in between
    // (for example by an hc command issued from another cleanup step).
    for (let round = 0; round < 4; round += 1) {
      // The socket-based stop works even when `status` times out under load
      // and therefore could not give us a PID. It still targets only this
      // session's socket; the recorded PIDs below cover holders and an
      // already-detached core.
      // Record holder and core PIDs while the socket still exists; the
      // session-scoped stop below can remove the socket before a later
      // `status` call could discover them.
      this.remember();
      if (existsSync(this.socket)) this.stopViaHc();
      await sleep(100);
      this.remember();
      // A live PTY holder can restart core after SIGTERM; stop its recorded
      // PID first so shutdown cannot resurrect this test session.
      for (const pid of this.#holders) await this.terminate(pid);
      await this.terminate(this.#pid);
      if (!existsSync(this.socket) && this.#pid === undefined) break;
      await sleep(150);
    }
    // A holder can start just after the last stop; settle once before claiming
    // the session is clean.
    await sleep(300);
    this.remember();
    if (existsSync(this.socket)) this.stopViaHc();
    for (const pid of this.#holders) await this.terminate(pid);
    await this.terminate(this.#pid);
    this.assertStopped();
  }

  /** Session-scoped stop for when the status call cannot return PIDs. */
  private stopViaHc(): void {
    try {
      execFileSync("hc", ["server", "stop", "--json"], {
        encoding: "utf8",
        timeout: 15_000,
        env: this.hcEnv,
      });
    } catch {
      // Fall through to the recorded-PID path.
    }
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
    for (const pid of this.#holders)
      if (alive(pid))
        throw new Error(
          `herdr-core holder ${pid} (session ${this.session}) is still alive`,
        );
    if (existsSync(this.socket))
      throw new Error(
        `herdr-core socket for session ${this.session} still exists: ${this.socket}`,
      );
  }
}
