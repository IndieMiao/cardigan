import type { Actor, Decision } from "../entities.js";
import type { Result } from "../errors.js";
import { flowAtLeast } from "../flow.js";
import type { DecisionId } from "../ids.js";
import { validAutoMergeMinutes } from "../preferences.js";
import { transition } from "../transitions.js";
import {
  attempt,
  type CommandEffect,
  type CommandPorts,
  type CommandState,
  command,
  ensure,
  unwrap,
} from "./core.js";
import { mergeRequiresHuman, riskTagAutoMergeAllowed } from "./delegation.js";
import { humanDecidedMergeQuestions } from "./human-decided-merge.js";
import { mergePlan } from "./merge.js";
import { projectPreferences } from "./preferences.js";
import { screenshotCheckBlocker } from "./screenshot-check.js";

/** Also used by Needs You: no countdown is promised for an ineligible decision. */
export function autoMergeSchedule(
  state: CommandState,
  decision_id: DecisionId,
): Result<{
  decision: Decision;
  minutes: number;
  waiting_since: string;
  due_at: string;
}> {
  return attempt(() => {
    const minutes = projectPreferences(state).auto_merge_after_minutes;
    ensure(
      minutes !== null && validAutoMergeMinutes(minutes),
      "illegal_transition",
      "超时自动合并未开启",
    );
    const decision = state.decisions.find((q) => q.id === decision_id);
    ensure(
      !state.cards.some((c) => c.id === decision?.card_id && flowAtLeast(c, 4)),
      "illegal_transition",
      "新版卡片不使用超时代批",
    );
    ensure(
      decision?.trigger === "merge_confirmation" &&
        decision.status === "open" &&
        decision.decider === "human" &&
        decision.category === "general" &&
        decision.card_id &&
        decision.kind === "approve" &&
        decision.options.some((o) => o.key === "merge") &&
        !decision.resolution,
      "illegal_transition",
      "Only an unanswered merge confirmation can be delegated",
    );
    const card = state.cards.find((c) => c.id === decision.card_id);
    ensure(!card?.hold, "illegal_transition", "卡片已暂停，请先解除暂停");
    ensure(
      card && (card.merge_policy ?? "confirm") === "confirm",
      "illegal_transition",
      "Card must require merge confirmation",
    );
    // §7.4: PM handoffs, D12 and scope changes need an explicit human answer.
    ensure(
      !mergeRequiresHuman(state, decision) &&
        !humanDecidedMergeQuestions(state, card.id).length &&
        (!card.risk_tags?.length || riskTagAutoMergeAllowed(state, decision)),
      "illegal_transition",
      "此合并须由人明确确认，不适用超时自动合并",
    );
    const screenshot = screenshotCheckBlocker(state, card);
    ensure(
      !screenshot,
      "illegal_transition",
      `${screenshot}，不适用超时自动合并`,
    );
    const opened = state.events.find(
      (e) =>
        e.type === "decision_requested" &&
        e.card_id === card.id &&
        e.payload !== null &&
        typeof e.payload === "object" &&
        "decision_id" in e.payload &&
        e.payload.decision_id === decision.id,
    );
    ensure(
      opened && Number.isFinite(Date.parse(opened.created_at)),
      "invariant_violation",
      "Merge confirmation creation time is required",
    );
    ensure(
      !state.events.some(
        (e) =>
          e.card_id === card.id &&
          e.seq > opened.seq &&
          ["decision_resolved", "decision_provisionally_resolved"].includes(
            e.type,
          ) &&
          e.payload !== null &&
          typeof e.payload === "object" &&
          "option" in e.payload &&
          ["hold", "request_changes"].includes(String(e.payload.option)) &&
          state.decisions.some(
            (q) =>
              q.id === (e.payload as { decision_id?: string }).decision_id &&
              q.trigger === "merge_confirmation",
          ),
      ),
      "illegal_transition",
      "A held or returned merge needs a fresh confirmation",
    );
    // C-69: a confirmation that waited through a sensitive flag restarts its
    // countdown at the last unmark, so the human gets a full window again.
    // Derived from events only, so a restarted server computes the same time.
    const unmarked = state.events.findLast(
      (e) =>
        e.type === "card_sensitivity_changed" &&
        e.card_id === card.id &&
        e.seq > opened.seq &&
        e.payload !== null &&
        typeof e.payload === "object" &&
        "sensitive" in e.payload &&
        e.payload.sensitive === false &&
        Number.isFinite(Date.parse(e.created_at)),
    );
    // C-154: a confirmation handed to the human later (PM paused or released,
    // delegation withdrawn...) is re-requested with a new decision_requested
    // event; the human gets a full window from that handoff, not from creation.
    const handedOver = state.events.findLast(
      (e) =>
        e.type === "decision_requested" &&
        e.seq > opened.seq &&
        e.payload !== null &&
        typeof e.payload === "object" &&
        "decision_id" in e.payload &&
        e.payload.decision_id === decision.id &&
        Number.isFinite(Date.parse(e.created_at)),
    );
    // Explicit holds cannot be bypassed by a stale/reopened entity snapshot.
    // Only the maintenance re-request (or a later valid handoff) restarts it.
    const snoozed = state.events.findLast(
      (e) =>
        e.type === "merge_confirmation_snoozed" &&
        e.card_id === card.id &&
        e.payload !== null &&
        typeof e.payload === "object" &&
        "decision_id" in e.payload &&
        e.payload.decision_id === decision.id,
    );
    ensure(
      !snoozed || snoozed.seq < (handedOver ?? opened).seq,
      "illegal_transition",
      "暂缓尚未恢复为待处理",
    );
    const waiting_since = [opened, handedOver, unmarked]
      .flatMap((e) => (e ? [e.created_at] : []))
      .reduce((latest, at) =>
        Date.parse(at) > Date.parse(latest) ? at : latest,
      );
    // Reuse the actual merge planner for accepted completion, latest confirmation,
    // project/card state and every remaining blocker; only simulate this answer.
    const resolved: Decision = {
      ...decision,
      status: "resolved",
      resolution: {
        option: "merge",
        rationale: "",
        raw_quote: "",
        resolved_by: "system",
        via: "delegated",
        via_chain: ["system"],
        at: waiting_since,
      },
    };
    unwrap(
      mergePlan(
        {
          ...state,
          decisions: state.decisions.map((q) =>
            q.id === decision.id ? resolved : q,
          ),
        },
        card.id,
      ),
    );
    return {
      decision,
      minutes,
      waiting_since,
      due_at: new Date(
        Date.parse(waiting_since) + minutes * 60_000,
      ).toISOString(),
    };
  });
}

