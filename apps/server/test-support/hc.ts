import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readlinkSync } from "node:fs";
import { type HcClient, processClient } from "@cardigan/runtime-herdr";

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

/**
 * Safely identify a PID before signalling it.
 *
 * A recorded PID can be recycled by an unrelated process after its core exits.
 * Require `/proc/<pid>/exe` to be herdr-core and the process environment to
 * carry this exact HC_SESSION; any read failure means "already gone", so we
 * skip it instead of signalling a stranger.
 */
export function isHerdrCoreProcess(
  pid: number | undefined,
  session: string,
): boolean {
  if (pid === undefined) return false;
  try {
    const exe = readlinkSync(`/proc/${pid}/exe`);
    if (exe.split("/").pop() !== "herdr-core") return false;
    const environ = readFileSync(`/proc/${pid}/environ`, "utf8");
    return environ.split("\0").includes(`HC_SESSION=${session}`);
  } catch {
    return false;
  }
}

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
  readonly #lateCalls: string[] = [];
  #stopped = false;
  constructor(
    readonly session: string,
    readonly socket: string,
    private readonly env: NodeJS.ProcessEnv,
  ) {
    liveCores.add(this);
    installExitHook();
  }

  /** Record a PID inspected by status or a test fixture. */
  trackPid(pid: number, holder = false): void {
    if (!Number.isSafeInteger(pid) || pid <= 0) return;
    if (holder) this.#holders.add(pid);
    else this.#pid = pid;
    liveCores.add(this);
  }

  private owns(pid: number | undefined): boolean {
    return isHerdrCoreProcess(pid, this.session);
  }

  /** Drop a PID that is gone, or whose number now belongs to someone else. */
  private forgetPid(pid: number): void {
    if (this.#pid === pid) this.#pid = undefined;
    this.#holders.delete(pid);
  }

  private prune(): void {
    if (this.#pid !== undefined && !this.owns(this.#pid)) this.#pid = undefined;
    for (const pid of [...this.#holders])
      if (!this.owns(pid)) this.#holders.delete(pid);
  }

  /** Synchronous last resort; normal cleanup remains `stop()`. */
  killRecordedNow(): void {
    for (const pid of [this.#pid, ...this.#holders])
      if (pid !== undefined && this.owns(pid))
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // The PID is already gone or not ours any more.
        }
    this.prune();
  }

  get pid(): number | undefined {
    return this.#pid;
  }

  /**
   * Every hc call started after `stop()` began, with its call stack.
   *
   * `hc` starts a holder and a core on demand, so one late call from a timer
   * that outlived cleanup leaves an orphan core for the rest of the machine's
   * uptime. Recording the stack is what turns that race into a fixable bug.
   */
  get lateCalls(): readonly string[] {
    return this.#lateCalls;
  }

  /**
   * A real `hc` client for this session that refuses to run once `stop()`
   * began, so a late timer fails loudly instead of restarting the core.
   */
  client(options: { readonly timeoutMs?: number } = {}): HcClient {
    const timeoutMs = options.timeoutMs ?? 10_000,
      inner = processClient("hc", this.hcEnv, this.socket, timeoutMs);
    const guard = (action: string): void => {
      if (!this.#stopped) return;
      const stack = new Error(`hc ${action}`).stack ?? "",
        trace = `hc ${action} (session ${this.session})\n${stack}`;
      this.#lateCalls.push(trace);
      process.stderr.write(`[hc-cleanup] hc ran after cleanup:\n${trace}\n`);
      throw new Error(
        `hc refused: the ${this.session} session is stopped (${action})`,
      );
    };
    return {
      available: async () => {
        guard("available");
        return inner.available();
      },
      // Async, so a refusal reaches callers as a rejection like a real failure.
      exec: async (args, commandTimeoutMs) => {
        guard(args.join(" "));
        return inner.exec(args, commandTimeoutMs);
      },
      lines: (args, signal) => {
        guard(`${args.join(" ")} (stream)`);
        return inner.lines(args, signal);
      },
    };
  }

  /** Fail instead of leaking when a background task called hc during cleanup. */
  assertNoLateCalls(): void {
    if (this.#lateCalls.length > 0)
      throw new Error(
        `hc ran after herdr-core ${this.session} stopped: ${this.#lateCalls.join("\n")}`,
      );
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
      if (typeof status.pid === "number") this.trackPid(status.pid);
      for (const holder of status.holders ?? [])
        if (typeof holder.pid === "number") this.trackPid(holder.pid, true);
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
      this.prune();
      if (
        !existsSync(this.socket) &&
        this.#pid === undefined &&
        this.#holders.size === 0
      )
        break;
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
    this.#pid = undefined;
    this.#holders.clear();
    liveCores.delete(this);
  }

  /**
   * Final cleanup: latch the session shut, stop it and verify it stays down.
   *
   * Mid-test stops (`stop()` on its own) are allowed to come back — a test that
   * kills the core to simulate a lost machine expects the next hc call to start
   * a new one. Only the end of a worker may forbid that, and then every later
   * hc call fails with its stack instead of leaving an orphan process.
   */
  async finalStop(): Promise<void> {
    this.#stopped = true;
    await this.stop();
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

  /** SIGTERM the recorded PID, then SIGKILL if it is still ours. */
  private async terminate(pid: number | undefined): Promise<void> {
    if (pid === undefined) return;
    if (!this.owns(pid)) {
      this.forgetPid(pid);
      return;
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      this.forgetPid(pid);
      return;
    }
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (!this.owns(pid)) {
        this.forgetPid(pid);
        return;
      }
      await sleep(50);
    }
    // The PID may have been recycled while waiting; never signal a stranger.
    if (!this.owns(pid)) {
      this.forgetPid(pid);
      return;
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      this.forgetPid(pid);
      return;
    }
    await sleep(200);
    if (!this.owns(pid)) this.forgetPid(pid);
  }

  /**
   * Fail the test instead of leaking: the core this test recorded must be dead
   * and its socket must be gone. PIDs only — never a command-line match.
   */
  assertStopped(): void {
    this.prune();
    if (this.#pid !== undefined)
      throw new Error(
        `herdr-core ${this.#pid} (session ${this.session}) is still alive`,
      );
    for (const pid of this.#holders)
      throw new Error(
        `herdr-core holder ${pid} (session ${this.session}) is still alive`,
      );
    if (existsSync(this.socket))
      throw new Error(
        `herdr-core socket for session ${this.session} still exists: ${this.socket}`,
      );
    this.assertNoLateCalls();
  }
}
