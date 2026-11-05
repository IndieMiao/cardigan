import type {
  Actor,
  CardId,
  CardView,
  CommandState,
  Decision,
  HumanAction,
  Machine,
  ProjectId,
  TimelineEntry,
  WorkItem,
} from "@cardigan/domain";
import {
  deriveCardStatus,
  deriveReviewMatrix,
  extractReferences,
  listNeedsYou,
  projectSnapshot,
  type Result,
  resolveReferences,
} from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import type { Store } from "@cardigan/store";

/**
 * The Workbench read model (M5 plan §4 M5.1: 只读接口).
 *
 * Everything here runs as the human (`{ kind: "human" }`) inside a read
 * transaction and reuses the domain queries the MCP tools already use
 * (`projectSnapshot`, `listNeedsYou`, the same `loadCommandState` snapshot), so
 * the UI and the Agents can never disagree about a card's derived state.
 *
 * No handler writes: reading the board must not move any Agent's cursor or
 * event sequence (M5 plan §3.3).
 */

export interface ReadContext {
  readonly store: Store;
  readonly project_id: ProjectId;
  readonly url: URL;
  readonly now: () => string;
}

/** Longest one-line reason a Needs You row shows (development plan §8.2). */
export const WHY_MAX_LENGTH = 40;

/** Timeline entries returned with one card unless `limit` says otherwise. */
export const DEFAULT_TIMELINE_LIMIT = 200;
/** Events returned by one activity page. */
export const DEFAULT_ACTIVITY_LIMIT = 50;
export const MAX_ACTIVITY_LIMIT = 200;

const human = (project_id: ProjectId): Actor => ({ kind: "human", project_id });

function unwrap<T>(result: Result<T>): T {
  if (!result.ok)
    throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

export function projectState(
  store: Store,
  project_id: ProjectId,
): CommandState {
  return store.uow.read((tx) => loadCommandState(tx, project_id));
}

/** `projectSnapshot` as the human sees it: every card with derived fields. */
export function cardViews(state: CommandState): CardView[] {
  return unwrap(projectSnapshot(state, human(state.project_id))).data
    .cards as CardView[];
}

/** A card is "needs me" when the next actor is the human or something waits on them. */
export function needsMe(card: CardView): boolean {
  return (
    card.next_owners.some((owner) => owner.kind === "human") ||
    card.waiting_on.some(
      (waiting) =>
        waiting.kind === "decision" || waiting.kind === "human_action",
    )
  );
}

/** A card is "waiting on an agent" when a role or an assignment acts next. */
export function waitingOnAgent(card: CardView): boolean {
  return card.next_owners.some(
    (owner) => owner.kind === "role" || owner.kind === "assignment",
  );
}

export type CardFilter = "all" | "needs_me" | "agent";

export function parseCardFilter(value: string | null): CardFilter {
  if (value === null || value === "" || value === "all") return "all";
  if (value === "needs_me" || value === "agent") return value;
  throw new InvalidQuery(`unknown card filter ${JSON.stringify(value)}`);
}

export class InvalidQuery extends Error {}

function idNumber(id: string): number {
  const digits = /(\d+)\)?$/.exec(id)?.[1];
  return digits === undefined ? 0 : Number(digits);
}

const byId = (left: { readonly id: string }, right: { readonly id: string }) =>
  idNumber(left.id) - idNumber(right.id);

function clamp(text: string, max = WHY_MAX_LENGTH): string {
  const characters = Array.from(text);
  return characters.length <= max ? text : characters.slice(0, max).join("");
}

/** The timeline entry that opened a decision or human action, if any (`已等待`). */
function openedAt(
  timeline: readonly TimelineEntry[],
  match: (entry: TimelineEntry) => boolean,
): string | undefined {
  return timeline
    .filter(match)
    .sort((left, right) => left.event_seq - right.event_seq)[0]?.created_at;
}

