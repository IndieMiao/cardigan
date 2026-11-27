import {
  type Assignment,
  type Clock,
  type CommandState,
  DEFAULT_UPSTREAM_OUTAGE_POLICY,
  eventsOfType,
  type ProjectId,
  type PromptBinding,
  type Run,
  type Runtime,
  recordUpstreamOutageResume,
  recordUpstreamOutageSession,
  remindUpstreamOutage,
  resolveUpstreamOutage,
  runHeldByUpstreamOutage,
  type UpstreamOutage,
  type UpstreamOutagePolicy,
  type UpstreamOutageResumeResult,
  unwrap,
  upstreamOutageOfRun,
  upstreamOutages,
} from "@cardigan/domain";
import {
  tryHostOpsLock,
  type UpstreamModelProbe,
  wakeIsCurrent,
} from "@cardigan/host";
import { loadCommandState, persistEffect } from "@cardigan/mcp-server";
import type { LaunchConfig } from "@cardigan/roles";
import {
  type Store,
  type StoreTransactionContext,
  unfinishedBellAttempts,
} from "@cardigan/store";

/** C-821: host wiring for the outage loop; the probe holds the credentials. */
export interface UpstreamOutageOptions {
  readonly launch: () => LaunchConfig | undefined;
  /** One minimal model request with the launch profile's own credentials. */
  readonly probe: (
    profile: string,
    signal: AbortSignal,
  ) => Promise<UpstreamModelProbe>;
}
interface Options {
  store: Store;
  runtime: Runtime;
  upstreamOutage: UpstreamOutageOptions;
  onError?: (error: unknown) => void;
}

const SCREEN_READ_INTERVAL_MS = 60_000;
const harnesses = new Set(["claude-code", "codex"]);
type Harness = PromptBinding["harness"];

export function upstreamOutagePolicy(
  config: LaunchConfig | undefined,
): UpstreamOutagePolicy {
  const set = config?.upstream_outage;
  const d = DEFAULT_UPSTREAM_OUTAGE_POLICY;
  return {
    probe_interval_ms: set?.probe_interval_ms ?? d.probe_interval_ms,
    remind_after_ms: set?.remind_after_ms ?? d.remind_after_ms,
    resume_window_ms: set?.resume_window_ms ?? d.resume_window_ms,
  };
}

/** The Run's provider: its launch profile's provider, else that profile's harness. */
export function runUpstream(
  config: LaunchConfig | undefined,
  state: CommandState,
  a: Assignment,
  run: Run,
) {
  const profile =
    run.launch_profile_ref ??
    (a.employee_id
      ? state.employees?.find((e) => e.id === a.employee_id)?.launch_profile_ref
      : undefined);
  const definition = profile ? config?.profiles[profile] : undefined;
  return {
    provider: definition?.provider ?? definition?.harness ?? run.harness,
    ...(definition && profile ? { profile } : {}),
  };
}
const clock = (at: string) => `${at.slice(11, 16)}Z`;

/**
 * C-821: sessions that stopped on a model API error. The terminal itself is
 * the evidence (read through the bound-prompt check, never exported); the
 * provider's outage is probed with a minimal model request; after recovery
 * every Run still stopped on the error gets one resume message.
 */
