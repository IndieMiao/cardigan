import type {
  Actor,
  Author,
  CardId,
  CardView,
  CommandPorts,
  CommandState,
  Decision,
  EventId,
  Machine,
  MergeCheckView,
  ProjectId,
  Run,
  RunQueuePosition,
  TimelineEntry,
  WorkItem,
} from "@cardigan/domain";
import {
  authorView,
  autoMergeSchedule,
  builtinCardTemplates,
  cardTemplate,
  deriveCardStatus,
  deriveReviewMatrix,
  extractReferences,
  formatTimelineEntryId,
  latestCardTemplate,
  listNeedsYou,
  markCardDone,
  notices,
  parseAvatarReference,
  projectSnapshot,
  type Result,
  ROLE_TOOL_ALLOWLISTS,
  type Role,
  resolveReferences,
  roleKind,
  runAuthorView,
} from "@cardigan/domain";
import type { ProjectMergeGate } from "@cardigan/host";
import { loadCommandState } from "@cardigan/mcp-server";
import { convertLegacyRole, HARNESSES, isDefaultRoleId } from "@cardigan/roles";
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

/** Preview pure commands without persisting effects or allocating database IDs. */
export function previewPorts(now: string): CommandPorts {
  return {
    clock: { now: () => now },
    ids: {
      next: () => {
        throw new Error("Preview cannot allocate entity IDs");
      },
      nextAttachmentId: () => {
        throw new Error("Preview cannot allocate attachments");
      },
      nextEventId: () => "preview" as EventId,
      nextEventSequence: () => 1,
      nextTimelineEntryId: (_project, card) =>
        unwrap(formatTimelineEntryId(card, 1)),
    },
  };
}

export function templateHistory(state: CommandState, id: string) {
  const versions = new Map(
    [...builtinCardTemplates, ...(state.card_templates ?? [])]
      .filter((t) => t.id === id)
      .map((t) => [t.version, t]),
  );
  return [...versions.values()]
    .sort((a, b) => b.version - a.version)
    .map((template) => {
      const event = state.events.find((e) => {
        const p = e.payload;
        return (
          e.type === "card_template_changed" &&
          p &&
          typeof p === "object" &&
          "template_id" in p &&
          p.template_id === id &&
          "version" in p &&
          p.version === template.version
        );
      });
      return {
        ...template,
        summary: `${template.title} · ${template.work_items.length} 个工作项`,
        // Builtin migration snapshots have no creation event; do not invent a date.
        created_at: event?.created_at ?? null,
      };
    });
}

export function templateList(state: CommandState) {
  const templates = [...builtinCardTemplates, ...(state.card_templates ?? [])];
  return [...new Set(templates.map((t) => t.id))]
    .sort()
    .map(
      (id) =>
        latestCardTemplate(state.card_templates ?? [], id) ??
        latestCardTemplate(builtinCardTemplates, id),
    );
}

/** Members use the same avatar references and authenticated upload route as employees. */
export function webMemberView(
  member: import("@cardigan/domain").MemberView | null,
) {
  if (!member) return null;
  const avatar = parseAvatarReference(member.avatar);
  return {
    id: member.id,
    name: member.name,
    title: member.title,
    avatar:
      avatar?.kind === "library"
        ? `/avatars/v1/${avatar.id}/head-64.webp`
        : avatar?.kind === "upload"
          ? `/api/avatars/${avatar.sha256}`
          : null,
  };
}
export function webDecisionView(
  state: CommandState,
  decision: import("@cardigan/domain").Decision,
) {
  return {
    ...decision,
    ...webAuthorView(state, decision.raised_by ?? "system"),
    decider_view:
      decision.decider === "human" ? webAuthorView(state, "human") : null,
    ...(decision.resolution
      ? {
          resolution: {
            ...decision.resolution,
            ...webAuthorView(state, decision.resolution.resolved_by),
          },
        }
      : {}),
  };
}