function waitedMs(since: string | undefined, now: string): number | undefined {
  if (since === undefined) return undefined;
  const elapsed = Date.parse(now) - Date.parse(since);
  return Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0;
}

function affectsCard(
  decision: Decision,
  card_id: CardId,
  work_items: readonly WorkItem[],
): boolean {
  return (
    decision.card_id === card_id ||
    decision.affected_cards.includes(card_id) ||
    decision.affected_work_items.some((id) =>
      work_items.some((item) => item.card_id === card_id && item.id === id),
    )
  );
}

/** Attachment metadata as the browser gets it; the blob is a separate request. */
export interface AttachmentView {
  readonly id: string;
  readonly mime: string;
  readonly size: number;
  readonly sha256: string;
  readonly kind: "artifact" | "evidence";
  readonly attach_to: { readonly kind: string; readonly id: string };
  readonly uploaded_by: string;
  readonly basis: { readonly id: string; readonly status: string } | null;
  readonly supersedes: string | null;
  /** Known bitmap types may render inline; everything else is a download. */
  readonly inline: boolean;
  readonly download_path: string;
}

/** MIME types safe enough for `<img src>` (§3.2); SVG and HTML are not. */
export const INLINE_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);

export function attachmentViews(
  state: CommandState,
  card_id: CardId,
): AttachmentView[] {
  const decisions = new Map(state.decisions.map((q) => [q.id, q]));
  const entryCard = new Map(
    state.timeline.map((entry) => [entry.id, entry.card_id]),
  );
  return state.attachments
    .filter((attachment) => {
      if (attachment.card_id === card_id) return true;
      if (attachment.attach_to.kind === "timeline_entry") {
        return entryCard.get(attachment.attach_to.id) === card_id;
      }
      return false;
    })
    .sort(byId)
    .map((attachment) => {
      const basis =
        attachment.basis === undefined
          ? null
          : {
              id: attachment.basis,
              status: decisions.get(attachment.basis)?.status ?? "unknown",
            };
      return {
        id: attachment.id,
        mime: attachment.mime,
        size: attachment.size,
        sha256: attachment.sha256,
        kind: attachment.kind,
        attach_to: attachment.attach_to,
        uploaded_by: attachment.uploaded_by,
        basis,
        supersedes: attachment.supersedes ?? null,
        inline: INLINE_MIME_TYPES.has(attachment.mime.toLowerCase()),
        download_path: `/api/projects/${encodeURIComponent(
          state.project_id,
        )}/attachments/${encodeURIComponent(attachment.id)}`,
      };
    });
}