export class UpstreamOutageRecovery {
  private pending = new Map<ProjectId, Promise<void>>();
  private readonly nextRead = new Map<string, number>();
  private readonly nextProbe = new Map<string, number>();
  /** Shared by every project: one probe per profile and interval. */
  private readonly probes = new Map<
    string,
    { at: number; result: Promise<UpstreamModelProbe> }
  >();
  private readonly abort = new AbortController();
  constructor(
    private readonly options: Options,
    private readonly clock: Clock,
    private readonly closing: () => boolean,
  ) {}
  private policy() {
    return upstreamOutagePolicy(this.options.upstreamOutage.launch());
  }
  /** Inactivity alerts and inactive stops leave a reserved Run alone. */
  held(state: CommandState, run: Run["id"], at: string) {
    return runHeldByUpstreamOutage(state, run, at, this.policy());
  }
  private binding(project: ProjectId, a: Assignment, run: Run) {
    if (!run.harness || !harnesses.has(run.harness) || !a.runtime_ref) return;
    return {
      ref: a.runtime_ref,
      binding: {
        project_id: project,
        assignment_id: a.id,
        harness: run.harness as Harness,
        require_upstream_error: true as const,
      },
    };
  }
  /** Read-only: the bound CLI sits at an empty editor under a model API error. */
  async errorVisible(project: ProjectId, a: Assignment, run: Run) {
    const target = this.binding(project, a, run);
    if (!target || !this.options.runtime.observe_prompt) return false;
    const observed = await this.options.runtime
      .observe_prompt(target.ref, target.binding)
      .catch(() => undefined);
    return !!(observed?.ok && observed.value);
  }
  /** Inside the caller's transaction; true when the Run now waits for its outage. */
  record(
    tx: StoreTransactionContext,
    before: CommandState,
    a: Assignment,
    run: Run,
  ) {
    // Several Runs can stop in one transaction: each must see the outage
    // the previous one opened.
    const state = loadCommandState(tx, before.project_id);
    if (upstreamOutageOfRun(state, run.id))
      return this.held(state, run.id, this.clock.now());
    const { provider, profile } = runUpstream(
      this.options.upstreamOutage.launch(),
      state,
      a,
      run,
    );
    const effect = recordUpstreamOutageSession(
      state,
      { kind: "system", project_id: state.project_id },
      {
        provider: provider ?? "unknown",
        assignment_id: a.id,
        run_id: run.id,
        profile,
      },
      { clock: this.clock, ids: tx.ids },
    );
    if (!effect.ok || !effect.value.data.outage_id) return false;
    persistEffect(tx, state.project_id, effect.value);
    return true;
  }
  schedule(state: CommandState) {
    if (this.pending.has(state.project_id) || this.closing()) return;
    const pass = this.tick(state)
      .catch((e) => this.options.onError?.(e))
      .finally(() => this.pending.delete(state.project_id));
    this.pending.set(state.project_id, pass);
  }
  /** The passes in flight, without cancelling their probes. */
  async settled() {
    await Promise.all(this.pending.values());
  }
  async drain() {
    this.abort.abort();
    await this.settled();
  }
  private load(project: ProjectId) {
    return this.options.store.uow.read((tx) => loadCommandState(tx, project));
  }
  private write(
    project: ProjectId,
    step: (tx: StoreTransactionContext, state: CommandState) => boolean,
  ) {
    return this.options.store.uow.run((tx) =>
      step(tx, loadCommandState(tx, project)),
    );
  }
  async tick(s: CommandState) {
    if (this.closing()) return;
    await this.detect(s);
    for (const outage of upstreamOutages(this.load(s.project_id))) {
      if (this.closing()) return;
      if (!outage.resolved_at) await this.watch(s.project_id, outage);
      else await this.resume(s.project_id, outage);
    }
  }
  /** Runs already alerted as inactive (before C-821, or a missed read). */
  private async detect(s: CommandState) {
    const now = Date.parse(this.clock.now());
    const inactive = new Set(
      eventsOfType(s.events, "run_inactive").map(
        (e) => (e.payload as { run_id?: string }).run_id,
      ),
    );
    for (const run of s.runs) {
      const key = `${s.project_id}/${run.id}`;
      if (
        run.status !== "running" ||
        !inactive.has(run.id) ||
        upstreamOutageOfRun(s, run.id) ||
        (this.nextRead.get(key) ?? 0) > now
      )
        continue;
      const a = s.assignments.find((x) => x.id === run.assignment_id);
      if (a?.status !== "active" || a.external) continue;
      this.nextRead.set(key, now + SCREEN_READ_INTERVAL_MS);
      if (!(await this.errorVisible(s.project_id, a, run)) || this.closing())
        continue;
      this.write(s.project_id, (tx, state) => {
        const owner = state.assignments.find((x) => x.id === a.id);
        const current = state.runs.find((r) => r.id === run.id);
        return (
          !!owner &&
          current?.status === "running" &&
          JSON.stringify(owner.runtime_ref) === JSON.stringify(a.runtime_ref) &&
          this.record(tx, state, owner, current)
        );
      });
    }
    for (const key of this.nextRead.keys())
      if (
        key.startsWith(`${s.project_id}/`) &&
        !s.runs.some(
          (r) => r.status === "running" && key === `${s.project_id}/${r.id}`,
        )
      )
        this.nextRead.delete(key);
  }
  private probeOnce(profile: string, interval: number) {
    const now = Date.parse(this.clock.now());
    const cached = this.probes.get(profile);
    if (cached && now - cached.at < interval) return cached.result;
    const result = Promise.resolve()
      .then(() => this.options.upstreamOutage.probe(profile, this.abort.signal))
      .catch(
        (): UpstreamModelProbe => ({ ok: false, failure: "connection_error" }),
      );
    this.probes.set(profile, { at: now, result });
    return result;
  }
  /** Probe, fall back to the provider's own sessions, remind once. */
  private async watch(project: ProjectId, outage: UpstreamOutage) {
    const policy = this.policy();
    const now = Date.parse(this.clock.now());
    const key = `${project}/${outage.id}`;
    if ((this.nextProbe.get(key) ?? 0) > now) return;
    this.nextProbe.set(key, now + policy.probe_interval_ms);
    const profile = outage.sessions.findLast((x) => x.profile)?.profile;
    const probe = profile
      ? await this.probeOnce(profile, policy.probe_interval_ms)
      : ({ ok: false, failure: "not_configured" } as const);
    if (this.closing()) return;
    this.write(project, (tx, state) => {
      const current = upstreamOutages(state).find((o) => o.id === outage.id);
      if (!current || current.resolved_at) return false;
      const actor = { kind: "system" as const, project_id: project };
      const ports = { clock: this.clock, ids: tx.ids };
      const evidence = probe.ok
        ? "model_probe"
        : probe.failure === "not_configured" &&
            this.activityRecovered(state, current)
          ? "session_activity"
          : undefined;
      if (evidence) {
        persistEffect(
          tx,
          project,
          unwrap(
            resolveUpstreamOutage(
              state,
              actor,
              { outage_id: current.id, evidence },
              ports,
            ),
          ),
        );
        this.nextProbe.delete(key);
        return true;
      }
      if (
        current.reminded_at ||
        Date.parse(this.clock.now()) - Date.parse(current.started_at) <
          policy.remind_after_ms
      )
        return false;
      const config = this.options.upstreamOutage.launch();
      const alternatives = Object.entries(config?.profiles ?? {})
        .filter(([, p]) => (p.provider ?? p.harness) !== current.provider)
        .map(([name]) => name)
        .sort();
      persistEffect(
        tx,
        project,
        unwrap(
          remindUpstreamOutage(
            state,
            actor,
            { outage_id: current.id, alternatives },
            ports,
          ),
        ),
      );
      return true;
    });
  }
  /** Without a probe: a session of the same provider progressed after the last stop. */
  private activityRecovered(state: CommandState, outage: UpstreamOutage) {
    const since = Math.max(...outage.sessions.map((x) => Date.parse(x.at)));
    const stopped = new Set(outage.sessions.map((x) => x.run_id));
    const config = this.options.upstreamOutage.launch();
    return state.runs.some((run) => {
      if (run.status !== "running" || stopped.has(run.id)) return false;
      const a = state.assignments.find((x) => x.id === run.assignment_id);
      return (
        !!a &&
        a.status === "active" &&
        runUpstream(config, state, a, run).provider === outage.provider &&
        Date.parse(a.last_mcp_activity_at ?? "") > since
      );
    });
  }
  private eligible(state: CommandState, a: Assignment, run: Run) {
    return (
      run.status === "running" &&
      a.status === "active" &&
      !a.external &&
      !a.role_upgrade &&
      a.idle_retirement?.phase !== "stopping" &&
      wakeIsCurrent(state, a, run.id) &&
      !unfinishedBellAttempts(
        this.options.store.database,
        state.project_id,
        a.id,
      ).length
    );
  }
  private async resume(project: ProjectId, outage: UpstreamOutage) {
    const resolved = outage.resolved_at;
    if (
      !resolved ||
      Date.parse(this.clock.now()) - Date.parse(resolved) >=
        this.policy().resume_window_ms
    )
      return;
    for (const session of outage.sessions) {
      if (session.resume || this.closing()) continue;
      const s = this.load(project);
      const a = s.assignments.find((x) => x.id === session.assignment_id);
      const run = s.runs.find((r) => r.id === session.run_id);
      if (!a || !run || !this.eligible(s, a, run)) continue;
      const target = this.binding(project, a, run);
      if (!target) continue;
      const result = (value: UpstreamOutageResumeResult) =>
        this.write(project, (tx, state) => {
          const owner = state.assignments.find((x) => x.id === a.id);
          const current = state.runs.find((r) => r.id === run.id);
          if (
            !owner ||
            !current ||
            (value === "sent" && !this.eligible(state, owner, current))
          )
            return false;
          const effect = recordUpstreamOutageResume(
            state,
            { kind: "system", project_id: project },
            { outage_id: outage.id, run_id: run.id, result: value },
            { clock: this.clock, ids: tx.ids },
          );
          if (!effect.ok) return false;
          persistEffect(tx, project, effect.value);
          return true;
        });
      const unlock = await tryHostOpsLock(
        this.options.store,
        project,
        a.id,
        "launch",
      );
      if (!unlock) continue;
      let claimed = false;
      try {
        const sent = await this.options.runtime
          .wake(
            target.ref,
            `模型服务 ${outage.provider} 在 ${clock(outage.started_at)} 到 ${clock(resolved)} 中断，现已恢复。请从中断处继续当前 ${run.id} 的工作。`,
            {
              prompt_binding: target.binding,
              ...(target.ref.machine_id !== "local"
                ? { session_run: { assignment_id: a.id, run_id: run.id } }
                : {}),
              before_send: () => {
                claimed = result("sent");
                return claimed;
              },
            },
          )
          .catch(() => undefined);
        if (claimed) {
          if (!sent?.ok || !sent.value.sent) result("unconfirmed");
        } else if (sent?.ok && sent.value.withdrawn) result("skipped");
        else result("failed");
      } finally {
        await unlock();
      }
    }
  }
}
