import type { Actor, Run } from "../entities.js";
import type { HarnessActivity } from "../harness-activity.js";
import { hostOpsPending } from "../host-ops.js";
import type { RunId } from "../ids.js";
import { mcpSessionMissing } from "../mcp-session.js";
import { providerStartFailed } from "../provider-start.js";
import { c3ExitCandidate } from "../run-recovery.js";
import { hasRunTarget } from "../run-target.js";
import { reviewRunWakeDisposition } from "../shared-review-wake.js";
import {
  type CommandDraft,
  type CommandPorts,
  type CommandState,
  command,
  ensure,
} from "./core.js";

const cardOf = (d: CommandDraft, run: Run) => {
  const a = d.get("assignments", run.assignment_id);
  return a.scope === "work_item"
    ? d.get("work_items", a.work_item_id).card_id
    : undefined;
};
function clear(d: CommandDraft, run: Run, reason: string) {
  const { dispatch_stop: _stop, ...next } = run;
  d.put("runs", next);
  d.emit("run_dispatch_stop_withdrawn", cardOf(d, run), {
    run_id: run.id,
    reason,
  });
}

/** Initial eligibility is checked by the dispatcher; renewals retain the original stop target. */
export function claimDispatchStop(
  state: CommandState,
  actor: Actor,
  p: {
    run_id: RunId;
    lease_ms: number;
    provider_sample?: HarnessActivity | undefined;
    timeout_ms?: number;
    reason: NonNullable<Run["dispatch_stop"]>["reason"];
  },
  ports: CommandPorts,
) {
  return command(state, actor, "manage_dispatch_stop", ports, (d) => {
    ensure(
      Number.isSafeInteger(p.lease_ms) && p.lease_ms > 0,
      "validation_failed",
      "Invalid stop lease",
    );
    const run = d.get("runs", p.run_id),
      a = d.get("assignments", run.assignment_id),
      old = run.dispatch_stop;
    if (hostOpsPending(state.events, a.id)) return;
    const exitRecovery = (old?.reason ?? p.reason) === "runtime_exited";
    if (exitRecovery && !old?.stopping && !c3ExitCandidate(state, run)) {
      if (old) clear(d, run, "recovery_target_unavailable");
      return;
    }
    if (
      (old?.reason ?? p.reason) === "provider_unavailable" &&
      !old?.stopping &&
      !providerStartFailed(
        state,
        run,
        p.provider_sample,
        d.now,
        p.timeout_ms ?? Infinity,
      )
    ) {
      if (old) clear(d, run, "provider_evidence_changed");
      return;
    }
    if (
      (old?.reason ?? p.reason) === "mcp_unavailable" &&
      !old?.stopping &&
      !mcpSessionMissing(a)
    ) {
      if (old) clear(d, run, "mcp_evidence_changed");
      return;
    }
    if (run.inactivity_stop) return;
    // C-735: a refused start acknowledgement proves the session is alive;
    // the watchdog reports its reason instead of stopping the terminal.
    if (
      !old &&
      run.ack_refusal &&
      (p.reason === "dispatch_timeout" ||
        p.reason === "delivery_retry_exhausted")
    )
      return;
    const card = cardOf(d, run);
    const closed =
      card && ["done", "cancelled"].includes(d.get("cards", card).status);
    if (
      !old?.stopping &&
      (!hasRunTarget(a, state) ||
        reviewRunWakeDisposition(state, a, run) === "paused")
    ) {
      if (old) clear(d, run, "review_target_unavailable");
      return;
    }
    if (old && old.lease_until > d.now) return;
    if (
      old &&
      JSON.stringify(a.runtime_ref) !== JSON.stringify(old.runtime_ref)
    ) {
      clear(d, run, "runtime_changed");
      return;
    }
    if (
      !old?.stopping &&
      !exitRecovery &&
      ((!old
        ? // C-247: a startup check may also take a Run the monitor already
          // marked unknown; it still has to prove exit before cancelling.
          run.status !== "dispatched" &&
          !(
            ["server_restart", "provider_unavailable"].includes(p.reason) &&
            run.status === "unknown"
          )
        : !["dispatched", "unknown"].includes(run.status)) ||
        run.started_at ||
        a.status !== "active" ||
        closed)
    ) {
      if (old) clear(d, run, "activity_resumed");
      return;
    }
    const event = d.emit("run_dispatch_stop_requested", cardOf(d, run), {
      run_id: run.id,
      assignment_id: a.id,
      reason: old?.reason ?? p.reason,
      retry: !!old,
    });
    const next: Run = {
      ...run,
      dispatch_stop: {
        attempt_id: event.id,
        runtime_ref: old ? old.runtime_ref : a.runtime_ref,
        stopping: old?.stopping ?? false,
        reason: old?.reason ?? p.reason,
        lease_until: new Date(Date.parse(d.now) + p.lease_ms).toISOString(),
      },
    };
    d.put("runs", next);
    return next;
  });
}

