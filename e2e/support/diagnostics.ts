import { existsSync } from "node:fs";
import type { CommandState, Notification } from "@cardigan/domain";
import type { E2eHarness } from "./harness.js";

export function interruptionSnapshot(
  state: CommandState,
  notifications: readonly Notification[],
) {
  const summarize = (value: unknown) => {
    const text = JSON.stringify(value);
    return text.length <= 2000 ? text : `${text.slice(0, 2000)}…`;
  };
  const events = new Map(state.events.map((e) => [e.id, e]));
  const describe = (n: Notification) => {
    const e = events.get(n.event_id);
    return {
      id: n.id,
      recipient: n.recipient,
      status: n.status,
      attempts: n.attempts,
      event_id: n.event_id,
      event_type: e?.type ?? "missing",
      payload_summary: summarize(e?.payload ?? null),
      event_at: e?.created_at ?? null,
      created_at: n.created_at,
      updated_at: n.updated_at,
      run_id: n.run_id ?? null,
      seq: n.seq,
    };
  };
  return {
    observed_at: new Date().toISOString(),
    human_decisions: state.decisions.filter((d) => d.decider === "human"),
    human_actions: state.human_actions,
    decision_events: state.events
      .filter((e) => e.type.startsWith("decision_"))
      .map((e) => ({
        event_id: e.id,
        type: e.type,
        at: e.created_at,
        payload_summary: summarize(e.payload),
      })),
    human_notifications: notifications
      .filter((n) => ["pm_office", "needs_you"].includes(n.recipient.kind))
      .map(describe),
    delivery_failures: notifications
      .filter((n) => ["delivery_failed", "needs_attention"].includes(n.status))
      .map(describe),
    lifecycle_events: state.events
      .filter((e) =>
        /^(bell_|runtime_|run_dispatch_aborted|session_replaced)/.test(e.type),
      )
      .map((e) => ({
        event_id: e.id,
        type: e.type,
        at: e.created_at,
        payload_summary: summarize(e.payload),
      })),
    assignments: state.assignments.map((a) => ({
      id: a.id,
      role_id: a.role_id,
      status: a.status,
      runtime_state: a.runtime_state,
      runtime_ref: a.runtime_ref,
      last_mcp_activity_at: a.last_mcp_activity_at,
    })),
    runs: state.runs,
  };
}

/** Preserve assertion-time observations, then take fresh diagnostics without changing business state. */
export async function printInterruptionFailure(
  h: E2eHarness,
  observed: Record<string, unknown>,
) {
  try {
    const currentNeedsYou = await h
      .api("GET", `/api/projects/${h.store.listProjects()[0]?.id}/needs-you`)
      .catch((error: unknown) => ({ read_error: String(error) }));
    const state = h.state();
    console.error(
      "[appendix-a interruption diagnostics]\n" +
        JSON.stringify(
          {
            assertion_observations: observed,
            current_needs_you: currentNeedsYou,
            current: interruptionSnapshot(
              state,
              h.store.listNotifications({ project_id: state.project_id }),
            ),
            core: {
              session: h.core.session,
              pid: h.core.pid,
              socket_exists: existsSync(h.core.socket),
            },
            agent_log_tail: h.agentLog().split("\n").slice(-80),
          },
          null,
          2,
        ),
    );
  } catch (error) {
    console.error(
      "[appendix-a interruption diagnostics failed]",
      String(error),
      JSON.stringify(observed),
    );
  }
}