/** Work items, deliveries, reviews and decisions of one card (§8.4). */
export function cardDetail(
  state: CommandState,
  card_id: CardId,
  options: {
    readonly timelineLimit?: number;
    readonly now?: string;
  } = {},
) {
  const card = cardViews(state).find((view) => view.id === card_id);
  if (card === undefined) {
    return undefined;
  }
  const work_items = state.work_items
    .filter((item) => item.card_id === card_id)
    .sort(byId);
  const workItemIds = new Set(work_items.map((item) => item.id));
  const deliveries = state.deliveries
    .filter((delivery) => workItemIds.has(delivery.work_item_id))
    .sort(byId);
  const deliveryIds = new Set(deliveries.map((delivery) => delivery.id));
  const reviews = state.reviews
    .filter(
      (review) =>
        deliveryIds.has(review.delivery_id) ||
        workItemIds.has(review.work_item_id),
    )
    .sort(byId);
  const decisions = state.decisions
    .filter((decision) => affectsCard(decision, card_id, work_items))
    .sort(byId);
  const human_actions = state.human_actions
    .filter(
      (action) =>
        action.card_id === card_id ||
        action.blocked_work_items.some((id) => workItemIds.has(id)),
    )
    .sort(byId);
  const timeline = state.timeline
    .filter((entry) => entry.card_id === card_id)
    .sort((left, right) => right.event_seq - left.event_seq)
    .slice(0, options.timelineLimit ?? DEFAULT_TIMELINE_LIMIT);

  const related = state.cards
    .filter((other) => card.related_cards.includes(other.id))
    .map((other) => ({
      id: other.id,
      title: other.title,
      status: deriveCardStatus(
        other.status,
        state.work_items.filter((item) => item.card_id === other.id),
        state.deliveries.find(
          (delivery) =>
            delivery.kind === "card_completion" &&
            state.work_items.some(
              (item) =>
                item.card_id === other.id && item.id === delivery.work_item_id,
            ),
        ),
      ),
    }));

  const description = [
    card.title,
    card.goal,
    ...card.acceptance_criteria,
    ...card.out_of_scope,
  ].join("\n");
  // Resolve the snapshot once per response, then select each body's references.
  const resolved = new Map(
    resolveReferences(
      state,
      [description, ...timeline.map((e) => e.body)].join("\n"),
    ).map((ref) => [`${ref.kind}:${ref.id}`, ref]),
  );
  const references = (body: string) =>
    extractReferences(body).flatMap((ref) => {
      const value =
        ref.kind === "pr" ? undefined : resolved.get(`${ref.kind}:${ref.id}`);
      return value ? [value] : [];
    });
  return {
    card: { ...card, references: references(description) },
    work_items,
    timeline: timeline.map((entry) => ({
      ...entry,
      references: references(entry.body),
    })),
    deliveries,
    reviews,
    review_matrix: deriveReviewMatrix(deliveries, work_items, reviews),
    decisions,
    human_actions,
    attachments: attachmentViews(state, card_id),
    // §8.4 关联区: decisions, related cards and the deliveries that carry a PR.
    relations: {
      decisions: decisions.map((decision) => ({
        id: decision.id,
        question: clamp(decision.question),
        status: decision.status,
        blocking: decision.blocking,
        decider: decision.decider,
      })),
      cards: related,
      pull_requests: deliveries
        .filter((delivery) => delivery.pr_url !== undefined)
        .map((delivery) => ({
          delivery_id: delivery.id,
          work_item_id: delivery.work_item_id,
          status: delivery.status,
          pr_url: delivery.pr_url,
        })),
    },
    counts: {
      timeline: state.timeline.filter((entry) => entry.card_id === card_id)
        .length,
      deliveries: deliveries.length,
      reviews: reviews.length,
      open_decisions: decisions.filter(
        (decision) =>
          decision.status === "open" || decision.status === "provisional",
      ).length,
    },
    now: options.now ?? new Date().toISOString(),
  };
}

