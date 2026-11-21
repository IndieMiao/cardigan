import type { Assignment, Run } from "@cardigan/domain";
import type { HerdrRuntime } from "@cardigan/runtime-herdr";

type Result = Awaited<ReturnType<HerdrRuntime["terminalActivity"]>>;
export interface TerminalEvidence {
  observedSince: number;
  foreground?: { command: string; since: number };
}
/** A single screen is not proof of either recent output or a silent terminal. */
export class TerminalHistory {
  private rows = new Map<
    string,
    {
      binding: string;
      digest?: string;
      at: number;
      fg?: { key: string; since: number };
    }
  >();
  retain(project: string, running: Set<string>) {
    for (const key of this.rows.keys())
      if (
        key.startsWith(`${project}/`) &&
        !running.has(key.slice(project.length + 1))
      )
        this.rows.delete(key);
  }
  interrupted(
    project: string,
    run: Run,
    a: Assignment,
    now: number,
    grace: number,
  ) {
    const old = this.rows.get(`${project}/${run.id}`);
    if (
      !old ||
      old.binding !== JSON.stringify([a.id, a.runtime_ref, a.session_ref])
    )
      return false;
    delete old.digest; // Never infer continued silence or command duration across a failed read.
    delete old.fg;
    return old.at <= now && now - old.at < grace;
  }
  observe(
    project: string,
    run: Run,
    a: Assignment,
    now: number,
    result: Result | undefined,
  ): TerminalEvidence | undefined {
    const key = `${project}/${run.id}`;
    if (!result?.ok) return;
    const binding = JSON.stringify([a.id, a.runtime_ref, a.session_ref]);
    const old = this.rows.get(key);
    const prior = old?.binding === binding && old.at <= now ? old : undefined;
    const { digest, foreground } = result.value;
    const at =
      digest === prior?.digest && foreground?.key === prior.fg?.key
        ? prior.at
        : now;
    const fg = foreground && {
      key: foreground.key,
      since: prior?.fg?.key === foreground.key ? prior.fg.since : now,
    };
    this.rows.set(key, { binding, digest, at, ...(fg ? { fg } : {}) });
    return {
      observedSince: at,
      ...(foreground && fg
        ? { foreground: { command: foreground.command, since: fg.since } }
        : {}),
    };
  }
}