/** Public employee profile only; opaque references and external URLs are not images. */
export function webAuthorView(state: CommandState, author: Author) {
  const view = authorView(state, author);
  const assignment = author.startsWith("assignment:")
    ? state.assignments.find((a) => a.id === author.slice(11))
    : undefined;
  const standingName =
    assignment?.scope === "standing" && assignment.role_id === "pm"
      ? assignment.standing_mode === "ops"
        ? "PM 后台（PM Ops）"
        : assignment.standing_mode === "office"
          ? "PM 前台（PM Office）"
          : undefined
      : undefined;
  const employee = state.employees?.find((e) => e.id === view.employee?.id);
  const avatar = parseAvatarReference(employee?.avatar);
  return {
    ...view,
    author_display:
      view.employee || view.member || author === "human" || author === "system"
        ? view.author_display
        : (standingName ?? `未命名的 ${assignment?.role_id ?? "未知角色"}`),
    author,
    member: webMemberView(view.member),
    employee: employee
      ? {
          id: employee.id,
          name: employee.name,
          title: employee.title,
          bio: employee.bio,
          role_id: employee.role_id,
          avatar:
            avatar?.kind === "library"
              ? `/avatars/v1/${avatar.id}/head-64.webp`
              : avatar?.kind === "upload"
                ? `/api/avatars/${avatar.sha256}`
                : null,
        }
      : null,
  };
}

function webRunAuthorView(state: CommandState, run_id: string) {
  return webAuthorView(state, runAuthorView(state, run_id).author);
}

type WebAuthorView = ReturnType<typeof webAuthorView>;
type WebCardView = Omit<CardView, "next_owners"> & {
  readonly next_owners: readonly (CardView["next_owners"][number] &
    WebAuthorView)[];
};

/** `projectSnapshot` as the human sees it: every card with derived fields. */
export function cardViews(state: CommandState): WebCardView[] {
  return unwrap(projectSnapshot(state, human(state.project_id))).data.cards.map(
    (card) => ({
      ...card,
      next_owners: card.next_owners.map((owner) => ({
        ...owner,
        ...webAuthorView(
          state,
          owner.kind === "assignment"
            ? (`assignment:${owner.ref}` as Author)
            : owner.kind === "human"
              ? "human"
              : "system",
        ),
        ...(owner.kind === "role"
          ? { author_role: owner.ref, author_display: `未命名的 ${owner.ref}` }
          : {}),
      })),
    }),
  );
}

export interface CardListView extends WebCardView {
  readonly queued_runs?: readonly RunQueuePosition[];
  readonly produce_owners: readonly WebAuthorView[];
  readonly participants: readonly WebAuthorView[];
  readonly work_items: readonly Pick<WorkItem, "id" | "title" | "status">[];
  readonly attachment_count: number;
  readonly progress: { readonly completed: number; readonly total: number };
  readonly updated_at: string;
  readonly roles: readonly string[];
}

/** Card rows plus the counts, timestamp and roles the list filters need (U2). */
export function cardListViews(
  state: CommandState,
  updatedAt?: ReadonlyMap<string, string>,
  queue: readonly RunQueuePosition[] = [],
): CardListView[] {
  const entryCard = new Map(
    state.timeline.map((entry) => [entry.id, entry.card_id]),
  );
  const attachmentCounts = new Map<string, number>();
  for (const attachment of state.attachments) {
    const cardId =
      attachment.card_id ??
      (attachment.attach_to.kind === "timeline_entry"
        ? entryCard.get(attachment.attach_to.id)
        : undefined);
    if (cardId)
      attachmentCounts.set(cardId, (attachmentCounts.get(cardId) ?? 0) + 1);
  }
  const assignments = new Map(
    state.assignments.map((assignment) => [assignment.id, assignment]),
  );
  const owners = (items: readonly WorkItem[]) => [
    ...new Map(
      items.flatMap((item) => {
        const assignment = item.assignment_id
          ? assignments.get(item.assignment_id)
          : undefined;
        return assignment && assignment.status !== "released"
          ? [
              [
                assignment.employee_id ?? assignment.id,
                webAuthorView(state, `assignment:${assignment.id}`),
              ] as const,
            ]
          : [];
      }),
    ).values(),
  ];
  return cardViews(state).map((card) => {
    const items = state.work_items.filter((item) => item.card_id === card.id),
      completed = items.filter(
        (item) => item.status === "accepted" || item.status === "passed",
      ).length,
      updated_at =
        updatedAt?.get(card.id) ??
        state.events
          .filter((event) => event.card_id === card.id)
          .map((event) => event.created_at)
          .sort()
          .at(-1) ??
        card.created_at;
    return {
      ...card,
      ...(queue.some(
        (r) => r.project_id === state.project_id && r.card_id === card.id,
      )
        ? {
            queued_runs: queue.filter(
              (r) => r.project_id === state.project_id && r.card_id === card.id,
            ),
          }
        : {}),
      produce_owners: owners(items.filter((item) => item.kind === "produce")),
      participants: owners(items),
      work_items: items.map(({ id, title, status }) => ({ id, title, status })),
      attachment_count: attachmentCounts.get(card.id) ?? 0,
      progress: { completed, total: items.length },
      updated_at,
      roles: [...new Set(items.map((item) => item.role_id))].sort(),
    };
  });
}