/** `listNeedsYou` plus the one-line reason and how long each item has waited. */
export function needsYou(state: CommandState, now: string) {
  const result = unwrap(listNeedsYou(state, human(state.project_id)));
  const data = result.data as {
    readonly decisions: readonly (Decision & { readonly why: string })[];
    readonly human_actions: readonly (HumanAction & { readonly why: string })[];
  };
  const decisions = data.decisions.map((decision) => {
    const opened = openedAt(
      state.timeline,
      (entry) => entry.decision_id === decision.id,
    );
    return {
      kind: "decision" as const,
      id: decision.id,
      card_id: decision.card_id ?? null,
      affected_cards: decision.affected_cards,
      question: decision.question,
      why: clamp(decision.why),
      status: decision.status,
      blocking: decision.blocking,
      decider: decision.decider,
      options: decision.options,
      recommended: decision.recommended,
      trigger: decision.trigger ?? null,
      category: decision.category ?? "general",
      assignment_id: decision.assignment_id ?? null,
      opened_at: opened ?? null,
      waited_ms: waitedMs(opened, now) ?? null,
    };
  });
  const human_actions = data.human_actions.map((action) => {
    const opened = openedAt(
      state.timeline,
      (entry) => entry.human_action_id === action.id,
    );
    return {
      kind: "human_action" as const,
      id: action.id,
      card_id: action.card_id ?? null,
      instructions: action.instructions,
      why: clamp(action.why),
      expected_return: action.expected_return,
      blocked_work_items: action.blocked_work_items,
      due: action.due ?? null,
      opened_at: opened ?? null,
      waited_ms: waitedMs(opened, now) ?? null,
    };
  });
  // §8.2: blocking items first, then the longest wait.
  const blockingFirst = <
    T extends {
      readonly blocking?: boolean;
      readonly waited_ms: number | null;
    },
  >(
    left: T,
    right: T,
  ) => {
    if (Boolean(left.blocking) !== Boolean(right.blocking)) {
      return left.blocking === true ? -1 : 1;
    }
    return (right.waited_ms ?? 0) - (left.waited_ms ?? 0);
  };
  return {
    incidents: state.assignments
      .filter(
        (a) =>
          a.status === "active" &&
          ["unknown", "lost"].includes(a.runtime_state),
      )
      .map((a) => ({
        id: a.id,
        role_id: a.role_id,
        runtime_state: a.runtime_state,
        waited_ms:
          waitedMs(
            state.events.findLast(
              (e) =>
                ["runtime_lost", "runtime_disconnected"].includes(e.type) &&
                typeof e.payload === "object" &&
                e.payload !== null &&
                "assignment_id" in e.payload &&
                e.payload.assignment_id === a.id,
            )?.created_at,
            now,
          ) ?? null,
        card_id:
          state.work_items.find((w) => w.id === a.work_item_id)?.card_id ??
          null,
      })),
    // Batched, non-urgent decisions come after the blocking ones (§8.2).
    decisions: [...decisions].sort(blockingFirst),
    human_actions: [...human_actions].sort(
      (left, right) => (right.waited_ms ?? 0) - (left.waited_ms ?? 0),
    ),
    counts: {
      decisions: decisions.length,
      human_actions: human_actions.length,
    },
  };
}

/** §8.3 项目快照: what is in flight, what is blocked, who acts next. */
export function projectSnapshotView(state: CommandState, now: string) {
  const cards = cardViews(state);
  const byStatus: Record<string, number> = {};
  for (const card of cards) {
    byStatus[card.status] = (byStatus[card.status] ?? 0) + 1;
  }
  const workItemWaiting = cards.flatMap((card) =>
    card.waiting_on
      .filter(
        (waiting) => waiting.kind === "blocked" || waiting.kind === "review",
      )
      .map((waiting) => ({
        card_id: card.id,
        work_item_id: waiting.ref,
        kind: waiting.kind,
        label: waiting.label,
        why: card.why,
      })),
  );
  const recent_deliveries = [...state.deliveries]
    .sort(byId)
    .reverse()
    .slice(0, 10)
    .map((delivery) => ({
      id: delivery.id,
      work_item_id: delivery.work_item_id,
      card_id:
        state.work_items.find((item) => item.id === delivery.work_item_id)
          ?.card_id ?? null,
      kind: delivery.kind,
      status: delivery.status,
      summary: delivery.summary,
    }));
  return {
    project_id: state.project_id,
    generated_at: now,
    cards,
    by_status: byStatus,
    in_progress: cards.filter((card) => card.status === "in_progress"),
    in_review: cards.filter(
      (card) => card.status === "review" || card.status === "awaiting_merge",
    ),
    blocked: workItemWaiting,
    recent_deliveries,
    waiting: {
      human: cards.filter(needsMe).map((card) => card.id),
      agent: cards.filter(waitingOnAgent).map((card) => card.id),
    },
  };
}

