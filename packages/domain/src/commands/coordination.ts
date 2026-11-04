import type {
  Actor,
  Author,
  Decision,
  HumanAction,
  Reference,
  TimelineEntry,
  WorkItem,
} from "../entities.js";
import type { CardId, DecisionId, HumanActionId, WorkItemId } from "../ids.js";
import { parseId, parseTimelineEntryId } from "../ids.js";
import { transition } from "../transitions.js";
import {
  type CommandDraft,
  type CommandPorts,
  type CommandState,
  command,
  ensure,
  text,
  unwrap,
} from "./core.js";

export function extractReferences(body: string): readonly Reference[] {
  const refs: Reference[] = [];
  for (const match of body.matchAll(
    /(?<![A-Za-z0-9_-])(?:C-[1-9][0-9]*(?:#[1-9][0-9]*)?|[qh]\([1-9][0-9]*\)|D-[1-9][0-9]*)(?![A-Za-z0-9_#])/gu,
  )) {
    const token = match[0];
    if (token.includes("#")) {
      const parsed = parseTimelineEntryId(token);
      if (parsed.ok) refs.push({ kind: "timeline_entry", id: parsed.value.id });
    } else if (token.startsWith("C")) {
      const p = parseId("card", token);
      if (p.ok) refs.push({ kind: "card", id: p.value.id });
    } else if (token.startsWith("D")) {
      const p = parseId("delivery", token);
      if (p.ok) refs.push({ kind: "delivery", id: p.value.id });
    } else if (token.startsWith("q")) {
      const p = parseId("decision", token);
      if (p.ok) refs.push({ kind: "decision", id: p.value.id });
    } else {
      const p = parseId("human_action", token);
      if (p.ok) refs.push({ kind: "human_action", id: p.value.id });
    }
  }
  for (const [url] of body.matchAll(
    /https?:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?\/[^\s<>()]*?(?:\/pull\/[1-9][0-9]*|\/-\/merge_requests\/[1-9][0-9]*)(?:[?#][^\s<>()]*)?/gu,
  ))
    refs.push({ kind: "pr", url: url.replace(/[.,;，。；]+$/u, "") });
  return [...new Map(refs.map((ref) => [JSON.stringify(ref), ref])).values()];
}
export function postComment(
  state: CommandState,
  actor: Actor,
  p: Pick<TimelineEntry, "card_id" | "body"> &
    Partial<
      Pick<
        TimelineEntry,
        "work_item_id" | "mentions" | "reply_to" | "refs" | "supersedes"
      >
    >,
  ports: CommandPorts,
) {
  return command(state, actor, "post_comment", ports, (d) => {
    d.card(p.card_id);
    text(p.body, "body");
    if (p.work_item_id)
      ensure(
        d.work(p.work_item_id).card_id === p.card_id,
        "validation_failed",
        "Work item belongs to another card",
      );
    for (const id of [p.reply_to, p.supersedes].filter(
      (id) => id !== undefined,
    )) {
      const entry = state.timeline.find((entry) => entry.id === id);
      ensure(entry, "not_found", "Referenced timeline entry was not found");
      ensure(
        entry.card_id === p.card_id,
        "validation_failed",
        "Reply/supersession must stay on this card",
      );
      if (id === p.supersedes)
        ensure(
          entry.author === d.author,
          "unauthorized",
          "Only the same author can supersede a comment",
        );
    }
    const refs = [
      ...new Map(
        [...(p.refs ?? []), ...extractReferences(p.body)].map((ref) => [
          JSON.stringify(ref),
          ref,
        ]),
      ).values(),
    ];
    d.emit(
      "comment_posted",
      p.card_id,
      { body: p.body },
      {
        type: "comment",
        body: p.body,
        refs,
        mentions: p.mentions ?? [],
        ...(p.work_item_id ? { work_item_id: p.work_item_id } : {}),
        ...(p.reply_to ? { reply_to: p.reply_to } : {}),
        ...(p.supersedes ? { supersedes: p.supersedes } : {}),
      },
    );
    return d.timeline[0];
  });
}
function paused(
  d: CommandDraft,
  item: WorkItem,
  kind: "blocked" | "waiting_decision",
) {
  if (item.status !== kind)
    d.put(
      "work_items",
      d.move(item, kind === "blocked" ? "block" : "request_decision"),
    );
}
function endForDecision(
  d: CommandDraft,
  summary: string,
  items: readonly WorkItem[],
) {
  const assignments = new Set(
    [d.assignment?.id, ...items.map((w) => w.assignment_id)].filter(
      (id) => id !== undefined,
    ),
  );
  for (const run of d
    .list("runs")
    .filter(
      (run) => assignments.has(run.assignment_id) && run.status === "running",
    )) {
    d.put("runs", {
      ...run,
      status: unwrap(transition("run", run.status, "complete")),
      outcome: "blocked",
      summary,
      finished_at: d.now,
    });
  }
}
const pending = (decision: Decision) =>
  decision.status === "open" || decision.status === "provisional";
function stillBlocked(d: CommandDraft, id: WorkItemId) {
  return (
    d
      .list("decisions")
      .some(
        (q) => q.blocking && pending(q) && q.affected_work_items.includes(id),
      ) ||
    d
      .list("human_actions")
      .some((h) => h.status === "open" && h.blocked_work_items.includes(id))
  );
}
export function reportBlocker(
  state: CommandState,
  actor: Actor,
  p: { work_item_id: WorkItemId; reason: string; needs: "role" | "human" },
  ports: CommandPorts,
) {
  return command(state, actor, "report_blocker", ports, (d) => {
    const item = d.ownWork(p.work_item_id);
    text(p.reason, "reason");
    ensure(
      p.needs === "role" || p.needs === "human",
      "validation_failed",
      "Unknown blocker owner",
    );
    paused(d, item, "blocked");
    d.emit(
      "blocker_reported",
      item.card_id,
      { work_item_id: item.id, needs: p.needs },
      { type: "status_change", body: p.reason, work_item_id: item.id },
    );
    return {
      work_item_id: item.id,
      guidance:
        p.needs === "human"
          ? "Use request_human_action or request_decision to request human intervention"
          : "Notify the responsible role",
    };
  });
}
export type RequestDecisionParams = Pick<
  Decision,
  | "kind"
  | "question"
  | "context"
  | "options"
  | "recommended"
  | "affected_cards"
  | "affected_work_items"
  | "blocking"
  | "decider"
> & {
  readonly card_id?: CardId;
  readonly category: NonNullable<Decision["category"]>;
  readonly target?: Extract<Decision, { kind: "approve" }>["target"];
};
export function requestDecision(
  state: CommandState,
  actor: Actor,
  p: RequestDecisionParams,
  ports: CommandPorts,
) {
  return command(state, actor, "request_decision", ports, (d) => {
    if (p.card_id) d.card(p.card_id);
    else d.projectAccess();
    text(p.question, "question");
    text(p.context, "context");
    text(p.decider, "decider");
    ensure(
      [
        "general",
        "spending",
        "account",
        "permission",
        "data_deletion",
      ].includes(p.category),
      "validation_failed",
      "Decision category is required",
    );
    ensure(
      p.decider === "human" ||
        (p.decider.startsWith("role:") &&
          state.roles.some((r) => `role:${r.role_id}` === p.decider)),
      "validation_failed",
      "Unknown decider",
    );
    ensure(
      p.category === "general" || p.decider === "human",
      "unauthorized",
      "Sensitive decisions require the human",
    );
    ensure(
      p.kind === "choose" || p.kind === "approve",
      "validation_failed",
      "Unknown decision kind",
    );
    ensure(
      p.options.length > 0 &&
        new Set(p.options.map((o) => o.key)).size === p.options.length &&
        p.options.every(
          (o) => o.key.trim() && o.description.trim() && o.impact.trim(),
        ) &&
        p.options.some((o) => o.key === p.recommended),
      "validation_failed",
      "Options and recommendation must be explicit",
    );
    if (p.kind === "approve") {
      ensure(
        p.target,
        "validation_failed",
        "Approval must bind to a delivery or subject",
      );
      if ("delivery_id" in p.target)
        d.work(d.get("deliveries", p.target.delivery_id).work_item_id);
      else {
        text(p.target.subject.value, "approval subject");
        ensure(
          ["git_head", "artifact_sha256", "doc_version"].includes(
            p.target.subject.kind,
          ),
          "validation_failed",
          "Invalid approval subject",
        );
      }
    }
    const items = [...new Set(p.affected_work_items)].map((id) => d.work(id));
    const cards = [
      ...new Set([
        ...(p.card_id ? [p.card_id] : []),
        ...p.affected_cards,
        ...items.map((w) => w.card_id),
      ]),
    ];
    for (const id of cards) d.card(id);
    if (p.blocking) {
      for (const item of items) paused(d, item, "waiting_decision");
      endForDecision(d, p.question, items);
    }
    const id = d.ids.next(state.project_id, "decision");
    const base = {
      id,
      key: id,
      ...(p.card_id ? { card_id: p.card_id } : {}),
      raised_by: d.author,
      category: p.category,
      question: p.question,
      context: p.context,
      options: p.options,
      recommended: p.recommended,
      affected_cards: cards,
      affected_work_items: items.map((w) => w.id),
      blocking: p.blocking,
      decider: p.decider,
      doc_refs: [],
      status: "open" as const,
    };
    const decision: Decision =
      p.kind === "approve"
        ? {
            ...base,
            kind: "approve",
            target: p.target as NonNullable<typeof p.target>,
          }
        : { ...base, kind: "choose" };
    d.put("decisions", decision);
    for (const card of cards.length ? cards : [undefined])
      d.emit(
        "decision_requested",
        card,
        { decision_id: id, affected_work_items: decision.affected_work_items },
        { type: "decision_request", body: p.question, decision_id: id },
      );
    return decision;
  });
}
export function recordDecision(
  state: CommandState,
  actor: Actor,
  p: {
    decision_id: DecisionId;
    option: string;
    rationale: string;
    raw_quote: string;
    via_chain?: readonly Author[];
    batch?: string;
  },
  ports: CommandPorts,
) {
  return command(state, actor, "record_decision", ports, (d) => {
    ensure(
      actor.kind === "assignment" &&
        actor.role_id === "pm" &&
        d.assignment?.scope === "standing" &&
        actor.allowed_tools.includes("record_decision"),
      "forbidden_tool",
      "Only the PM Office assignment can record decisions",
    );
    const decision = d.get("decisions", p.decision_id);
    if (decision.card_id) d.card(decision.card_id);
    else d.projectAccess();
    text(p.raw_quote, "raw_quote");
    text(p.rationale, "rationale");
    ensure(
      decision.options.some((o) => o.key === p.option),
      "validation_failed",
      "Option is not part of this decision",
    );
    const result: Decision = {
      ...decision,
      status: unwrap(transition("decision", decision.status, "resolve")),
      resolution: {
        option: p.option,
        rationale: p.rationale,
        resolved_by: decision.decider === "human" ? "human" : d.author,
        via: "pm_office_chat",
        raw_quote: p.raw_quote,
        via_chain: [...(p.via_chain ?? []), d.author],
        ...(p.batch ? { batch: p.batch } : {}),
        at: d.now,
      },
    };
    d.put("decisions", result);
    const resumed: WorkItem[] = [];
    for (const id of decision.affected_work_items) {
      const item = d.work(id);
      if (item.status === "waiting_decision" && !stillBlocked(d, id)) {
        d.put("work_items", d.move(item, "decision_resolved"));
        resumed.push(item);
      }
    }
    const cards = [
      ...new Set([
        ...(decision.card_id ? [decision.card_id] : []),
        ...decision.affected_cards,
      ]),
    ];
    for (const card of cards.length ? cards : [undefined]) {
      const unblocked = resumed.filter((w) => w.card_id === card);
      const event = d.emit(
        "decision_resolved",
        card,
        {
          decision_id: decision.id,
          option: p.option,
          resume_work_items: unblocked.map((w) => w.id),
        },
        {
          type: "decision_resolved",
          body: p.raw_quote,
          decision_id: decision.id,
        },
      );
      for (const item of unblocked) {
        if (!item.assignment_id) continue;
        const assignment = d.get("assignments", item.assignment_id);
        const runs = d
          .list("runs")
          .filter((r) => r.assignment_id === assignment.id);
        if (
          assignment.status !== "active" ||
          runs.some(
            (r) => !["completed", "failed", "cancelled"].includes(r.status),
          )
        )
          continue;
        const previous = runs
          .filter((r) => r.outcome === "blocked")
          .sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)))[0];
        if (!previous) continue;
        ensure(
          previous.role_version === assignment.role_version &&
            previous.model.trim() &&
            previous.agent_cli_version.trim(),
          "invariant_violation",
          "Resume requires the previous role/model/CLI snapshot",
        );
        d.put("runs", {
          id: d.ids.next(state.project_id, "run"),
          assignment_id: assignment.id,
          trigger_event_id: event.id,
          kind: "decision_resumed",
          status: "queued",
          role_version: previous.role_version,
          model: previous.model,
          agent_cli_version: previous.agent_cli_version,
          outcome: null,
          summary: "",
        });
      }
    }
    return result;
  });
}
export function requestHumanAction(
  state: CommandState,
  actor: Actor,
  p: Pick<
    HumanAction,
    "instructions" | "why_human" | "expected_return" | "blocked_work_items"
  > & { card_id: CardId; due?: string },
  ports: CommandPorts,
) {
  return command(state, actor, "request_human_action", ports, (d) => {
    d.card(p.card_id);
    text(p.instructions, "instructions");
    text(p.why_human, "why_human");
    text(p.expected_return, "expected_return");
    const items = [...new Set(p.blocked_work_items)].map((id) => d.work(id));
    ensure(
      items.every((w) => w.card_id === p.card_id),
      "validation_failed",
      "Human action items must belong to its card",
    );
    for (const item of items) paused(d, item, "blocked");
    const id = d.ids.next(state.project_id, "human_action");
    const action: HumanAction = {
      id,
      key: id,
      card_id: p.card_id,
      requested_by: d.author,
      instructions: p.instructions,
      why_human: p.why_human,
      expected_return: p.expected_return,
      blocked_work_items: items.map((w) => w.id),
      status: "open",
      ...(p.due ? { due: p.due } : {}),
    };
    d.put("human_actions", action);
    d.emit(
      "human_action_requested",
      p.card_id,
      { human_action_id: id, blocked_work_items: action.blocked_work_items },
      { type: "human_action", body: p.instructions, human_action_id: id },
    );
    return action;
  });
}
// Human-only application entry, not an additional MCP tool.
export function completeHumanAction(
  state: CommandState,
  actor: Actor,
  p: {
    human_action_id: HumanActionId;
    text: string;
    attachments?: readonly string[];
  },
  ports: CommandPorts,
) {
  return command(state, actor, "request_human_action", ports, (d) => {
    ensure(
      actor.kind === "human",
      "unauthorized",
      "Only the human can complete a human action",
    );
    const action = d.get("human_actions", p.human_action_id);
    text(p.text, "result");
    if (action.card_id) d.card(action.card_id);
    for (const id of p.attachments ?? [])
      ensure(
        d.get("attachments", id).card_id === action.card_id,
        "validation_failed",
        "Attachment belongs to another card",
      );
    const result: HumanAction = {
      ...action,
      status: unwrap(transition("human_action", action.status, "complete")),
      result: { text: p.text, attachments: p.attachments ?? [], at: d.now },
    };
    d.put("human_actions", result);
    for (const id of action.blocked_work_items) {
      const item = d.work(id);
      if (item.status === "blocked" && !stillBlocked(d, id))
        d.put("work_items", d.move(item, "resume"));
    }
    d.emit(
      "human_action_completed",
      action.card_id,
      {
        human_action_id: action.id,
        resume_work_items: action.blocked_work_items,
      },
      { type: "human_action", body: p.text, human_action_id: action.id },
    );
    return result;
  });
}
