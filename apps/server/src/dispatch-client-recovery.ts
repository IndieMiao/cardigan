import {
  type Assignment,
  assignmentCardHeld,
  assignmentDependenciesAllowStart,
  type Clock,
  type CommandState,
  currentHarnessActivity,
  eventsOfType,
  type HarnessActivity,
  hasRunTarget,
  lastRunActivity,
  type ProjectId,
  type Run,
  type Runtime,
  reviewReceiptTargetCurrent,
  runModelOutputTime,
  upstreamOutageOfRun,
} from "@cardigan/domain";
import { tryHostOpsLock, turnSessionKey, wakeIsCurrent } from "@cardigan/host";
import { loadCommandState } from "@cardigan/mcp-server";
import { payloadString } from "@cardigan/router";
import { type Store, unfinishedBellAttempts } from "@cardigan/store";

interface Options {
  store: Store;
  runtime: Runtime;
  harnessActivity?: (
    project: ProjectId,
    owner: Assignment["id"],
  ) => HarnessActivity | undefined;
  onError?: (error: unknown) => void;
}

import { dispatchAlert, hostOpsAlertRecipient } from "./dispatch-alert.js";

const interval = 60_000;
const claimed = "client_resume_claimed";
const attention = "client_resume_attention";
const progressed = "client_resume_progressed";
const clearScreen = "client_resume_screen_cleared";
function receivedOnBoundTerminal(run: Run, a: Assignment) {
  const bell = run.bell_delivery;
  return (
    bell?.run_id === run.id &&
    !!bell.received_at &&
    (!bell.session_ref || bell.session_ref === a.session_ref) &&
    JSON.stringify(bell.runtime_ref) === JSON.stringify(a.runtime_ref)
  );
}
function receipt(s: CommandState, run: Run, type: string) {
  return eventsOfType(s.events, type).findLast(
    (e) =>
      e.actor.kind === "system" &&
      (e.payload as { run_id?: string }).run_id === run.id,
  );
}

/** No launch, restart, ACK or new business Run. The write budget is taken in
 * before_send, after the adapter re-proves the prompt and immediately before IO. */