/** §8.5 执行视图: assignments with their newest Run, worktree, machine, cursor. */
export function executionView(
  state: CommandState,
  now: string,
  machines: readonly Machine[] = [],
) {
  const latestRun = (assignment_id: string) =>
    [...state.runs]
      .filter((run) => run.assignment_id === assignment_id)
      .sort((left, right) =>
        (right.started_at ?? "").localeCompare(left.started_at ?? ""),
      )[0];
  return {
    project_id: state.project_id,
    generated_at: now,
    machines,
    assignments: state.assignments.map((assignment) => {
      const run = latestRun(assignment.id);
      const card_id =
        state.work_items.find((w) => w.id === assignment.work_item_id)
          ?.card_id ?? null;
      return {
        card_id,
        card_status: state.cards.find((c) => c.id === card_id)?.status ?? null,
        standing_mode:
          assignment.scope === "standing"
            ? (assignment.standing_mode ?? null)
            : null,
        id: assignment.id,
        scope: assignment.scope,
        work_item_id: assignment.work_item_id ?? null,
        role_id: assignment.role_id,
        role_version: assignment.role_version,
        status: assignment.status,
        runtime_state: assignment.runtime_state,
        machine_id: assignment.machine_id,
        runtime_ref: assignment.runtime_ref ?? null,
        worktree_path: assignment.worktree_path ?? null,
        branch: assignment.branch ?? null,
        base_sha: assignment.base_sha ?? null,
        session_ref: assignment.session_ref ?? null,
        created_at: assignment.created_at,
        last_mcp_activity_at: assignment.last_mcp_activity_at ?? null,
        run:
          run === undefined
            ? null
            : {
                id: run.id,
                status: run.status,
                kind: run.kind,
                started_at: run.started_at ?? null,
                finished_at: run.finished_at ?? null,
                heartbeat_at: run.heartbeat_at ?? null,
                heartbeat_note: run.heartbeat_note ?? null,
                outcome: run.outcome,
              },
        cursors: state.cursors
          .filter((cursor) => cursor.assignment_id === assignment.id)
          .map((cursor) => ({
            card_id: cursor.card_id,
            acked_seq: cursor.acked_seq,
          })),
      };
    }),
    runs: [...state.runs].sort(byId).reverse(),
  };
}

export interface ActivityQuery {
  readonly card_id?: CardId;
  readonly role?: string;
  readonly type?: string;
  /** Return events strictly older than this event id (paging back). */
  readonly before?: string;
  readonly limit?: number;
}

/** The actor's role, or `human`/`system`; what the 项目动态 filter shows. */
function actorRole(event: { readonly actor: Actor }): string {
  return event.actor.kind === "assignment"
    ? event.actor.role_id
    : event.actor.kind;
}

/** §8.6 项目动态: the event stream, filterable and paged newest first. */
export function activity(state: CommandState, query: ActivityQuery) {
  const limit = Math.min(
    Math.max(1, query.limit ?? DEFAULT_ACTIVITY_LIMIT),
    MAX_ACTIVITY_LIMIT,
  );
  const ordered = [...state.events].sort((left, right) => {
    const at = left.created_at.localeCompare(right.created_at);
    return at === 0 ? left.id.localeCompare(right.id) : at;
  });
  const beforeIndex =
    query.before === undefined
      ? ordered.length
      : ordered.findIndex((event) => event.id === query.before);
  const eligible = ordered.slice(
    0,
    beforeIndex === -1 ? ordered.length : beforeIndex,
  );
  const filtered = eligible.filter(
    (event) =>
      (query.card_id === undefined || event.card_id === query.card_id) &&
      (query.role === undefined || actorRole(event) === query.role) &&
      (query.type === undefined || event.type === query.type),
  );
  const page = filtered.slice(-limit).reverse();
  const oldest = page.at(-1);
  return {
    project_id: state.project_id,
    events: page.map((event) => ({
      id: event.id,
      card_id: event.card_id ?? null,
      seq: event.seq,
      type: event.type,
      actor: event.actor,
      role: actorRole(event),
      payload: event.payload,
      created_at: event.created_at,
    })),
    counts: { returned: page.length, matched: filtered.length },
    next_before: filtered.length > page.length ? (oldest?.id ?? null) : null,
  };
}