/** Internal system command: callers cannot supply authority, elapsed time or an answer. */
export function autoConfirmMerge(
  state: CommandState,
  actor: Actor,
  p: { decision_id: DecisionId },
  ports: CommandPorts,
): Result<CommandEffect<Decision>> {
  return command(state, actor, "auto_confirm_merge", ports, (d) => {
    const { decision, minutes, waiting_since, due_at } = unwrap(
      autoMergeSchedule(state, p.decision_id),
    );
    const now = d.now;
    ensure(
      Number.isFinite(Date.parse(now)) && Date.parse(now) >= Date.parse(due_at),
      "illegal_transition",
      "Merge confirmation has not timed out",
    );
    const raw_quote = `超过 ${minutes} 分钟无人处理，按偏好设置自动确认合并`;
    const proxy_authority = JSON.stringify({
      source: "project_preferences.auto_merge_after_minutes",
      project_id: state.project_id,
      auto_merge_after_minutes: minutes,
      waiting_since,
      due_at,
    });
    const result: Decision = {
      ...decision,
      status: unwrap(transition("decision", decision.status, "resolve")),
      resolution: {
        option: "merge",
        rationale: raw_quote,
        raw_quote,
        resolved_by: "system",
        via: "delegated",
        via_chain: ["system"],
        proxy_authority,
        at: now,
      },
    };
    d.put("decisions", result);
    d.emit(
      "decision_resolved",
      decision.card_id,
      {
        decision_id: decision.id,
        option: "merge",
        status: result.status,
        via: "delegated",
        proxy_authority,
        resume_work_items: [],
      },
      {
        type: "decision_resolved",
        decision_id: decision.id,
        body: `自动合并（代批）：${raw_quote}`,
      },
    );
    return result;
  });
}
