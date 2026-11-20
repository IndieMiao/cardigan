import type { Actor, Event, HumanAction, TimelineEntry } from "../entities.js";
import { eventById, eventsOfType } from "../event-index.js";
import type { TimelineEntryId } from "../ids.js";
import { NEEDS_YOU_ITEM_READY } from "../readiness.js";
import { extractReferences } from "../references.js";
import { remoteExitAction } from "../remote-worker-loss.js";
import { type CommandDraft, ensure, text } from "./core.js";
import { humanOnlyAction } from "./human-action-completion.js";

export type OrdinaryHostBasis = {
  request: TimelineEntryId;
  explanation: string;
};
export type LegacyHostResult = {
  entry: TimelineEntryId;
  result_quote: string;
  verification: string;
};

function withoutReferences(value: string) {
  return value.replace(
    /https?:\/\/\S+|[a-z][a-z0-9_-]*-\d+(?:#\d+)?|[qh]\(\d+\)/giu,
    "",
  );
}

// References, numbers and formatting alone do not explain a classification or verification.
function explanation(value: string, field: string) {
  text(value, field);
  ensure(
    /\p{L}/u.test(withoutReferences(value)),
    "validation_failed",
    `${field} 须有文字说明，不能只有引用或标点`,
  );
}

/** A readback may itself be a measurement, unlike the PM's verification prose.
 * Don't extract a bare number from a citation, another version or a progress sentence. */
function matchesResultQuote(body: string, quote: string, action: HumanAction) {
  text(quote, "legacy_host_result.result_quote");
  if (!body.includes(quote)) return false;
  const content = withoutReferences(quote);
  if (/\p{L}/u.test(content)) return true;
  if (!/\p{N}/u.test(content)) return false;
  const original = body.trim();
  if (original === quote.trim()) return true;
  // Some old direct reports prefix the value with the action they answer.
  const prefix = /^(H-[1-9]\d*|h\([1-9]\d*\))\s*[:：]\s*/u.exec(original);
  return (
    !!prefix &&
    extractReferences(prefix[0]).some(
      (r) => r.kind === "human_action" && r.id === action.id,
    ) &&
    original.slice(prefix[0].length) === quote.trim()
  );
}

function matchesAuthor(actor: Actor, entry: TimelineEntry) {
  return (
    (actor.kind === "assignment"
      ? `assignment:${actor.assignment_id}`
      : actor.kind) === entry.author
  );
}

function originalRequest(
  d: CommandDraft,
  action: HumanAction,
  entry: TimelineEntry | undefined,
) {
  return (
    entry?.type === "human_action" &&
    entry.card_id === action.card_id &&
    entry.human_action_id === action.id &&
    entry.author === action.requested_by &&
    !entry.retracted &&
    entry.body === action.instructions &&
    eventsOfType(d.state.events, "human_action_requested").some((e) => {
      const p = e.payload as { human_action_id?: string; disposition?: string };
      return (
        e.card_id === entry.card_id &&
        e.actor.project_id === d.state.project_id &&
        matchesAuthor(e.actor, entry) &&
        e.seq === entry.event_seq &&
        p.human_action_id === action.id &&
        !p.disposition
      );
    })
  );
}

export function classifyOrdinaryHost(
  d: CommandDraft,
  action: HumanAction,
  basis: OrdinaryHostBasis,
) {
  explanation(basis.explanation, "ordinary_host_basis.explanation");
  ensure(
    !action.category &&
      !humanOnlyAction(d, action) &&
      !remoteExitAction(d.state, action.id),
    "unauthorized",
    "不能用普通主机事项的说明覆盖已有分类、阻塞或交人事项",
  );
  ensure(
    originalRequest(
      d,
      action,
      d.state.timeline.find((e) => e.id === basis.request),
    ),
    "unauthorized",
    "核定须引用本待办的同卡原始请求；缺少依据请交人",
  );
  const classified = { ...action, category: "general" as const };
  d.put("human_actions", classified);
  d.emit(
    "human_action_classified",
    action.card_id,
    { human_action_id: action.id, category: "general", basis },
    {
      type: "human_action",
      human_action_id: action.id,
      body: `核对为普通主机事项（${basis.request}）：${basis.explanation}`,
      refs: [{ kind: "timeline_entry", id: basis.request }],
    },
  );
  return classified;
}

function postedResult(
  d: CommandDraft,
  action: HumanAction,
  id: TimelineEntryId,
) {
  const entry = d.state.timeline.find((e) => e.id === id);
  if (
    entry?.type !== "comment" ||
    entry.card_id !== action.card_id ||
    entry.retracted ||
    !entry.body.trim() ||
    d.state.timeline.some((e) => e.supersedes === entry.id)
  )
    return;
  const event = eventsOfType(d.state.events, "comment_posted").find(
    (e) => e.card_id === entry.card_id && e.seq === entry.event_seq,
  );
  if (
    !event ||
    event.actor.project_id !== d.state.project_id ||
    event.created_at !== entry.created_at ||
    !matchesAuthor(event.actor, entry)
  )
    return;
  const payload = event.payload as {
    body: string;
    host_report_for?: string | null;
  };
  if (payload.body !== entry.body) return;
  return { entry, actor: event.actor, payload };
}

type Transfer = {
  human_action_id?: string;
  disposition?: string;
  released?: boolean;
  host_assignment_id?: string | null;
  host_operator?: string;
  host_diagnostic?: boolean;
  handoff?: object;
  ready_when?: HumanAction["ready_when"];
};

function hostTransferEntry(event: Event, entry: TimelineEntry | undefined) {
  const p = event.payload as Transfer;
  return (
    p.disposition === "host" &&
    !!p.handoff &&
    (event.actor.kind === "human" ||
      (event.actor.kind === "assignment" && event.actor.role_id === "pm")) &&
    entry?.type === "human_action" &&
    !entry.retracted &&
    entry.card_id === event.card_id &&
    entry.event_seq === event.seq &&
    entry.human_action_id === p.human_action_id &&
    matchesAuthor(event.actor, entry)
  );
}

/** Association and ownership are distinct. The reply may name an earlier formal
 * handoff of this action, but only the last disposition before posting controls its owner. */
function historicalBinding(
  d: CommandDraft,
  action: HumanAction,
  request: TimelineEntry,
  report: TimelineEntry,
) {
  const parent =
    report.reply_to && d.state.timeline.find((t) => t.id === report.reply_to);
  const named = report.refs.filter((r) => r.kind === "human_action");
  if (named.some((r) => r.id !== action.id)) return;
  let linked = named.length > 0 || report.reply_to === request.id;
  let latest: Event | undefined;
  for (const e of eventsOfType(d.state.events, "human_action_requested")) {
    const p = e.payload as Transfer;
    if (
      e.card_id !== action.card_id ||
      e.actor.project_id !== d.state.project_id ||
      e.seq <= request.event_seq ||
      e.seq >= report.event_seq ||
      p.human_action_id !== action.id ||
      !p.disposition ||
      p.released
    )
      continue; // a release changes visibility, not ownership
    if (parent && hostTransferEntry(e, parent)) linked = true;
    if (!latest || e.seq > latest.seq) latest = e;
  }
  if (!latest || !linked) return;
  const entry = d.state.timeline.find(
    (t) => t.card_id === action.card_id && t.event_seq === latest.seq,
  );
  if (!entry || !hostTransferEntry(latest, entry)) return;
  return { event: latest, transfer: latest.payload as Transfer, entry };
}

type Binding = NonNullable<ReturnType<typeof historicalBinding>>;

/** The dispatcher queues the Run against the notification that made the work
 * visible. Release/ready events identify a wake, never a change of ownership. */
function dispatchWake(wake: Event, binding: Binding, report: TimelineEntry) {
  const { event, transfer } = binding;
  if (
    wake.card_id !== event.card_id ||
    wake.actor.project_id !== event.actor.project_id ||
    wake.seq < event.seq ||
    wake.seq >= report.event_seq ||
    Date.parse(wake.created_at) < Date.parse(event.created_at)
  )
    return false;
  if (wake.id === event.id) return true;
  if (!transfer.ready_when || wake.seq <= event.seq) return false;
  const p = wake.payload as Transfer & {
    condition?: HumanAction["ready_when"];
  };
  if (p.human_action_id !== transfer.human_action_id) return false;
  if (wake.type === "human_action_requested")
    return p.disposition === "host" && p.released === true;
  // This is the system's per-item ready notice, not the other card's raw merge or delivery.
  return (
    wake.type === NEEDS_YOU_ITEM_READY &&
    wake.actor.kind === "system" &&
    !!p.condition &&
    p.condition.kind !== "manual" &&
    p.condition.kind === transfer.ready_when.kind &&
    p.condition.card_id === transfer.ready_when.card_id &&
    !(
      p.condition.kind === "card_delivery" &&
      transfer.ready_when.kind === "card_delivery" &&
      p.condition.after !== transfer.ready_when.after
    )
  );
}

function executorBinding(
  d: CommandDraft,
  actor: Actor,
  binding: Binding,
  report: TimelineEntry,
) {
  if (actor.kind !== "assignment") return;
  const a = d.state.assignments.find((a) => a.id === actor.assignment_id);
  if (a?.scope !== "standing" || a.role_id !== actor.role_id) return;
  const { transfer } = binding;
  if (
    transfer.host_assignment_id != null &&
    transfer.host_assignment_id !== a.id
  )
    return;
  if (transfer.host_operator === "external")
    return transfer.host_assignment_id === a.id &&
      a.external &&
      a.role_id === "pm" &&
      a.standing_mode === "office"
      ? {}
      : undefined;
  if (transfer.host_operator !== "host_ops" || a.external) return;
  if (transfer.host_assignment_id === a.id) {
    if (
      a.role_id === "host_ops" ||
      (a.role_id === "pm" &&
        a.standing_mode === "ops" &&
        transfer.host_diagnostic === true)
    )
      return {};
    return;
  }
  // A team name alone proves nothing. Find the personal dispatch and keep its actual wake in the audit.
  if (a.role_id !== "host_ops" || transfer.host_diagnostic) return;
  for (const run of d.state.runs) {
    if (run.assignment_id !== a.id || !run.started_at) continue;
    const wake = eventById(d.state.events, run.trigger_event_id);
    if (
      wake &&
      dispatchWake(wake, binding, report) &&
      Date.parse(run.started_at) >= Date.parse(wake.created_at) &&
      Date.parse(run.started_at) < Date.parse(report.created_at)
    )
      return { executor_run_id: run.id, executor_trigger_event_id: wake.id };
  }
}

/** The caller has verified PM Ops authority. Only the original event authenticates a historical author. */
export function verifyHostResult(
  d: CommandDraft,
  action: HumanAction,
  reason: string,
  legacy?: LegacyHostResult,
) {
  const refs = extractReferences(reason).filter(
    (r) => r.kind === "timeline_entry",
  );
  if (!legacy)
    return refs.some(({ id }) => {
      const result = postedResult(d, action, id);
      return (
        result?.entry.human_action_id === action.id &&
        result.payload.host_report_for === action.id
      );
    });
  if (!refs.some((r) => r.id === legacy.entry)) return false;
  const result = postedResult(d, action, legacy.entry);
  // Before rollout even a genuine final comment had no protocol field. After rollout ordinary comments explicitly record null.
  if (!result || Object.hasOwn(result.payload, "host_report_for")) return false;
  const { entry, actor } = result;
  const request = d.state.timeline.find((e) => originalRequest(d, action, e));
  if (!request) return false;
  const binding = historicalBinding(d, action, request, entry);
  if (!binding) return false;
  const proof = executorBinding(d, actor, binding, entry);
  if (!proof) return false;
  explanation(legacy.verification, "legacy_host_result.verification");
  if (
    !matchesResultQuote(entry.body, legacy.result_quote, action) ||
    legacy.result_quote.trim() === legacy.verification.trim()
  )
    return false;
  // This is the PM's attestation, not a new statement by the (possibly released) operator.
  d.emit(
    "legacy_host_result_verified",
    action.card_id,
    {
      human_action_id: action.id,
      request: request.id,
      handoff: binding.entry.id,
      executor: entry.author,
      ...proof,
      entry: legacy.entry,
      result_quote: legacy.result_quote,
      verification: legacy.verification,
    },
    {
      type: "human_action",
      human_action_id: action.id,
      refs: [
        { kind: "timeline_entry", id: request.id },
        { kind: "timeline_entry", id: binding.entry.id },
        { kind: "timeline_entry", id: entry.id },
      ],
      body: `核验旧回填 ${entry.id}（原请求 ${request.id}，执行交接 ${binding.entry.id}）：${legacy.result_quote}\n核验依据：${legacy.verification}`,
    },
  );
  return true;
}
