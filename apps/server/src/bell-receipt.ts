import {
  assignmentCardHeld,
  assignmentDependenciesAllowStart,
  type Clock,
  type CommandState,
  hasRunTarget,
  idleWakeGuard,
  type ProjectId,
  type Run,
  type Runtime,
  reviewReceiptTargetCurrent,
  unreadableCommentTrigger,
  unreceivedBell,
} from "@cardigan/domain";
import {
  type MachineLeases,
  testReviewRunPrompt,
  tryHostOpsLock,
  wakeIsCurrent,
} from "@cardigan/host";
import { type Store, unfinishedBellAttempts } from "@cardigan/store";
import { alertAudience, dispatchAlert } from "./dispatch-alert.js";
import type { StandingResolver } from "./dispatch-inbox.js";
import type { StateLoader } from "./dispatch-state.js";

/** Only confirmed transport writes enter here. C-483 retains ambiguous sends. */
export async function checkBellReceipts(
  options: {
    store: Store;
    runtime: Runtime;
    leases?: MachineLeases;
    standing?: StandingResolver;
    onError?: (error: unknown) => void;
  },
  project: ProjectId,
  state: CommandState,
  load: StateLoader,
  clock: Clock,
  timeoutMs: number,
  closing: () => boolean,
) {
  const { store, runtime, leases } = options;
  const due = (run: Run) => {
    const bell = unreceivedBell(run);
    return bell?.sent_at &&
      Date.parse(clock.now()) -
        Date.parse(bell.retry_at ?? bell.idle_check_at ?? bell.sent_at) >=
        timeoutMs
      ? bell
      : undefined;
  };
  for (const original of state.runs) {
    const bell = due(original);
    const ref = bell?.runtime_ref;
    if (!ref || closing()) continue;
    const owner = state.assignments.find(
      (a) => a.id === original.assignment_id,
    );
    if (
      !owner ||
      owner.session_ref !== bell.session_ref ||
      !wakeIsCurrent(state, owner, original.id) ||
      JSON.stringify(owner.runtime_ref) !== JSON.stringify(ref)
    )
      continue;
    const unlock = await tryHostOpsLock(store, project, owner.id, "launch");
    if (!unlock) continue;
    try {
      const current = (s: CommandState, reservation?: string) => {
        const run = s.runs.find((r) => r.id === original.id);
        if (
          !run ||
          closing() ||
          !(reservation ? unreceivedBell(run) : due(run)) ||
          run.bell_delivery?.retry_at !== (reservation ?? bell.retry_at) ||
          !wakeIsCurrent(s, owner, run.id) ||
          !hasRunTarget(owner, s) ||
          !assignmentDependenciesAllowStart(s, owner) ||
          assignmentCardHeld(owner, s, run.trigger_event_id) ||
          unreadableCommentTrigger(s, run) ||
          !reviewReceiptTargetCurrent(s, owner, run) ||
          unfinishedBellAttempts(store.database, project, owner.id).length
        )
          return;
        return run;
      };
      if (!store.uow.read((tx) => current(load(tx, project)))) continue;
      const status = await runtime.status(ref).catch(() => undefined);
      const terminal = status?.ok
        ? `${status.value.process}/${status.value.agent}`
        : "unavailable";
      const guard = status?.ok && idleWakeGuard(status.value);
      if (bell.retry_at || !guard) {
        // An inspection failure is never permission to type. Escalate rather than
        // silently leaving a dispatched Run outside both watchdogs forever.
        store.uow.run((tx) => {
          const s = load(tx, project),
            run = current(s);
          if (!run?.bell_delivery) return;
          const at = clock.now();
          tx.runs.put(project, {
            ...run,
            bell_delivery: {
              ...run.bell_delivery,
              ...(bell.retry_at ? { escalated_at: at } : { idle_check_at: at }),
            },
          });
          if (!bell.retry_at && bell.idle_check_at) return; // Report once; check for a later idle transition.
          dispatchAlert(tx, store, s, at, {
            assignment: owner,
            run_id: run.id,
            card_id: bell.card_id,
            type: "bell_receipt_missing",
            reason: bell.retry_at
              ? "no_receipt_after_retry"
              : "idle_not_confirmed",
            activity_source: `${owner.machine_id}: ${terminal}`,
            audience: alertAudience(owner, s, options.standing),
          });
        });
        continue;
      }
      const scope = (s: CommandState) =>
        testReviewRunPrompt(s, owner.id, original.id);
      const review = store.uow.read((tx) => scope(load(tx, project)));
      // A running Run does not publish a new start. Its original resource
      // grant still has to pass startBlocked inside the write boundary.
      let resourceDenied = false;
      let reservedAt: string | undefined;
      const readCurrent = () =>
        store.uow.read((tx) => current(load(tx, project)));
      const preflight =
        leases &&
        (leases.configured(project, owner.machine_id) ||
          leases.hasProbeTarget(project, original))
          ? async () => {
              const run = readCurrent();
              if (!run) return false;
              if (run.status === "running") return true;
              // A failed resource inspection is not an idle-guard withdrawal.
              const allowed = await leases
                .canPublish(project, owner, run, () => clock.now())
                .catch(() => false);
              if (allowed) return true;
              // canPublish also declines when the Run started during its probe.
              // Defer that transition, rather than treating it as a revoked grant.
              resourceDenied = readCurrent()?.status === "dispatched";
              return false;
            }
          : undefined;
      const text = `[bell] ${bell.card_id ? `card=${bell.card_id}` : `project=${project}`} asg=${owner.id} run=${original.id}\n→ 请调用 get_updates 读取详情`;
      const result = await runtime.wake(
        ref,
        [text, review].filter(Boolean).join("\n"),
        {
          ...guard,
          ...(preflight ? { resource_preflight: preflight } : {}),
          before_send: () =>
            store.uow.run((tx) => {
              const s = load(tx, project),
                run = current(s);
              if (!run?.bell_delivery || scope(s) !== review) return false;
              if (
                leases?.startBlocked(
                  project,
                  owner,
                  run,
                  clock.now(),
                  undefined,
                  tx,
                )
              ) {
                resourceDenied = true;
                return false;
              }
              // Persist before IO: another dispatcher or a lost hc response cannot replay twice.
              reservedAt = clock.now();
              tx.runs.put(project, {
                ...run,
                bell_delivery: { ...run.bell_delivery, retry_at: reservedAt },
              });
              return true;
            }),
        },
      );
      if (result.ok && result.value.withdrawn && !resourceDenied) {
        // Only the adapter's positive non-write proof may refund our own
        // reservation. Never refund a transport error or an unknown response.
        if (reservedAt)
          store.uow.run((tx) => {
            const run = current(load(tx, project), reservedAt);
            if (!run?.bell_delivery) return;
            const { retry_at: _unused, ...pending } = run.bell_delivery;
            tx.runs.put(project, { ...run, bell_delivery: pending });
          });
        continue;
      }
      // The transport can fail before even reaching its send-slot callback. Do
      // not tight-loop a broken adapter or turn a late receipt into an alarm.
      if (!result.ok || !result.value.sent)
        store.uow.run((tx) => {
          const s = load(tx, project),
            run = current(s);
          if (!run?.bell_delivery) return;
          const at = clock.now();
          tx.runs.put(project, {
            ...run,
            bell_delivery: { ...run.bell_delivery, escalated_at: at },
          });
          dispatchAlert(tx, store, s, at, {
            assignment: owner,
            run_id: run.id,
            card_id: bell.card_id,
            type: "bell_receipt_missing",
            reason: result.ok
              ? "retry_withdrawn"
              : "retry_transport_unavailable",
            activity_source: `${owner.machine_id}: ${terminal}${result.ok ? "" : ` (${result.error.code})`}`,
            audience: alertAudience(owner, s, options.standing),
          });
        });
    } catch (error) {
      // A stale incremental-review scope (or one failed worker) cannot stall other assignments.
      options.onError?.(error);
    } finally {
      await unlock();
    }
  }
}