/** Persist before release: all Agent Run mutations must reject this fence. */
export function startDispatchStop(
  state: CommandState,
  actor: Actor,
  p: {
    run_id: RunId;
    attempt_id: string;
    provider_sample?: HarnessActivity | undefined;
    timeout_ms?: number;
  },
  ports: CommandPorts,
) {
  return command(state, actor, "manage_dispatch_stop", ports, (d) => {
    const run = d.get("runs", p.run_id),
      a = d.get("assignments", run.assignment_id),
      stop = run.dispatch_stop;
    if (!stop || stop.attempt_id !== p.attempt_id || stop.lease_until <= d.now)
      return false;
    if (
      !stop.stopping &&
      (!hasRunTarget(a, state) ||
        reviewRunWakeDisposition(state, a, run) === "paused")
    ) {
      clear(d, run, "review_target_unavailable");
      return false;
    }
    if (JSON.stringify(a.runtime_ref) !== JSON.stringify(stop.runtime_ref)) {
      clear(d, run, "runtime_changed");
      return false;
    }
    const card = cardOf(d, run);
    const closed =
      card && ["done", "cancelled"].includes(d.get("cards", card).status);
    if (
      !stop.stopping &&
      (stop.reason === "runtime_exited"
        ? !c3ExitCandidate(state, run)
        : !["dispatched", "unknown"].includes(run.status) ||
          run.started_at ||
          a.status !== "active" ||
          closed)
    ) {
      clear(d, run, "activity_resumed");
      return false;
    }
    if (
      !stop.stopping &&
      stop.reason === "provider_unavailable" &&
      !providerStartFailed(
        state,
        run,
        p.provider_sample,
        d.now,
        p.timeout_ms ?? Infinity,
      )
    ) {
      clear(d, run, "provider_evidence_changed");
      return false;
    }
    if (
      !stop.stopping &&
      stop.reason === "mcp_unavailable" &&
      !mcpSessionMissing(a)
    ) {
      clear(d, run, "mcp_evidence_changed");
      return false;
    }
    if (!stop.stopping) {
      d.put("runs", { ...run, dispatch_stop: { ...stop, stopping: true } });
      d.emit("run_dispatch_stop_started", cardOf(d, run), {
        run_id: run.id,
        attempt_id: stop.attempt_id,
      });
    }
    return true;
  });
}

/**
 * C-247: give back a claimed, not yet started stop fence. A `server_restart`
 * stop never force-closes a terminal: when the observation before the stop
 * does not confirm exit, the fence is withdrawn and the dispatch timeout stays
 * in charge. A started fence is never withdrawn here; its exit proof decides.
 */
export function withdrawDispatchStop(
  state: CommandState,
  actor: Actor,
  p: { run_id: RunId; attempt_id: string; reason: string },
  ports: CommandPorts,
) {
  return command(state, actor, "manage_dispatch_stop", ports, (d) => {
    const run = d.get("runs", p.run_id),
      stop = run.dispatch_stop;
    if (!stop || stop.attempt_id !== p.attempt_id || stop.stopping)
      return false;
    clear(d, run, p.reason);
    return true;
  });
}