/** A card is "needs me" when the next actor is the human or something waits on them. */
export function needsMe(card: CardView): boolean {
  return card.next_owners.some((owner) => owner.kind === "human");
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
export interface AttachmentView extends WebAuthorView {
  readonly id: string;
  readonly original_filename?: string;
  readonly note?: string;
  readonly mime: string;
  readonly size: number;
  readonly sha256: string;
  readonly kind: "artifact" | "evidence";
  readonly attach_to: { readonly kind: string; readonly id: string };
  readonly uploaded_by: string;
  readonly uploader_role: string | null;
  readonly uploaded_at: string | null;
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
  const roles = new Map(
    state.assignments.map((a) => [String(a.id), a.role_id]),
  );
  const uploaded = new Map<string, string>();
  for (const event of state.events) {
    if (
      event.type === "attachment_uploaded" &&
      event.payload &&
      typeof event.payload === "object" &&
      "attachment_id" in event.payload &&
      typeof event.payload.attachment_id === "string"
    ) {
      uploaded.set(event.payload.attachment_id, event.created_at);
    }
  }
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
        ...(attachment.original_filename === undefined
          ? {}
          : { original_filename: attachment.original_filename }),
        ...(attachment.note === undefined ? {} : { note: attachment.note }),
        mime: attachment.mime,
        size: attachment.size,
        sha256: attachment.sha256,
        kind: attachment.kind,
        attach_to: attachment.attach_to,
        uploaded_by: attachment.uploaded_by,
        ...webAuthorView(state, attachment.uploaded_by),
        uploader_role: attachment.uploaded_by.startsWith("assignment:")
          ? (roles.get(attachment.uploaded_by.slice(11)) ?? null)
          : null,
        uploaded_at: uploaded.get(attachment.id) ?? null,
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
    readonly timelineAnchor?: string;
    readonly now?: string;
  } = {},
) {
  const card = cardViews({
    ...state,
    cards: state.cards.filter((c) => c.id === card_id),
  })[0];
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
  const allTimeline = state.timeline
    .filter((entry) => entry.card_id === card_id)
    .sort((left, right) => right.event_seq - left.event_seq);
  const anchor = options.timelineAnchor;
  const review = anchor
    ? reviews.find((r) => `review-${r.id}` === anchor)
    : undefined;
  const target = anchor
    ? allTimeline.findLastIndex(
        (entry) =>
          [
            `entry-${entry.id}`,
            entry.delivery_id && `delivery-${entry.delivery_id}`,
            entry.decision_id && `decision-${entry.decision_id}`,
            entry.human_action_id && `human-action-${entry.human_action_id}`,
          ].includes(anchor) ||
          (review !== undefined &&
            entry.type === "review" &&
            entry.run_id === review.run_id &&
            entry.work_item_id === review.work_item_id),
      )
    : -1;
  const timeline = allTimeline.slice(
    0,
    Math.max(options.timelineLimit ?? DEFAULT_TIMELINE_LIMIT, target + 1),
  );

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

  const conclusionEntries = allTimeline
    .filter(
      (entry) =>
        !entry.retracted &&
        ["review", "decision_resolved"].includes(entry.type),
    )
    .slice(0, 3);
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
      [
        description,
        ...timeline.map((e) => e.body),
        ...conclusionEntries.map((e) => e.body),
      ].join("\n"),
    ).map((ref) => [`${ref.kind}:${ref.id}`, ref]),
  );
  const references = (body: string) =>
    extractReferences(body).flatMap((ref) => {
      const value =
        ref.kind === "pr" ? undefined : resolved.get(`${ref.kind}:${ref.id}`);
      return value ? [value] : [];
    });
  const events = state.events.filter((event) => event.card_id === card_id);
  const eventBySeq = new Map(events.map((event) => [event.seq, event]));
  const roles = new Map<string, string>(
    state.assignments.map((a) => [a.id, a.role_id]),
  );
  const review_matrix = deriveReviewMatrix(deliveries, work_items, reviews);
  const updated_at =
    [...events.map((e) => e.created_at), card.created_at].sort().at(-1) ??
    card.created_at;
  const timelineView = (entry: TimelineEntry) => {
    const event = eventBySeq.get(entry.event_seq);
    const payload = event?.payload;
    const attachmentId =
      payload && typeof payload === "object" && "attachment_id" in payload
        ? payload.attachment_id
        : undefined;
    const reviewId =
      event?.payload &&
      typeof event.payload === "object" &&
      "review_id" in event.payload
        ? event.payload.review_id
        : undefined;
    const review_id =
      entry.type === "review"
        ? reviews.find(
            (r) =>
              r.id === reviewId &&
              r.delivery_id === entry.delivery_id &&
              r.work_item_id === entry.work_item_id,
          )?.id
        : undefined;
    return {
      ...entry,
      ...webAuthorView(state, entry.author),
      event_type: event?.type ?? null,
      ...([
        "merge_check_queued",
        "merge_check_started",
        "merge_check_finished",
        "merge_check_requeued",
      ].includes(event?.type ?? "")
        ? { merge_check: event?.payload as unknown as MergeCheckView }
        : {}),
      ...(entry.type === "decision_resolved" &&
      event?.payload &&
      typeof event.payload === "object" &&
      "via" in event.payload &&
      event.payload.via === "delegated"
        ? {
            decision_via: "delegated",
            decision_delegate: event.actor.kind === "system" ? "system" : "pm",
          }
        : {}),
      ...(event?.type === "attachment_uploaded" &&
      typeof attachmentId === "string" &&
      state.attachments.some(
        (a) => a.id === attachmentId && a.card_id === card_id,
      )
        ? { attachment_id: attachmentId }
        : {}),
      ...(entry.type === "decision_resolved" &&
      event?.payload &&
      typeof event.payload === "object" &&
      "option" in event.payload &&
      typeof event.payload.option === "string"
        ? { decision_option: event.payload.option }
        : {}),
      author_role: entry.author.startsWith("assignment:")
        ? (roles.get(entry.author.slice(11)) ?? null)
        : null,
      ...(review_id ? { review_id } : {}),
      references: references(entry.body),
    };
  };
  const source = card.source;
  const sourceDecision =
    source.kind === "decision"
      ? state.decisions.find((d) => d.id === source.decision_id)
      : undefined;
  const sourceCard =
    sourceDecision?.card_id !== card_id
      ? state.cards.find((c) => c.id === sourceDecision?.card_id)
      : undefined;
  const template = cardTemplate(card, state.card_templates);
  const completionPreview =
    template?.completion.mode === "human_mark_done"
      ? markCardDone(
          state,
          human(state.project_id),
          { card_id, result: "检查完成条件" },
          previewPorts(options.now ?? card.created_at),
        )
      : undefined;
  return {
    template: template ?? null,
    mark_done: completionPreview
      ? {
          allowed: completionPreview.ok,
          reason: completionPreview.ok
            ? null
            : completionPreview.error.code === "illegal_transition"
              ? "当前卡片状态不允许标记完成。"
              : completionPreview.error.message,
        }
      : null,
    updated_at,
    card: { ...card, references: references(description) },
    work_items,
    timeline: timeline.map(timelineView),
    recent_conclusions: conclusionEntries
      .map(timelineView)
      .filter(
        (entry) =>
          entry.review_id || decisions.some((d) => d.id === entry.decision_id),
      ),
    deliveries: deliveries.map((d) => ({
      ...d,
      ...webRunAuthorView(state, d.run_id),
    })),
    reviews: reviews.map((r) => ({
      ...r,
      ...webRunAuthorView(state, r.run_id),
    })),
    review_matrix,
    decisions: decisions.map((decision) => {
      const schedule = autoMergeSchedule(state, decision.id);
      return {
        ...webDecisionView(state, decision),
        auto_merge: schedule.ok
          ? { minutes: schedule.value.minutes, due_at: schedule.value.due_at }
          : null,
      };
    }),
    human_actions: human_actions.map((action) => ({
      ...action,
      ...webAuthorView(state, action.requested_by),
    })),
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
      source_card:
        sourceCard && sourceDecision
          ? {
              id: sourceCard.id,
              title: sourceCard.title,
              decision_id: sourceDecision.id,
            }
          : null,
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

/** All unread notices on the first page, then ten read notices per page. */
export function noticePage(state: CommandState, before?: string) {
  const all = notices(state);
  const anchor =
    before === undefined ? -1 : all.findIndex((n) => n.id === before);
  if (before !== undefined && anchor < 0)
    throw new InvalidQuery("知会分页游标无效，请刷新后重试");
  const unread = all.filter((n) => !n.read);
  const read = all.slice(anchor + 1).filter((n) => n.read);
  const page = read.slice(0, 10);
  const events = new Map(state.events.map((event) => [event.id, event]));
  return {
    notices: [...(before === undefined ? unread : []), ...page].map(
      (notice) => {
        const event = events.get(notice.id);
        return {
          ...notice,
          ...webAuthorView(
            state,
            event?.actor.kind === "assignment"
              ? `assignment:${event.actor.assignment_id}`
              : (event?.actor.kind ?? "system"),
          ),
        };
      },
    ),
    next_cursor: read.length > page.length ? (page.at(-1)?.id ?? null) : null,
    unread_count: unread.length,
  };
}

/** `listNeedsYou` plus the one-line reason and how long each item has waited. */
export function needsYou(
  state: CommandState,
  now: string,
  mergeGateStatus: ProjectMergeGate["status"] = "disabled",
) {
  const result = unwrap(
    listNeedsYou(state, human(state.project_id), { now: () => now }),
  );
  const data = result.data;
  const noticeList = noticePage(state);
  const checks = new Map(
    mergeGateStatus === "enabled"
      ? cardViews(state).map((card) => [card.id, card.merge_check])
      : [],
  );
  const decisionView = (decision: (typeof data.decisions)[number]) => {
    const schedule = autoMergeSchedule(state, decision.id);
    const check = decision.card_id ? checks.get(decision.card_id) : undefined;
    return {
      auto_merge: schedule.ok
        ? { minutes: schedule.value.minutes, due_at: schedule.value.due_at }
        : null,
      ...webAuthorView(
        state,
        state.decisions.find((d) => d.id === decision.id)?.raised_by ??
          "system",
      ),
      ...(decision.followup_notice
        ? {
            followup_notice: decision.followup_notice,
            resolution: decision.resolution
              ? {
                  ...decision.resolution,
                  ...webAuthorView(state, decision.resolution.resolved_by),
                }
              : undefined,
          }
        : {}),
      kind: "decision" as const,
      id: decision.id,
      card_id: decision.card_id ?? null,
      affected_cards: decision.affected_cards,
      question: decision.question,
      context: decision.context,
      why: clamp(decision.why),
      status: decision.status,
      blocking: decision.blocking,
      decider: decision.decider,
      decider_view:
        decision.decider === "human" ? webAuthorView(state, "human") : null,
      options: decision.options,
      recommended: decision.recommended,
      trigger: decision.trigger ?? null,
      category: decision.category ?? "general",
      assignment_id: decision.assignment_id ?? null,
      opened_at: decision.opened_at,
      waited_ms: decision.waited_ms,
      related_cards: decision.related_cards,
      merge_confirmation: decision.merge_confirmation
        ? {
            ...decision.merge_confirmation,
            ...(mergeGateStatus === "enabled"
              ? {
                  merge_gate_enabled: true,
                  merge_check:
                    check?.completion_id ===
                    decision.merge_confirmation.completion?.id
                      ? (check ?? null)
                      : null,
                }
              : {}),
            ...(mergeGateStatus === "invalid"
              ? { merge_gate_invalid: true }
              : {}),
            deliveries: decision.merge_confirmation.deliveries.map(
              (delivery) => ({
                ...delivery,
                ...webRunAuthorView(
                  state,
                  state.deliveries.find((d) => d.id === delivery.id)?.run_id ??
                    "",
                ),
              }),
            ),
            reviews: decision.merge_confirmation.reviews.map((review) => ({
              ...review,
              ...webRunAuthorView(
                state,
                state.reviews.find((r) => r.id === review.id)?.run_id ?? "",
              ),
            })),
          }
        : null,
    };
  };
  const decisions = data.decisions.map(decisionView);
  // §7.4 (C-65): PM-held merge confirmations the human may answer directly.
  const pm_held_merges = data.pm_held_merges.map(decisionView);
  const human_actions = data.human_actions.map((action) => {
    const opened = openedAt(
      state.timeline,
      (entry) => entry.human_action_id === action.id,
    );
    return {
      ...webAuthorView(
        state,
        state.human_actions.find((a) => a.id === action.id)?.requested_by ??
          "system",
      ),
      kind: "human_action" as const,
      id: action.id,
      card_id: action.card_id ?? null,
      instructions: action.handoff?.instructions ?? action.instructions,
      ...(action.handoff
        ? {
            handoff: action.handoff,
            original_request: {
              instructions: action.instructions,
              why_human: action.why_human,
              expected_return: action.expected_return,
            },
          }
        : {}),
      why: clamp(action.why),
      expected_return:
        action.handoff?.expected_return ?? action.expected_return,
      triage: action.triage ?? "human",
      triage_rationale: action.triage_rationale ?? null,
      blocked_work_items: action.blocked_work_items,
      ...(action.completion_notice !== undefined
        ? { completion_notice: action.completion_notice }
        : {}),
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
    attention: data.attention,
    incidents: data.incidents.map((incident) => ({
      ...incident,
      ...webAuthorView(state, `assignment:${incident.id}`),
      waited_ms:
        waitedMs(
          incident.disconnected_at ?? incident.lost_at ?? undefined,
          now,
        ) ?? null,
    })),
    // Batched, non-urgent decisions come after the blocking ones (§8.2).
    decisions: [...decisions].sort(blockingFirst),
    human_actions: [...human_actions].sort(
      (left, right) => (right.waited_ms ?? 0) - (left.waited_ms ?? 0),
    ),
    pm_held_merges: [...pm_held_merges].sort(
      (left, right) => (right.waited_ms ?? 0) - (left.waited_ms ?? 0),
    ),
    // §7.4 知会: delegated resolutions, newest first; never blocking.
    notices: noticeList.notices,
    notices_next_cursor: noticeList.next_cursor,
    counts: {
      decisions: decisions.length,
      human_actions: human_actions.length,
      notices_unread: noticeList.unread_count,
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
  const submitted = new Map<string, string>();
  for (const event of state.events) {
    const payload = event.payload;
    if (
      event.type === "delivery_submitted" &&
      payload &&
      typeof payload === "object" &&
      "delivery_id" in payload &&
      typeof payload.delivery_id === "string"
    )
      submitted.set(payload.delivery_id, event.created_at);
  }
  const recent_deliveries = [...state.deliveries]
    .sort(byId)
    .reverse()
    .slice(0, 10)
    .map((delivery) => ({
      id: delivery.id,
      work_item_id: delivery.work_item_id,
      work_item_title:
        state.work_items.find((w) => w.id === delivery.work_item_id)?.title ??
        null,
      submitted_at:
        submitted.get(delivery.id) ??
        state.timeline.find(
          (e) => e.type === "delivery" && e.delivery_id === delivery.id,
        )?.created_at ??
        null,
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
  queue: readonly RunQueuePosition[] = [],
) {
  // §8.5: the newest Run is the one created last, not the one that started
  // last. A Run that is still queued has no `started_at`, and ordering by it
  // would let the previous, finished Run hide the new one.
  const latestRun = (assignment_id: string) =>
    [...state.runs]
      .filter((run) => run.assignment_id === assignment_id)
      .sort((left, right) => (left.id === right.id ? 0 : byId(right, left)))[0];
  // §8.5: a queued Run has neither started_at nor finished_at; its queue time
  // is its activity time for the default sort. launchRun records it as a
  // run_queued event. Resumption after a decision/unblock (queueResumedRun)
  // and dispatch recovery create the queued Run in the same command that
  // emits its trigger event, without a run_queued event, so that trigger's
  // time is when the Run was queued.
  const queuedAt = new Map<string, string>();
  const eventAt = new Map<string, string>();
  for (const event of state.events) {
    eventAt.set(event.id, event.created_at);
    if (event.type !== "run_queued") continue;
    const runId = (event.payload as { readonly run_id?: unknown }).run_id;
    if (typeof runId === "string" && !queuedAt.has(runId))
      queuedAt.set(runId, event.created_at);
  }
  const withQueuedAt = (run: Run) => {
    const at = queuedAt.get(run.id) ?? eventAt.get(run.trigger_event_id);
    return at === undefined ? {} : { queued_at: at };
  };
  return {
    project_id: state.project_id,
    generated_at: now,
    machines,
    assignments: state.assignments.map((assignment) => {
      const run = latestRun(assignment.id);
      const waiting = queue.find(
        (r) => r.project_id === state.project_id && r.run_id === run?.id,
      );
      const card_id =
        state.work_items.find((w) => w.id === assignment.work_item_id)
          ?.card_id ?? null;
      return {
        card_id,
        card_status: state.cards.find((c) => c.id === card_id)?.status ?? null,
        ...(waiting ? { queue_ahead: waiting.ahead } : {}),
        standing_mode:
          assignment.scope === "standing"
            ? (assignment.standing_mode ?? null)
            : null,
        id: assignment.id,
        ...webAuthorView(state, `assignment:${assignment.id}`),
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
                ...withQueuedAt(run),
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
    runs: [...state.runs]
      .sort(byId)
      .reverse()
      .map((run) => {
        const waiting = queue.find(
          (r) => r.project_id === state.project_id && r.run_id === run.id,
        );
        return {
          ...run,
          ...withQueuedAt(run),
          ...(waiting ? { queue_ahead: waiting.ahead } : {}),
        };
      }),
  };
}

export interface ActivityQuery {
  readonly card_id?: CardId;
  readonly role?: string;
  /** Coarse speaker group: human | pm | agent | system. */
  readonly actor?: string;
  readonly type?: string;
  /** Coarse event category used by the picker. */
  readonly category?: string;
  /** Relative time window: 24h | 7d | 30d. */
  readonly range?: string;
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

const ACTOR_GROUPS: Readonly<Record<string, string>> = {
  human: "human",
  system: "system",
  pm: "pm",
  office: "pm",
  ops: "pm",
};
function actorGroup(event: { readonly actor: Actor }): string {
  const role = actorRole(event);
  return ACTOR_GROUPS[role] ?? "agent";
}

const EVENT_CATEGORIES: Readonly<Record<string, readonly string[]>> = {
  delivery: ["delivery_submitted", "delivery_accepted"],
  review: ["review_submitted"],
  decision: [
    "decision_requested",
    "decision_resolved",
    "decision_provisionally_resolved",
  ],
  comment: [
    "comment_posted",
    "comment_added",
    "instruction_issued",
    "instruction",
  ],
  run: [
    "run_queued",
    "run_dispatched",
    "run_started",
    "run_finished",
    "run_dispatch_aborted",
    "run_inactive",
    "run_inactivity_stop_requested",
    "run_inactivity_stop_started",
    "run_inactivity_stop_withdrawn",
    "run_inactivity_stop_finished",
    "inactive_stop_unconfirmed",
    "inactive_stop_confirmed",
    "session_replaced",
    "runtime_unknown",
    "runtime_lost",
    "runtime_reconnected",
    "bell_delivery_failed",
    "bell_delivery_attempt_failed",
    "bell_retry_exhausted",
  ],
  merge: [
    "card_merged",
    "merge_conflicted",
    "merge_failed",
    "worktree_cleaned",
    "worktree_cleanup_failed",
    "reconcile_finding",
  ],
};
function activityCategory(type: string): string {
  for (const [category, types] of Object.entries(EVENT_CATEGORIES))
    if (types.includes(type)) return category;
  return "other";
}

const RANGE_MS: Readonly<Record<string, number>> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

/** §8.6 项目动态: the event stream, filterable and paged newest first. */
export function activity(
  state: CommandState,
  query: ActivityQuery,
  now = new Date().toISOString(),
) {
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
  const range = query.range === undefined ? undefined : RANGE_MS[query.range];
  const since = range === undefined ? undefined : Date.parse(now) - range;
  const filtered = eligible.filter(
    (event) =>
      (query.card_id === undefined || event.card_id === query.card_id) &&
      (query.role === undefined || actorRole(event) === query.role) &&
      (query.actor === undefined || actorGroup(event) === query.actor) &&
      (query.type === undefined || event.type === query.type) &&
      (query.category === undefined ||
        activityCategory(event.type) === query.category) &&
      (since === undefined || Date.parse(event.created_at) >= since),
  );
  const page = filtered.slice(-limit).reverse();
  const oldest = page.at(-1);
  const cards = [...state.cards].sort(byId);
  const titles = new Map(cards.map((card) => [card.id, card.title]));
  return {
    project_id: state.project_id,
    cards: cards.map((card) => ({ id: card.id, title: card.title })),
    events: page.map((event) => ({
      id: event.id,
      card_id: event.card_id ?? null,
      card_title:
        event.card_id === undefined
          ? null
          : (titles.get(event.card_id) ?? null),
      seq: event.seq,
      type: event.type,
      actor: event.actor,
      ...webAuthorView(
        state,
        event.actor.kind === "assignment"
          ? `assignment:${event.actor.assignment_id}`
          : event.actor.kind,
      ),
      role: actorRole(event),
      payload: event.payload,
      created_at: event.created_at,
    })),
    counts: { returned: page.length, matched: filtered.length },
    next_before: filtered.length > page.length ? (oldest?.id ?? null) : null,
  };
}

/** Default role pack ids offered as copy sources (plan p2v-9-10 §2.1). */
const DEFAULT_ROLE_CANDIDATES = [
  "pm",
  "coder",
  "reviewer",
  "designer",
  "tester",
];
export const DEFAULT_ROLE_IDS = DEFAULT_ROLE_CANDIDATES.filter(isDefaultRoleId);

/** Fields compared between versions; status changes are reported separately. */
export const ROLE_FIELDS = [
  "display_name",
  "kind",
  "instructions",
  "core_prompt",
  "harness",
  "launch_profile_ref",
  "allowed_tools",
  "capabilities",
  "abilities",
  "worktree",
  "required_machine_tags",
] as const;

const ROLE_ACTIONS: Readonly<Record<string, string>> = {
  role_created: "创建",
  role_copied: "复制",
  role_updated: "编辑",
  role_activated: "启用",
  role_deactivated: "停用",
  role_rolled_back: "回退",
};

function latestRoles(versions: readonly Role[]): Role[] {
  const latest = new Map<string, Role>();
  for (const role of versions) {
    const seen = latest.get(role.role_id);
    if (seen === undefined || seen.version < role.version)
      latest.set(role.role_id, role);
  }
  return [...latest.values()].sort((a, b) =>
    a.role_id.localeCompare(b.role_id),
  );
}

function roleStatus(role: Role): "active" | "inactive" {
  return role.status === "inactive" ? "inactive" : "active";
}

/** V9b 角色列表: the latest version of every role, inactive ones included. */
export function roleList(project_id: ProjectId, versions: readonly Role[]) {
  return {
    project_id,
    roles: latestRoles(versions).map((role) => ({
      role_id: role.role_id,
      display_name: role.display_name,
      kind: roleKind(role),
      status: roleStatus(role),
      version: role.version,
      harness: role.harness,
      launch_profile_ref: role.launch_profile_ref,
    })),
    default_roles: DEFAULT_ROLE_IDS,
    harnesses: HARNESSES,
    allowlists: ROLE_TOOL_ALLOWLISTS,
  };
}

function changedFields(previous: Role | undefined, role: Role): string[] {
  if (previous === undefined) return [];
  return ROLE_FIELDS.filter(
    (field) =>
      JSON.stringify(previous[field] ?? null) !==
      JSON.stringify(role[field] ?? null),
  );
}

function versionsOf(versions: readonly Role[], role_id: string): Role[] {
  return versions
    .filter((role) => role.role_id === role_id)
    .sort((a, b) => a.version - b.version);
}

/** V9b 角色详情: the current definition, the one before it, and editing hints. */
export function roleDetail(versions: readonly Role[], role_id: string) {
  const own = versionsOf(versions, role_id);
  const role = own.at(-1);
  if (role === undefined) return undefined;
  const kind = roleKind(role);
  return {
    role: { ...role, kind, status: roleStatus(role) },
    previous: own.at(-2) ?? null,
    allowlist: ROLE_TOOL_ALLOWLISTS[kind],
    allowlists: ROLE_TOOL_ALLOWLISTS,
    harnesses: HARNESSES,
    // Legacy roles only carry core_prompt; V9a's converter proposes instructions.
    legacy_conversion:
      role.instructions === undefined ? convertLegacyRole(role) : null,
  };
}

/** V9b 角色历史: every version, newest first, with who saved it and when. */
export function roleHistory(
  state: CommandState,
  versions: readonly Role[],
  role_id: string,
) {
  const own = versionsOf(versions, role_id);
  if (own.length === 0) return undefined;
  const events = state.events.filter((event) => {
    if (!(event.type in ROLE_ACTIONS)) return false;
    const payload = event.payload as { role?: Partial<Role> } | null;
    return payload?.role?.role_id === role_id;
  });
  return {
    role_id,
    versions: own
      .map((role, index) => {
        const event = events.find(
          (e) =>
            (e.payload as { role?: Partial<Role> }).role?.version ===
            role.version,
        );
        const previous = own[index - 1];
        const changes = changedFields(previous, role);
        const action =
          event === undefined
            ? "登记"
            : (ROLE_ACTIONS[event.type] ?? event.type);
        return {
          version: role.version,
          role: { ...role, status: roleStatus(role) },
          action,
          summary:
            changes.length === 0
              ? action
              : `${action}：改动 ${changes.join("、")}`,
          changes,
          created_at: event?.created_at ?? null,
          actor: event?.actor.kind ?? null,
          ...(event === undefined
            ? { author_display: null }
            : webAuthorView(
                state,
                event.actor.kind === "assignment"
                  ? `assignment:${event.actor.assignment_id}`
                  : event.actor.kind,
              )),
        };
      })
      .reverse(),
  };
}
