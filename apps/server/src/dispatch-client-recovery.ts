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
} from "@cardigan/domain";
import { tryHostOpsLock, wakeIsCurrent } from "@cardigan/host";
import { loadCommandState } from "@cardigan/mcp-server";
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
      if (sample.error === "stream_disconnected") return { screen: false };
      if (sample.error === "unclassified" || sample.turn_ended)
        return { screen: true };
      return;
    }
    // Workers need not export a transcript. An acknowledged bell on this exact
    // session plus the client's *current* disconnect-and-empty-editor UI is required.
    const bell = run.bell_delivery;
    if (
      !raw &&
      bell?.run_id === run.id &&
      bell.received_at &&
      JSON.stringify(bell.runtime_ref) === JSON.stringify(a.runtime_ref) &&
      Date.parse(this.clock.now()) - since >= interval
    )
      return { screen: true };
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
      (a.scope !== "work_item" ||
        (w?.assignment_id === a.id && w.status === "in_progress")) &&
      !unfinishedBellAttempts(this.options.store.database, s.project_id, a.id)
        .length
    );
  }
  async tick(s: CommandState) {
    const { runtime, store } = this.options;
    if (!runtime.observe_prompt || this.closing()) return;
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
      const proof = this.proof(s, a, run);
      if (!proof || !this.eligible(s, a, run)) continue;
      this.next.set(key, now + interval);
      const binding = {
        project_id: project,
        assignment_id: a.id,
        harness: run.harness,
        ...(proof.screen ? { require_disconnect: true as const } : {}),
      };
      const observed = await runtime
        .observe_prompt(ref, binding)
        .catch(() => undefined);
      const previous = receipt(s, run, claimed);
      const write = (type: string, reason: string) =>
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
            lastRunActivity(current, owner) !== lastRunActivity(run, a) ||
            this.proof(state, owner, current)?.screen !== proof.screen ||
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
      if (!observed?.ok || !observed.value) {
        // Absence of a screen-only match isn't an incident. A positively
        // attributed disconnect with persistently unverified ownership is.
        if (!proof.screen && now - lastRunActivity(run, a) >= 2 * interval)
          write(
            attention,
            "断流后无法确认客户端空闲或归属；请主机运维核对原终端并续办，不自动重启。",
          );
        continue;
      }
      if (previous) {
        if (now - Date.parse(previous.created_at) >= interval)
          write(
            attention,
            "续跑后客户端仍停在断流提示符；请主机运维接管原会话，不再自动发送。",
          );
        continue;
      }
      const unlock = await tryHostOpsLock(store, project, a.id, "launch");
      if (!unlock) continue;
      try {
        const result = await runtime
          .wake(ref, `请继续当前 ${run.id} 未完成的工作。`, {
            prompt_binding: binding,
            before_send: () =>
              write(claimed, "客户端断流，领取本轮唯一续跑提示"),
          })
          .catch(() => undefined);
        if (result?.ok && result.value.sent)
          write("client_resume_sent", "已向原会话发送续跑提示");
        else if (!result?.ok || !result.value.withdrawn)
          write(
            attention,
            "续跑提示送达不明；请主机运维核对原会话，不重复投递。",
          );
      } finally {
        await unlock();
      }
    }
  }
}