export class ClientRecovery {
  private pending = new Map<ProjectId, Promise<void>>();
  schedule(s: CommandState) {
    if (this.pending.has(s.project_id) || this.closing()) return;
    const pass = this.tick(s)
      .catch((e) => this.options.onError?.(e))
      .finally(() => this.pending.delete(s.project_id));
    this.pending.set(s.project_id, pass);
  }
  async drain() {
    await Promise.all(this.pending.values());
  }
  private next = new Map<string, number>();
  constructor(
    private options: Options,
    private clock: Clock,
    private closing: () => boolean,
  ) {}
  private proof(s: CommandState, a: Assignment, run: Run) {
    const raw = this.options.harnessActivity?.(s.project_id, a.id);
    const sample = currentHarnessActivity(s, a, this.clock.now(), raw);
    const since = lastRunActivity(run, a);
    if (
      sample &&
      sample.source === `${run.harness}:session_metadata` &&
      Date.parse(sample.updated_at) > since
    ) {
      if (sample.error === "stream_disconnected")
        return { screen: false, at: Date.parse(sample.updated_at) };
      if (sample.error === "unclassified" || sample.turn_ended)
        return { screen: true, at: Date.parse(sample.updated_at) };
      return;
    }
    // Workers need not export a transcript. An acknowledged bell on this exact
    // session plus the client's *current* disconnect-and-empty-editor UI is required.
    if (
      !raw &&
      receivedOnBoundTerminal(run, a) &&
      Date.parse(this.clock.now()) - since >= interval
    )
      return { screen: true, at: since };
  }
  private lastProgress(s: CommandState, a: Assignment, run: Run) {
    return lastRunActivity(
      run,
      a,
      runModelOutputTime(
        s,
        a,
        run,
        this.clock.now(),
        this.options.harnessActivity?.(s.project_id, a.id),
      ),
    );
  }
  private eligible(s: CommandState, a: Assignment, run: Run) {
    const w = s.work_items.find((w) => w.id === a.work_item_id);
    return (
      run.status === "running" &&
      !a.role_upgrade &&
      a.idle_retirement?.phase !== "stopping" &&
      wakeIsCurrent(s, a, run.id) &&
      hasRunTarget(a, s) &&
      !assignmentCardHeld(a, s, run.trigger_event_id) &&
      assignmentDependenciesAllowStart(s, a) &&
      reviewReceiptTargetCurrent(s, a, run) &&
      // C-842: a Run the upstream outage flow took gets its resume there.
      !upstreamOutageOfRun(s, run.id) &&
      (a.scope !== "work_item" ||
        (w?.assignment_id === a.id && w.status === "in_progress")) &&
      !unfinishedBellAttempts(this.options.store.database, s.project_id, a.id)
        .length
    );
  }
  async tick(s: CommandState) {
    const { runtime, store } = this.options;
    if (this.closing()) return;
    const now = Date.parse(this.clock.now()),
      project = s.project_id;
    const running = new Set(
      s.runs
        .filter((r) => r.status === "running")
        .map((r) => `${project}/${r.id}`),
    );
    for (const k of this.next.keys())
      if (k.startsWith(`${project}/`) && !running.has(k)) this.next.delete(k);
    for (const run of s.runs) {
      const key = `${project}/${run.id}`;
      if (
        run.status !== "running" ||
        (run.harness !== "codex" && run.harness !== "claude-code") ||
        this.closing() ||
        (this.next.get(key) ?? 0) > now ||
        receipt(s, run, attention)
      )
        continue;
      const a = s.assignments.find((a) => a.id === run.assignment_id);
      const ref = a?.runtime_ref;
      if (!a || !ref) continue;
      const previous = receipt(s, run, claimed);
      const resolved = previous && receipt(s, run, progressed);
      const watching = previous && !resolved;
      const proof = watching ? undefined : this.proof(s, a, run);
      const screenOnly = (
        state: CommandState,
        owner: Assignment,
        current: Run,
      ) =>
        receivedOnBoundTerminal(current, owner) &&
        !this.options.harnessActivity?.(state.project_id, owner.id);
      const claimSession =
        previous && payloadString(previous.payload, "session_key");
      const sameSession = (owner: Assignment) =>
        !claimSession || claimSession === turnSessionKey(owner);
      // A new terminal cannot establish a transition on the claimed terminal.
      if (resolved && !sameSession(a)) continue;
      const monitorScreen = previous && sameSession(a) && screenOnly(s, a, run);
      if ((!watching && !proof && !monitorScreen) || !this.eligible(s, a, run))
        continue;
      this.next.set(key, now + interval);
      const write = (
        type: string,
        reason: string,
        valid: (
          state: CommandState,
          owner: Assignment,
          current: Run,
        ) => boolean,
        progressAt?: number,
      ) =>
        store.uow.run((tx) => {
          const state = loadCommandState(tx, project),
            owner = tx.assignments.get(project, a.id),
            current = tx.runs.get(project, run.id);
          if (
            this.closing() ||
            !owner ||
            !current ||
            !wakeIsCurrent(state, a, run.id) ||
            !this.eligible(state, owner, current) ||
            !valid(state, owner, current) ||
            receipt(state, run, type) ||
            (type === claimed && receipt(state, run, attention))
          )
            return false;
          dispatchAlert(tx, store, state, this.clock.now(), {
            assignment: owner,
            run_id: run.id,
            card_id: state.work_items.find((w) => w.id === owner.work_item_id)
              ?.card_id,
            type,
            reason,
            session_key: turnSessionKey(owner),
            ...(progressAt !== undefined
              ? { progress_at: new Date(progressAt).toISOString() }
              : {}),
            notifyHostOps: type === attention,
            audience:
              type !== attention
                ? "activity_log"
                : hostOpsAlertRecipient(state, owner)
                  ? "host_ops_only"
                  : "ops",
          });
          return true;
        });
      // The receipt survives both a server restart and the disappearance of
      // the original error screen. Watching it never grants another write.
      if (watching) {
        const at = Date.parse(previous.created_at);
        const progressTime = (
          state: CommandState,
          owner: Assignment,
          current: Run,
        ) =>
          sameSession(owner)
            ? this.lastProgress(state, owner, current)
            : Number.NEGATIVE_INFINITY;
        const latest = progressTime(s, a, run);
        if (latest > at) {
          if (
            !write(
              progressed,
              "续跑后已检测到本轮新进展",
              (state, owner, current) =>
                progressTime(state, owner, current) >= latest,
              latest,
            )
          )
            continue;
        } else {
          if (now - at >= interval)
            write(
              attention,
              "领取续跑提示后仍无本轮新进展；请主机运维核对原会话，不重复投递。",
              (state, owner, current) =>
                !receipt(state, current, progressed) &&
                progressTime(state, owner, current) <= at,
            );
          continue;
        }
        if (!monitorScreen) continue;
      }
      // No transcript timestamp exists on this worker. MCP progress says the
      // Run moved, not that the old error actually disappeared. Require a
      // positive clear -> disconnected transition on this very same terminal.
      // An unreadable screen is neither observation. Neither path can wake.
      if (monitorScreen) {
        const clear = receipt(s, run, clearScreen);
        if (
          !runtime.observe_prompt ||
          (clear &&
            (payloadString(clear.payload, "session_key") !==
              turnSessionKey(a) ||
              now - lastRunActivity(run, a) < interval))
        )
          continue;
        const observation = await runtime
          .observe_prompt(ref, {
            project_id: project,
            assignment_id: a.id,
            harness: run.harness,
            require_disconnect: !!clear,
          })
          .catch(() => undefined);
        if (observation?.ok && observation.value) {
          write(
            clear ? attention : clearScreen,
            clear
              ? "本轮恢复后原终端再次断流；请主机运维接管，不再自动发送。"
              : "已核实原终端不再显示上次断流。",
            (state, owner, current) =>
              screenOnly(state, owner, current) &&
              lastRunActivity(current, owner) === lastRunActivity(run, a) &&
              !!receipt(state, current, progressed) &&
              !receipt(state, current, attention) &&
              receipt(state, current, clearScreen)?.id === clear?.id,
          );
        }
        continue;
      }
      // After verified progress, only a new disconnect can need handoff.
      // In particular, a stale/missing sample cannot reopen this watch.
      if (
        !proof ||
        !runtime.observe_prompt ||
        (resolved &&
          proof.at <=
            Date.parse(
              payloadString(resolved.payload, "progress_at") ??
                resolved.created_at,
            ))
      )
        continue;
      const sameEvidence = (
        state: CommandState,
        owner: Assignment,
        current: Run,
      ) => {
        const fresh = this.proof(state, owner, current);
        return (
          lastRunActivity(current, owner) === lastRunActivity(run, a) &&
          fresh?.at === proof.at &&
          fresh.screen === proof.screen
        );
      };
      const binding = {
        project_id: project,
        assignment_id: a.id,
        harness: run.harness,
        ...(proof.screen ? { require_disconnect: true as const } : {}),
      };
      const observed = await runtime
        .observe_prompt(ref, binding)
        .catch(() => undefined);
      if (!observed?.ok || !observed.value) {
        // Absence of a screen-only match isn't an incident. A positively
        // attributed disconnect with persistently unverified ownership is.
        if (!proof.screen && now - lastRunActivity(run, a) >= 2 * interval)
          write(
            attention,
            "断流后无法确认客户端空闲或归属；请主机运维核对原终端并续办，不自动重启。",
            sameEvidence,
          );
        continue;
      }
      if (previous) {
        write(
          attention,
          "续跑后本轮再次断流；请主机运维接管原会话，不再自动发送。",
          sameEvidence,
        );
        continue;
      }
      const unlock = await tryHostOpsLock(store, project, a.id, "launch");
      if (!unlock) continue;
      try {
        const result = await runtime
          .wake(ref, `请继续当前 ${run.id} 未完成的工作。`, {
            prompt_binding: binding,
            ...(ref.machine_id !== "local"
              ? { session_run: { assignment_id: a.id, run_id: run.id } }
              : {}),
            before_send: () =>
              write(claimed, "客户端断流，领取本轮唯一续跑提示", sameEvidence),
          })
          .catch(() => undefined);
        if (result?.ok && result.value.sent)
          write(
            "client_resume_sent",
            "已向原会话发送续跑提示",
            (state) => !!receipt(state, run, claimed),
          );
        else if (!result?.ok || !result.value.withdrawn)
          write(
            attention,
            "续跑提示送达不明；请主机运维核对原会话，不重复投递。",
            sameEvidence,
          );
      } finally {
        await unlock();
      }
    }
  }
}
