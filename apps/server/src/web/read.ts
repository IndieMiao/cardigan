import { createHash } from "node:crypto";
import type {
  Actor,
  Attachment,
  Author,
  CardId,
  CardView,
  CommandState,
  ContextObservation,
  Decision,
  Event,
  Machine,
  MergeCheckBlocker,
  MergeCheckView,
  ProjectId,
  Run,
  RunQueuePosition,
  TimelineEntry,
  WorkItem,
} from "@cardigan/domain";
import {
  attachmentReferenceIds,
  authorView,
  autoMergeSchedule,
  builtinCardTemplates,
  builtinCardTemplatesForFlow,
  type CardDependencyState,
  cardDependencyView,
  cardTemplate,
  contextObservationCurrent,
  contextUsageLevel,
  currentMergeConfirmations,
  decisionActionView,
  deriveCardStatus,
  deriveReviewMatrix,
  effectivePreMergeChecks,
  eventById,
  extractReferences,
  hasVerifiedMergeNoop,
  humanMergeBlockers,
  INDEPENDENT_REVIEW_DELEGATION_MAX,
  latestCardTemplate,
  listNeedsYou,
  listNeedsYouCounts,
  markCardDone,
  mergeStage,
  type NeedsYouSection,
  notices,
  parseAvatarReference,
  projectPreferences,
  projectSnapshot,
  type Result,
  ROLE_TOOL_ALLOWLISTS,
  type Role,
  remoteExitAction,
  requiresUiStateAndSave,
  resolvePendingAttachmentRefs,
  resolveReferences,
  roleKind,
  runAuthorView,
  screenshotCheckEnforced,
  sessionMaintenanceView,
  sourceMergeSuggestionView,
  storyDiscussionRounds,
  storyProgress,
  suggestionView,
  verificationActivity,
  workerAgentToolsAction,
  workerHelperAction,
} from "@cardigan/domain";
import { type ProjectMergeGate, previewPorts } from "@cardigan/host";
import {
  loadCommandState,
  type RecordReadTiming,
  timeRead,
} from "@cardigan/mcp-server";
import {
  convertLegacyRole,
  HARNESSES,
  isDefaultRoleId,
  type LaunchConfig,
} from "@cardigan/roles";
import type { Store } from "@cardigan/store";
import { DEFAULT_HOST_OPS_PATROL_INTERVAL_MS } from "../host-ops-patrol.js";
import { runQueuedAt } from "../run-queued-at.js";
import { autoMergePauseView } from "./auto-merge-pause.js";
import {
  type CardChecking,
  cardCheckingIndex,
  currentCardMergeCheck,
} from "./card-checking.js";
import { cardDependencyGraph } from "./card-dependencies.js";
import { PAGE_LIMITS } from "./pagination.js";
import {
  assignmentPresence,
  precheckIndex,
  type RunPresence,
  strongestPresence,
} from "./run-presence.js";

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
export const DEFAULT_TIMELINE_LIMIT = PAGE_LIMITS.timeline.default;
/** Events returned by one activity page. */
export const DEFAULT_ACTIVITY_LIMIT = PAGE_LIMITS.activity.default;
export const MAX_ACTIVITY_LIMIT = PAGE_LIMITS.activity.max;

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

export function templateHistory(state: CommandState, id: string) {
  const versions = new Map(
    [
      ...builtinCardTemplates,
      ...builtinCardTemplatesForFlow(
        state.project_preferences?.find((p) => p.id === state.project_id)
          ?.flow_version,
      ),
      ...(state.card_templates ?? []),
    ]
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
  const templates = [
    ...(state.card_templates ?? []),
    ...builtinCardTemplatesForFlow(
      state.project_preferences?.find((p) => p.id === state.project_id)
        ?.flow_version,
    ),
  ];
  return [...new Set(templates.map((t) => t.id))].sort().flatMap((id) => {
    const t = latestCardTemplate(templates, id);
    return t
      ? [
          {
            ...t,
            ...(requiresUiStateAndSave(t)
              ? { requires_state_and_save: true }
              : {}),
          },
        ]
      : [];
  });
}

/** Members use the same avatar references and authenticated upload route as employees. */
export function webMemberView(
  member: import("@cardigan/domain").MemberView | null,
) {
  if (!member) return null;
  return {
    id: member.id,
    name: member.name,
    title: member.title,
    avatar: webAvatarPath(member.avatar),
  };
}

/** Same-origin image path for a stored avatar reference; opaque values are none. */
export function webAvatarPath(reference: string | null | undefined) {
  const avatar = parseAvatarReference(reference);
  return avatar?.kind === "library"
    ? `/avatars/v1/${avatar.id}/head-64.webp`
    : avatar?.kind === "upload"
      ? `/api/avatars/${avatar.sha256}`
      : null;
}
export function webDecisionView(
  state: CommandState,
  decision: import("@cardigan/domain").Decision,
) {
  const suggestion = suggestionView(state, decision);
  const { source_unrelated_suggestion: _source, ...base } = decision;
  return {
    ...base,
    ...(decision.source_unrelated_suggestion
      ? {
          source_unrelated_suggestion: sourceMergeSuggestionView(
            state,
            decision,
          ),
        }
      : {}),
    ...(suggestion ? { suggestion } : {}),
    affected_card_views: affectedCardViews(state, decision.affected_cards),
    ...webAuthorView(state, decision.raised_by ?? "system"),
    attachments: decisionAttachmentViews(state, decision),
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

/** Current card summaries for explicit decision impact, from the same snapshot. */
function affectedCardViews(state: CommandState, ids: readonly CardId[]) {
  return [...new Set(ids)].flatMap((id) => {
    const card = state.cards.find((c) => c.id === id);
    if (!card) return [];
    const items = state.work_items.filter((w) => w.card_id === id);
    const itemIds = new Set(items.map((w) => w.id));
    const completion = state.deliveries
      .filter(
        (d) =>
          itemIds.has(d.work_item_id) &&
          d.kind === "card_completion" &&
          d.status !== "superseded",
      )
      .sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)))[0];
    return [
      {
        id: card.id,
        title: card.title,
        status: deriveCardStatus(card.status, items, completion),
      },
    ];
  });
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
          role_id: assignment?.role_id ?? employee.role_id,
          avatar: webAvatarPath(employee.avatar),
        }
      : null,
  };
}

function webRunAuthorView(state: CommandState, run_id: string) {
  return webAuthorView(state, runAuthorView(state, run_id).author);
}

type WebAuthorView = ReturnType<typeof webAuthorView>;
type WebCardView = Omit<CardView, "next_owners"> & {
  readonly checking?: CardChecking;
  readonly next_owners: readonly (CardView["next_owners"][number] &
    WebAuthorView)[];
};

/** `projectSnapshot` as the human sees it: every card with derived fields. */
export function cardViews(
  state: CommandState,
  dependencyState: CardDependencyState = state,
  mergeState?: CommandState,
  precheckEvents?: readonly Event[],
): WebCardView[] {
  const checkingOf = cardCheckingIndex(state, mergeState, precheckEvents);
  return unwrap(projectSnapshot(state, human(state.project_id))).data.cards.map(
    (card) => {
      const stage = mergeState
        ? mergeStage(mergeState, card)
        : card.merge_stage;
      const { merge_stage: _stage, ...fields } = card;
      const checking = checkingOf(card);
      return {
        ...fields,
        ...(stage ? { merge_stage: stage } : {}),
        ...(checking ? { checking } : {}),
        ...(card.depends_on_cards?.length ||
        dependencyState.cards.some((c) => c.depends_on_cards?.includes(card.id))
          ? { dependency: cardDependencyView(dependencyState, card) }
          : {}),
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
            ? {
                author_role: owner.ref,
                author_display: `未命名的 ${owner.ref}`,
              }
            : {}),
        })),
      };
    },
  );
}

export interface CardListView extends WebCardView {
  readonly template_info: {
    readonly id: string;
    readonly title: string;
    readonly version: number;
    readonly builtin: boolean;
  } | null;
  readonly queued_runs?: readonly RunQueuePosition[];
  readonly produce_owners: readonly WebAuthorView[];
  readonly participants: readonly (WebAuthorView & {
    readonly run_presence: RunPresence;
  })[];
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
  dependencyState?: CardDependencyState,
  mergeState?: CommandState,
  /** C-567: other cards' precheck events that this page's waits point to. */
  precheckEvents?: readonly Event[],
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
  const live = (items: readonly WorkItem[]) =>
    items.flatMap((item) => {
      const assignment = item.assignment_id
        ? assignments.get(item.assignment_id)
        : undefined;
      return assignment && assignment.status !== "released" ? [assignment] : [];
    });
  const owners = (items: readonly WorkItem[]) => [
    ...new Map(
      live(items).map(
        (assignment) =>
          [
            assignment.employee_id ?? assignment.id,
            webAuthorView(state, `assignment:${assignment.id}`),
          ] as const,
      ),
    ).values(),
  ];
  const cardPrechecks = precheckIndex(state);
  // C-531: the same people as `owners`, each with what they are doing for
  // this card, merged over all of their assignments on it.
  const participants = (cardId: string, items: readonly WorkItem[]) => {
    const people = new Map<
      string,
      { view: WebAuthorView; presences: RunPresence[] }
    >();
    for (const assignment of live(items)) {
      const key = assignment.employee_id ?? assignment.id;
      const person = people.get(key) ?? {
        view: webAuthorView(state, `assignment:${assignment.id}`),
        presences: [],
      };
      person.presences.push(
        assignmentPresence(state, assignment, cardPrechecks(cardId)),
      );
      people.set(key, person);
    }
    return [...people.values()].map(({ view, presences }) => ({
      ...view,
      run_presence: strongestPresence(presences),
    }));
  };
  return cardViews(state, dependencyState, mergeState, precheckEvents).map(
    (card) => {
      const template = cardTemplate(card, state.card_templates);
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
        // Resolve the card's bound version from this snapshot, never the latest.
        template_info: template
          ? {
              id: template.id,
              title: template.title,
              version: template.version,
              builtin: template.builtin,
            }
          : null,
        ...(queue.some(
          (r) => r.project_id === state.project_id && r.card_id === card.id,
        )
          ? {
              queued_runs: queue.filter(
                (r) =>
                  r.project_id === state.project_id && r.card_id === card.id,
              ),
            }
          : {}),
        produce_owners: owners(items.filter((item) => item.kind === "produce")),
        participants: participants(card.id, items),
        work_items: items.map(({ id, title, status }) => ({
          id,
          title,
          status,
        })),
        attachment_count: attachmentCounts.get(card.id) ?? 0,
        progress: { completed, total: items.length },
        updated_at,
        roles: [...new Set(items.map((item) => item.role_id))].sort(),
      };
    },
  );
}

/** A card is "needs me" when the next actor is the human or something waits on them. */
export function needsMe(card: CardView): boolean {
  return !card.hold && card.next_owners.some((owner) => owner.kind === "human");
}

/** A card is "waiting on an agent" when a role or an assignment acts next. */
export function waitingOnAgent(card: CardView): boolean {
  return (
    !card.hold &&
    card.next_owners.some(
      (owner) => owner.kind === "role" || owner.kind === "assignment",
    )
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
  /** C-540: small WebP preview for inline bitmaps; null for everything else. */
  readonly thumbnail_path: string | null;
  /** C-614: lightbox image for inline bitmaps (may come from OSS); null otherwise. */
  readonly preview_path: string | null;
}

/** MIME types safe enough for `<img src>` (§3.2); SVG and HTML are not. */
export const INLINE_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);

function attachmentViewMapper(state: CommandState) {
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
  return (attachment: Attachment): AttachmentView => {
    const basis =
      attachment.basis === undefined
        ? null
        : {
            id: attachment.basis,
            status: decisions.get(attachment.basis)?.status ?? "unknown",
          };
    const download_path = `/api/projects/${encodeURIComponent(
      state.project_id,
    )}/attachments/${encodeURIComponent(attachment.id)}`;
    const inline =
      !attachment.streamed_artifact &&
      INLINE_MIME_TYPES.has(attachment.mime.toLowerCase());
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
      inline,
      // §6 C-95: the same authenticated download route serves decision previews.
      download_path,
      thumbnail_path: inline ? `${download_path}/thumbnail` : null,
      preview_path: inline ? `${download_path}/preview` : null,
    };
  };
}

export function attachmentViews(
  state: CommandState,
  card_id: CardId,
  attachmentEntryCards?: ReadonlyMap<string, CardId>,
): AttachmentView[] {
  const entryCard = new Map([
    ...(attachmentEntryCards ?? []),
    ...state.timeline.map((entry) => [entry.id, entry.card_id] as const),
  ]);
  return state.attachments
    .filter((attachment) => {
      if (attachment.streamed_artifact?.expired) return false;
      if (attachment.card_id === card_id) return true;
      if (attachment.attach_to.kind === "timeline_entry") {
        return entryCard.get(attachment.attach_to.id) === card_id;
      }
      return false;
    })
    .sort(byId)
    .map(attachmentViewMapper(state));
}

/** Attachments a decision references, in the order the requester chose (§6). */
export function decisionAttachmentViews(
  state: CommandState,
  decision: Pick<Decision, "attachment_ids"> | undefined,
): AttachmentView[] {
  const ids = decision?.attachment_ids ?? [];
  if (!ids.length) return [];
  const view = attachmentViewMapper(state);
  return ids.flatMap((id) => {
    const attachment = state.attachments.find((a) => a.id === id);
    return attachment ? [view(attachment)] : [];
  });
}

/**
 * C-615: other cards' attachments the card's bodies mention, so the browser
 * can show them as chips. The current card's own attachments are already in
 * `attachments`. An attachment of a sensitive card, or any other card while
 * the project turned cross-card reading off, is left out like a missing one:
 * the body keeps the number as text.
 */
export function referencedAttachmentViews(
  state: CommandState,
  card_id: CardId,
  text: string,
  attachmentEntryCards?: ReadonlyMap<string, CardId>,
): (AttachmentView & { readonly card_id: string })[] {
  const ids = attachmentReferenceIds(text);
  if (!ids.length || projectPreferences(state).cross_card_read === false)
    return [];
  const entryCard = new Map([
    ...(attachmentEntryCards ?? []),
    ...state.timeline.map((entry) => [entry.id, entry.card_id] as const),
  ]);
  const owner = (attachment: Attachment): CardId | undefined => {
    if (attachment.card_id) return attachment.card_id;
    const target = attachment.attach_to;
    if (target.kind === "timeline_entry") return entryCard.get(target.id);
    const delivery = state.deliveries.find((d) => d.id === target.id);
    return state.work_items.find((w) => w.id === delivery?.work_item_id)
      ?.card_id;
  };
  const view = attachmentViewMapper(state);
  return ids.flatMap((id) => {
    const attachment = state.attachments.find((a) => a.id === id);
    if (!attachment || attachment.streamed_artifact?.expired) return [];
    const card = owner(attachment);
    if (!card || card === card_id) return [];
    const other = state.cards.find((c) => c.id === card);
    if (!other || other.sensitive) return [];
    return [{ ...view(attachment), card_id: card }];
  });
}

const SELECTION_EVENTS = new Set([
  "work_item_assigned",
  "machine_selected",
  "system_assignment_deferred",
]);
/**
 * MC-5: the newest placement outcome of a work item. An assignment without a
 * machine_selected audit is not proof of an explicit choice (assignments before
 * MC-3 auto-selected without one), so it is reported as a plain "assigned".
 * Only audit fields already on the card stream are returned.
 */
export function machineSelection(
  events: CommandState["events"],
  work_item_id: string,
) {
  let latest: CommandState["events"][number] | undefined;
  for (const event of events) {
    if (!SELECTION_EVENTS.has(event.type)) continue;
    const payload = event.payload as { work_item_id?: unknown } | null;
    if (payload?.work_item_id !== work_item_id) continue;
    if (!latest || event.seq > latest.seq) latest = event;
  }
  if (!latest) return undefined;
  const p = latest.payload as Record<string, unknown>;
  const text = (value: unknown) =>
    typeof value === "string" ? value : undefined;
  const list = (value: unknown) => (Array.isArray(value) ? value : []);
  if (latest.type === "system_assignment_deferred")
    return {
      status: "deferred" as const,
      at: latest.created_at,
      reason: text(p.reason) ?? "",
    };
  return {
    status:
      latest.type === "machine_selected"
        ? ("selected" as const)
        : ("assigned" as const),
    at: latest.created_at,
    machine_id: text(p.machine_id) ?? "",
    ...(text(p.assignment_id) ? { assignment_id: text(p.assignment_id) } : {}),
    ...(latest.type === "machine_selected"
      ? {
          candidates: list(p.candidates).map((c: Record<string, unknown>) => ({
            machine_id: text(c.machine_id) ?? "",
            affinity: c.affinity === true,
            control_host: c.control_host === true,
            limit: typeof c.limit === "number" ? c.limit : null,
            occupied: typeof c.occupied === "number" ? c.occupied : null,
            ...(typeof c.pending_assignments === "number"
              ? { pending_assignments: c.pending_assignments }
              : {}),
            remaining_ratio:
              typeof c.remaining_ratio === "number" ? c.remaining_ratio : null,
            preference_rank:
              typeof c.preference_rank === "number" ? c.preference_rank : null,
            // MC-4 snapshot at selection time; never substituted by live capacity.
            resources: list(c.resources).flatMap(
              (r: Record<string, unknown>) =>
                typeof r?.key === "string" &&
                typeof r.limit === "number" &&
                typeof r.occupied === "number"
                  ? [{ key: r.key, limit: r.limit, occupied: r.occupied }]
                  : [],
            ),
          })),
          excluded: list(p.excluded).map((m: Record<string, unknown>) => ({
            machine_id: text(m.machine_id) ?? "",
            reasons: list(m.reasons).filter(
              (r): r is string => typeof r === "string",
            ),
          })),
        }
      : {}),
  };
}

/** Work items, deliveries, reviews and decisions of one card (§8.4). */
export function cardDetail(
  state: CommandState,
  card_id: CardId,
  options: {
    readonly mergeGateStatus?: ProjectMergeGate["status"];
    readonly storyProgress?: ReturnType<typeof storyProgress>;
    readonly timelineLimit?: number;
    readonly timelineAnchor?: string;
    readonly recordTiming?: RecordReadTiming;
    readonly overviewOnly?: boolean;
    readonly timelineEntries?: readonly TimelineEntry[];
    readonly timelineTotal?: number;
    readonly conclusionEntries?: readonly TimelineEntry[];
    readonly timelineNextCursor?: string | null;
    readonly updatedAt?: string;
    readonly attachmentEntryCards?: ReadonlyMap<string, CardId>;
    readonly now?: string;
    readonly dependencyState?: CardDependencyState | undefined;
    readonly mergeState?: CommandState | undefined;
    /** C-567: other cards' precheck events that this card's waits point to. */
    readonly precheckEvents?: readonly Event[];
  } = {},
) {
  if (options.dependencyState) {
    // Completion/merge previews need the same prerequisite evidence as the
    // dependency panel, including cards outside the timeline/list page.
    state = {
      ...state,
      ...options.dependencyState,
      events: [
        ...new Map(
          [...state.events, ...options.dependencyState.events].map((e) => [
            e.id,
            e,
          ]),
        ).values(),
      ],
    };
  }
  const card = cardViews(
    {
      ...state,
      cards: state.cards.filter((c) => c.id === card_id),
    },
    options.dependencyState ?? state,
    options.mergeState,
    options.precheckEvents,
  )[0];
  if (card === undefined) {
    return undefined;
  }
  const dependencySource = options.dependencyState ?? state,
    graphSource = dependencySource.cards.find((c) => c.id === card_id);
  const cardPrechecks = precheckIndex(state);
  // Precheck display time comes from the last trusted event, not the paged timeline.
  const precheckTimes = new Map<string, { seq: number; at: string }>();
  for (const event of state.events) {
    if (
      event.card_id !== card_id ||
      event.actor.kind !== "system" ||
      !["precheck_queued", "precheck_started", "precheck_finished"].includes(
        event.type,
      )
    )
      continue;
    const payload = event.payload as { attempt_id?: unknown } | null;
    if (typeof payload?.attempt_id !== "string") continue;
    if ((precheckTimes.get(payload.attempt_id)?.seq ?? -1) < event.seq)
      precheckTimes.set(payload.attempt_id, {
        seq: event.seq,
        at: event.created_at,
      });
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
  const timeline =
    options.timelineEntries ??
    allTimeline.slice(
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

  const conclusionEntries =
    options.conclusionEntries ??
    allTimeline
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
  // C-136: deliveries and reviews carry no timestamp; read it off the event
  // that created them so the records tab can show when each was submitted.
  const submittedTimes = new Map<string, string>();
  for (const event of events) {
    const payload = event.payload as {
      delivery_id?: unknown;
      review_id?: unknown;
    } | null;
    const key =
      event.type === "delivery_submitted"
        ? `delivery:${String(payload?.delivery_id)}`
        : event.type === "review_submitted"
          ? `review:${String(payload?.review_id)}`
          : undefined;
    if (key && !submittedTimes.has(key))
      submittedTimes.set(key, event.created_at);
  }
  const submittedAt = (key: string) => {
    const at = submittedTimes.get(key);
    return at ? { submitted_at: at } : {};
  };
  const roles = new Map<string, string>(
    state.assignments.map((a) => [a.id, a.role_id]),
  );
  const review_matrix = timeRead(options.recordTiming, "review_matrix", () =>
    deriveReviewMatrix(deliveries, work_items, reviews),
  );
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
    // C-615: a comment's `attachment-new-N` reads as the number it got.
    const body = resolvePendingAttachmentRefs(
      entry.body,
      entry,
      state.attachments,
    );
    return {
      ...entry,
      body,
      ...webAuthorView(state, entry.author),
      event_type: event?.type ?? null,
      ...(event?.type === "merge_check_blocked"
        ? { merge_check_blocker: event.payload as unknown as MergeCheckBlocker }
        : {}),
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
      references: references(body),
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
    has_pm_ops: state.assignments.some(
      (assignment) =>
        assignment.scope === "standing" &&
        assignment.role_id === "pm" &&
        assignment.standing_mode === "ops" &&
        assignment.status === "active",
    ),
    merge_confirmations: currentMergeConfirmations(state, card_id).map((q) =>
      decisionActionWebView(
        state,
        decisionActionView(state, q, options.now),
        options.mergeGateStatus ?? "disabled",
      ),
    ),
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
    updated_at: options.updatedAt ?? updated_at,
    ...(options.timelineNextCursor !== undefined
      ? { timeline_next_cursor: options.timelineNextCursor }
      : {}),
    card: {
      ...card,
      ...(graphSource?.story
        ? {
            story: {
              ...graphSource.story,
              discussion_rounds: storyDiscussionRounds(graphSource.story),
            },
            story_progress:
              options.storyProgress ??
              storyProgress(dependencySource.cards, graphSource),
          }
        : {}),
      ...(card.dependency && graphSource
        ? {
            dependency: {
              ...card.dependency,
              graph: timeRead(options.recordTiming, "dependency_graph", () =>
                cardDependencyGraph(dependencySource, graphSource),
              ),
            },
          }
        : {}),
      prechecks: card.prechecks?.map((check) => ({
        ...check,
        updated_at: precheckTimes.get(check.attempt_id)?.at,
      })),
      references: references(description),
    },
    work_items: work_items.map((item) => {
      const selection = options.overviewOnly
        ? undefined
        : machineSelection(state.events, item.id);
      // C-531: the work item's own owner and what they do for this item only.
      const assignment = item.assignment_id
        ? state.assignments.find((a) => a.id === item.assignment_id)
        : undefined;
      return {
        ...item,
        verification_activity: verificationActivity(item, state),
        ...(selection ? { machine_selection: selection } : {}),
        ...(assignment && assignment.status !== "released"
          ? {
              assignee: webAuthorView(state, `assignment:${assignment.id}`),
              run_presence: assignmentPresence(
                state,
                assignment,
                cardPrechecks(card_id),
              ),
            }
          : {}),
      };
    }),
    timeline: timeRead(options.recordTiming, "timeline_view", () =>
      timeline.map(timelineView),
    ),
    recent_conclusions: conclusionEntries
      .map(timelineView)
      .filter(
        (entry) =>
          entry.review_id || decisions.some((d) => d.id === entry.decision_id),
      ),
    deliveries: deliveries.map((d) => ({
      ...d,
      ...(d.system_completion
        ? webAuthorView(state, "system")
        : webRunAuthorView(state, d.run_id)),
      ...submittedAt(`delivery:${d.id}`),
    })),
    reviews: reviews.map((r) => ({
      ...r,
      ...webRunAuthorView(state, r.run_id),
      ...submittedAt(`review:${r.id}`),
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
    attachments: timeRead(options.recordTiming, "attachment_views", () =>
      attachmentViews(state, card_id, options.attachmentEntryCards),
    ),
    referenced_attachments: referencedAttachmentViews(
      state,
      card_id,
      [description, ...timeline.map((e) => e.body)].join("\n"),
      options.attachmentEntryCards,
    ),
    // §8.4 关联区: decisions, related cards and the deliveries that carry a PR.
    relations: {
      decisions: decisions.map((decision) => ({
        id: decision.id,
        question: clamp(decision.question),
        status: decision.status,
        ...(decision.snooze ? { snooze: decision.snooze } : {}),
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
      timeline:
        options.timelineTotal ??
        state.timeline.filter((entry) => entry.card_id === card_id).length,
      deliveries: deliveries.length,
      reviews: reviews.length,
      open_decisions: decisions.filter((decision) =>
        ["open", "provisional", "snoozed"].includes(decision.status),
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
  return {
    notices: [...(before === undefined ? unread : []), ...page].map(
      (notice) => {
        const event = eventById(state.events, notice.id);
        return {
          ...notice,
          source: noticeSource(notice, event),
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

function noticeSource(
  notice: ReturnType<typeof notices>[number],
  event: Event | undefined,
) {
  if (notice.kind === "external_message") return "external_message" as const;
  if (notice.resolved_by !== "system") return "pm" as const;
  let authority: unknown;
  try {
    authority = JSON.parse(notice.proxy_authority ?? "null");
  } catch {
    authority = null;
  }
  const source =
    authority && typeof authority === "object" && "source" in authority
      ? authority.source
      : undefined;
  const payload = event?.payload;
  const via =
    payload && typeof payload === "object" && "via" in payload
      ? payload.via
      : undefined;
  if (notice.kind === "merge" && via === "system_rule")
    return source === "project_preferences.auto_merge"
      ? ("auto_merge" as const)
      : ("system_merge" as const);
  if (
    notice.kind === "merge" &&
    via === "delegated" &&
    source === "project_preferences.auto_merge_after_minutes"
  )
    return "timed_merge" as const;
  return "system" as const;
}

function preMergeChecksView(state: CommandState, cardId: string | undefined) {
  const card = state.cards.find((c) => c.id === cardId);
  if (!card) return [];
  return effectivePreMergeChecks(
    card,
    state.work_items,
    state.deliveries,
    screenshotCheckEnforced(state),
  ).map((check) => ({
    label: check.label,
    status: check.status,
    stale: check.stale,
    note: check.note ?? null,
    updated_at: check.updated_at,
  }));
}

function decisionActionWebView(
  state: CommandState,
  decision: ReturnType<typeof decisionActionView>,
  mergeGateStatus: ProjectMergeGate["status"],
) {
  const original = state.decisions.find((q) => q.id === decision.id);
  const schedule = autoMergeSchedule(state, decision.id);
  // Only merge confirmations consume this field. Read the same current
  // completion/check as cardView, without constructing a full project snapshot.
  const check =
    decision.merge_confirmation &&
    decision.card_id &&
    mergeGateStatus === "enabled"
      ? currentCardMergeCheck(state, decision.card_id)
      : undefined;
  return {
    auto_merge: schedule.ok
      ? {
          minutes: schedule.value.minutes,
          due_at: schedule.value.due_at,
          // C-154: the countdown may restart at a handoff or unmark, so the
          // page counts down from the due time, not from opened_at.
          ...(decision.opened_at !== null && decision.waited_ms !== null
            ? {
                remaining_ms: Math.max(
                  0,
                  Date.parse(schedule.value.due_at) -
                    Date.parse(decision.opened_at) -
                    decision.waited_ms,
                ),
              }
            : {}),
        }
      : null,
    handed_over_from_pm: decision.handed_over_from_pm,
    ...webAuthorView(
      state,
      state.decisions.find((d) => d.id === decision.id)?.raised_by ?? "system",
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
    card_priority:
      state.cards.find((card) => card.id === decision.card_id)?.priority ?? 0,
    attachments: decisionAttachmentViews(state, decision),
    ...(decision.grouped_decisions
      ? {
          grouped_decisions: decision.grouped_decisions.map((q) => ({
            ...webDecisionView(state, q),
            ...(q.kind === "approve"
              ? { approval_target: JSON.stringify(q.target) }
              : {}),
          })),
        }
      : {}),
    affected_cards: decision.affected_cards,
    affected_card_views: affectedCardViews(state, decision.affected_cards),
    question: decision.question,
    context: decision.context,
    ...(decision.human_required_reason
      ? { human_required_reason: decision.human_required_reason }
      : {}),
    ...(decision.delegation_authority
      ? { delegation_authority: decision.delegation_authority }
      : {}),
    why: clamp(decision.why),
    status: decision.status,
    ...(decision.snooze ? { snooze: decision.snooze } : {}),
    blocking: decision.blocking,
    decider: decision.decider,
    decider_view:
      decision.decider === "human" ? webAuthorView(state, "human") : null,
    options: decision.options,
    recommended: decision.recommended,
    ...(decision.suggestion ? { suggestion: decision.suggestion } : {}),
    ...(decision.source_unrelated_suggestion
      ? { source_unrelated_suggestion: decision.source_unrelated_suggestion }
      : {}),
    ...(decision.plain_summary
      ? { plain_summary: decision.plain_summary }
      : {}),
    trigger: decision.trigger ?? null,
    ...(decision.trigger === "review_limit" &&
    original?.affected_work_items.some((id) =>
      state.work_items.some(
        (item) =>
          item.id === id &&
          item.kind === "verify" &&
          item.role_id === "independent_reviewer",
      ),
    )
      ? {
          independent_review_limit: {
            max_delegated_raises: INDEPENDENT_REVIEW_DELEGATION_MAX,
          },
        }
      : {}),
    category: decision.category ?? "general",
    assignment_id: decision.assignment_id ?? null,
    opened_at: decision.opened_at,
    waited_ms: decision.waited_ms,
    related_cards: decision.related_cards,
    merge_confirmation: decision.merge_confirmation
      ? {
          ...decision.merge_confirmation,
          blockers: original
            ? humanMergeBlockers(
                {
                  ...state,
                  project_settings: {
                    ...state.project_settings,
                    merge_gate_enabled: mergeGateStatus !== "disabled",
                  },
                },
                original,
              )
            : ["完成申请：当前不可合并"],
          // C-264: confirmation checks; a conclusion on an older version reads
          // as pending (`stale`) until PM Office records one for this version.
          pre_merge_checks: preMergeChecksView(state, decision.card_id),
          ...(mergeGateStatus === "enabled"
            ? {
                merge_gate_enabled: true,
                merge_noop:
                  !!decision.card_id &&
                  !!decision.merge_confirmation.completion &&
                  hasVerifiedMergeNoop(
                    state.events,
                    decision.card_id,
                    decision.merge_confirmation.completion.id,
                  ),
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
}

/**
 * C-153: who looks after a lost or unknown runtime, so Needs You can tell the
 * human whether to wait and when to ask for help instead of only listing
 * operator commands.
 */
function incidentHandling(state: CommandState, patrolIntervalMs: number) {
  const standing = state.assignments.filter(
    (a) => a.scope === "standing" && a.status === "active",
  );
  // The router resolves @employee only to work-item Assignments on the card,
  // so a standing PM Office is reachable by its Assignment id alone (V-504).
  const contact = (assignment: (typeof standing)[number] | undefined) => {
    if (!assignment) return null;
    const view = webAuthorView(state, `assignment:${assignment.id}`);
    return {
      assignment_id: assignment.id,
      name: view.employee?.name ?? null,
      mention: assignment.id,
    };
  };
  const hostOps = contact(standing.find((a) => a.role_id === "host_ops"));
  return {
    host_ops: hostOps
      ? { ...hostOps, patrol_interval_ms: patrolIntervalMs }
      : null,
    pm_office: contact(
      standing.find((a) => a.role_id === "pm" && a.standing_mode === "office"),
    ),
  };
}

/** `listNeedsYou` plus the one-line reason and how long each item has waited. */
export function needsYou(
  state: CommandState,
  now: string,
  mergeGateStatus: ProjectMergeGate["status"] = "disabled",
  hostOpsPatrolIntervalMs = DEFAULT_HOST_OPS_PATROL_INTERVAL_MS,
  hcSession?: string,
  runtimeUnknownGraceMs?: number,
  section?: NeedsYouSection,
  currentUpgradeCommand?: (
    project: string,
    machine: Machine,
    binding: string,
  ) => string | undefined,
  /** C-599: the command the current binding and release would stage now. */
  currentToolsCommand?: (
    project: string,
    machine: Machine,
  ) => string | undefined,
) {
  const result = unwrap(
    listNeedsYou(
      {
        ...state,
        project_settings: {
          ...state.project_settings,
          merge_gate_enabled: mergeGateStatus !== "disabled",
        },
      },
      human(state.project_id),
      { now: () => now },
      {
        ...(runtimeUnknownGraceMs === undefined
          ? {}
          : { runtimeUnknownGraceMs }),
        ...(section ? { section } : {}),
      },
    ),
  );
  const data = result.data;
  const noticeList =
    !section || section === "notices"
      ? noticePage(state)
      : { notices: [], next_cursor: null, unread_count: 0 };
  const decisionView = (decision: ReturnType<typeof decisionActionView>) =>
    decisionActionWebView(state, decision, mergeGateStatus);
  const decisions = data.decisions.map(decisionView);
  // §7.4 (C-65): PM-held merge confirmations the human may answer directly.
  const pm_held_merges = data.pm_held_merges.map(decisionView);
  const human_actions = data.human_actions.map((action) => {
    const opened = openedAt(
      state.timeline,
      (entry) => entry.human_action_id === action.id,
    );
    const stored = state.human_actions.find((a) => a.id === action.id);
    const helper = workerHelperAction(state, action);
    const tools = !helper && workerAgentToolsAction(state, action);
    const machine =
      helper && state.machines?.find((m) => m.id === helper.machine_id);
    const toolsMachine =
      tools && state.machines?.find((m) => m.id === tools.machine_id);
    // Administrator upgrade commands are never replaced by a handoff and are
    // shown only while they equal what the current binding and release give.
    const terminal = tools
      ? toolsMachine &&
        action.status === "open" &&
        action.terminal &&
        currentToolsCommand?.(state.project_id, toolsMachine) ===
          action.terminal.command
        ? action.terminal
        : undefined
      : !helper
        ? (action.handoff?.terminal ?? action.terminal)
        : machine &&
            action.status === "open" &&
            action.helper_upgrade?.binding &&
            action.terminal &&
            currentUpgradeCommand?.(
              state.project_id,
              machine,
              action.helper_upgrade.binding,
            ) === action.terminal.command
          ? action.terminal
          : undefined;
    return {
      ...webAuthorView(state, stored?.requested_by ?? "system"),
      kind: "human_action" as const,
      id: action.id,
      card_id: action.card_id ?? null,
      instructions:
        (helper || tools) && action.terminal && !terminal
          ? "当前升级命令不可用，请主机运维重新核对目标和发行材料。"
          : (action.handoff?.instructions ?? action.instructions),
      terminal,
      ...(remoteExitAction(state, action.id)
        ? {
            requires_loss_conclusion: true,
            ...(stored?.status === "open" &&
            stored.result?.conclusion === "unconfirmed"
              ? {
                  last_loss_observation: {
                    conclusion: stored.result.conclusion,
                    at: stored.result.at,
                  },
                }
              : {}),
          }
        : {}),
      helper_checks: action.helper_checks,
      ...(action.handoff
        ? {
            handoff: helper
              ? { ...action.handoff, terminal: undefined }
              : action.handoff,
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
      ...(action.triage === "host"
        ? { host_operator: action.host_operator ?? "host_ops" }
        : {}),
      triage_rationale: action.triage_rationale ?? null,
      blocked_work_items: action.blocked_work_items,
      ...(action.completion_notice !== undefined
        ? { completion_notice: action.completion_notice }
        : {}),
      // C-179: the newest "pre-merge check passed" reminder for this action.
      ...(action.pre_merge_check_reminder
        ? {
            pre_merge_check_reminder: {
              label: action.pre_merge_check_reminder.label,
              text: action.pre_merge_check_reminder.text,
              at: action.pre_merge_check_reminder.at,
            },
          }
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
    auto_merge_pause: autoMergePauseView(state),
    attention: data.attention,
    system_rule_attention: data.system_rule_attention,
    ...(data.provider_incidents.length
      ? { provider_incidents: data.provider_incidents }
      : {}),
    incident_handling: {
      ...incidentHandling(state, hostOpsPatrolIntervalMs),
      // C-153: the session the server registered in runtime.json; null when
      // this read model was built without a running server (tests, previews).
      hc_session: hcSession ?? null,
    },
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
    // C-503: current proposals waiting for the human's one-click confirmation.
    story_proposals: data.story_proposals.map((proposal) => ({
      ...proposal,
      waited_ms: waitedMs(proposal.submitted_at, now) ?? null,
    })),
    waiting_merge_checks_count: data.waiting_merge_checks_count,
    waiting_merge_check_items: data.waiting_merge_check_items,
    // C-212: deferred items; the page shows them folded under "稍后".
    later: data.later,
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

export function needsYouCounts(
  state: CommandState,
  now: string,
  mergeGateStatus: ProjectMergeGate["status"] = "disabled",
  runtimeUnknownGraceMs?: number,
) {
  return unwrap(
    listNeedsYouCounts(
      {
        ...state,
        project_settings: {
          ...state.project_settings,
          merge_gate_enabled: mergeGateStatus !== "disabled",
        },
      },
      human(state.project_id),
      { now: () => now },
      runtimeUnknownGraceMs === undefined ? {} : { runtimeUnknownGraceMs },
    ),
  ).data;
}

/** §8.3 项目快照: what is in flight, what is blocked, who acts next. */
export function projectSnapshotView(state: CommandState, now: string) {
  const cards = cardViews(state);
  const byStatus: Record<string, number> = {};
  for (const card of cards.filter((c) => !c.hold)) {
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
    held: cards.filter((card) => card.hold),
    in_progress: cards.filter(
      (card) => !card.hold && card.status === "in_progress",
    ),
    in_review: cards.filter(
      (card) =>
        !card.hold &&
        (card.status === "review" || card.status === "awaiting_merge"),
    ),
    blocked: workItemWaiting,
    recent_deliveries,
    waiting: {
      human: cards.filter(needsMe).map((card) => card.id),
      agent: cards.filter(waitingOnAgent).map((card) => card.id),
    },
  };
}

/** C-232: the host patrol's latest fresh context sample per Assignment. */
export type ExecutionContexts = ReadonlyMap<string, ContextObservation>;

/**
 * C-232: a short hash of what the execution view would show from the samples,
 * for the SSE `context` frame. Only fields the view uses take part, so a
 * re-poll of an unchanged sample does not refresh the page.
 */
export function contextUsageRevision(contexts: ExecutionContexts | undefined) {
  const entries = [...(contexts ?? [])]
    .map(([assignment, usage]) => [
      assignment,
      usage.session_id,
      usage.runtime_key,
      usage.context_tokens,
      usage.context_window_size,
      usage.updated_at,
    ])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  return createHash("sha256")
    .update(JSON.stringify(entries))
    .digest("hex")
    .slice(0, 16);
}

/**
 * C-232: the Workbench shape of a context sample. Only the numbers leave the
 * server; session id, cwd and transcript path stay in host diagnostics. The
 * level is the host's own rule with this project's thresholds, so the page
 * and the patrol agree at the rounding edges.
 */
function contextUsageView(
  state: CommandState,
  assignment: CommandState["assignments"][number],
  contexts: ExecutionContexts | undefined,
) {
  const usage = contexts?.get(assignment.id);
  if (!usage || !contextObservationCurrent(assignment, usage, state.events))
    return undefined;
  return {
    used_ratio: usage.context_tokens / usage.context_window_size,
    window_tokens: usage.context_window_size,
    used_tokens: usage.context_tokens,
    level: contextUsageLevel(usage, projectPreferences(state)) ?? null,
    updated_at: usage.updated_at,
  };
}

/** §8.5 执行视图: assignments with their newest Run, worktree, machine, cursor. */
export function executionView<M extends Machine = Machine>(
  state: CommandState,
  now: string,
  machines: readonly M[] = [],
  queue: readonly RunQueuePosition[] = [],
  queueWarningMinutes = 30,
  contexts?: ExecutionContexts,
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
  // run_queued event. Legacy resumption and dispatch recovery create the queued Run in the same command that
  // emits its trigger event, without a run_queued event, so that trigger's
  // time is when the Run was queued.
  const withQueuedAt = runQueuedAt(state);
  const warning = (run: Run) => {
    const waiting = queue.find(
      (entry) =>
        entry.project_id === state.project_id && entry.run_id === run.id,
    );
    return waiting && run.status === "queued" && (waiting.priority ?? 0) <= 1
      ? {
          queue_warning: {
            after_minutes: queueWarningMinutes,
            waited_ms: Math.max(
              0,
              Date.parse(now) - Date.parse(waiting.created_at),
            ),
          },
        }
      : {};
  };
  // C-232: the sample belongs to the Assignment's session, so only its newest
  // Run carries it; older Runs of the same Assignment never do.
  const contextByRun = new Map<
    string,
    NonNullable<ReturnType<typeof contextUsageView>>
  >();
  for (const assignment of state.assignments) {
    const run = latestRun(assignment.id);
    const usage = run && contextUsageView(state, assignment, contexts);
    if (run && usage) contextByRun.set(run.id, usage);
  }
  const withContext = (run: Run) => {
    const usage = contextByRun.get(run.id);
    return usage ? { context_usage: usage } : {};
  };
  const cardPrechecks = precheckIndex(state);
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
        card_priority: state.cards.find((c) => c.id === card_id)?.priority ?? 0,
        card_status: state.cards.find((c) => c.id === card_id)?.status ?? null,
        card_title: state.cards.find((c) => c.id === card_id)?.title ?? null,
        ...(waiting
          ? {
              queue_ahead: waiting.ahead,
              queue_order: waiting,
              dispatch_tier: waiting.dispatch_tier,
              dispatch_reason: waiting.dispatch_reason,
            }
          : {}),
        standing_mode:
          assignment.scope === "standing"
            ? (assignment.standing_mode ?? null)
            : null,
        id: assignment.id,
        ...webAuthorView(state, `assignment:${assignment.id}`),
        scope: assignment.scope,
        work_item_id: assignment.work_item_id ?? null,
        // C-531: only a row bound to a card's work item has a card presence.
        ...(assignment.scope === "work_item" && card_id
          ? {
              run_presence: assignmentPresence(
                state,
                assignment,
                cardPrechecks(card_id),
              ),
            }
          : {}),
        verification_activity: (() => {
          const item = state.work_items.find(
            (w) => w.id === assignment.work_item_id,
          );
          return item ? verificationActivity(item, state) : undefined;
        })(),
        role_id: assignment.role_id,
        role_version: assignment.role_version,
        status: assignment.status,
        external: assignment.external ?? false,
        runtime_state: assignment.runtime_state,
        machine_id: assignment.machine_id,
        runtime_ref: assignment.runtime_ref ?? null,
        worktree_path: assignment.worktree_path ?? null,
        branch: assignment.branch ?? null,
        base_sha: assignment.base_sha ?? null,
        session_ref: assignment.session_ref ?? null,
        created_at: assignment.created_at,
        last_mcp_activity_at: assignment.last_mcp_activity_at ?? null,
        session_maintenance: sessionMaintenanceView(state, assignment),
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
                ...warning(run),
                heartbeat_at: run.heartbeat_at ?? null,
                heartbeat_note: run.heartbeat_note ?? null,
                outcome: run.outcome,
                ...withContext(run),
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
          ...warning(run),
          ...(waiting
            ? {
                queue_ahead: waiting.ahead,
                queue_order: waiting,
                dispatch_tier: waiting.dispatch_tier,
                dispatch_reason: waiting.dispatch_reason,
              }
            : {}),
          ...withContext(run),
        };
      }),
  };
}

/** C-75: page size of the execution drawer's Run history. */
export const EXECUTION_RUN_PAGE = PAGE_LIMITS.runs.default;

/**
 * C-75: one page of an Assignment's Run history for the execution drawer,
 * newest first. `before` is the id of the last Run of the previous page.
 * Returns `undefined` when the Assignment does not exist.
 */
export function executionRunPage(
  state: CommandState,
  assignment_id: string,
  before?: string,
  queue: readonly RunQueuePosition[] = [],
) {
  if (!state.assignments.some((assignment) => assignment.id === assignment_id))
    return undefined;
  const all = [...state.runs]
    .filter((run) => run.assignment_id === assignment_id)
    .sort(byId)
    .reverse();
  const anchor =
    before === undefined ? -1 : all.findIndex((run) => run.id === before);
  if (before !== undefined && anchor < 0)
    throw new InvalidQuery("Run 历史分页游标无效，请刷新后重试");
  const rest = all.slice(anchor + 1);
  const page = rest.slice(0, EXECUTION_RUN_PAGE);
  const queuedAt = runQueuedAt(state);
  return {
    assignment_id,
    total: all.length,
    runs: page.map((run) => {
      const waiting = queue.find(
        (r) => r.project_id === state.project_id && r.run_id === run.id,
      );
      return {
        ...run,
        ...queuedAt(run),
        ...(waiting
          ? {
              queue_ahead: waiting.ahead,
              queue_order: waiting,
              dispatch_tier: waiting.dispatch_tier,
              dispatch_reason: waiting.dispatch_reason,
            }
          : {}),
      };
    }),
    next_cursor: rest.length > page.length ? (page.at(-1)?.id ?? null) : null,
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

export const EVENT_CATEGORIES: Readonly<Record<string, readonly string[]>> = {
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
    "run_inbox_stalled",
    "run_inactive",
    "run_remote_activity_missing",
    "run_local_activity_missing",
    "run_inactivity_stop_requested",
    "run_inactivity_stop_started",
    "run_inactivity_stop_withdrawn",
    "run_inactivity_stop_finished",
    "inactive_stop_unconfirmed",
    "inactive_stop_confirmed",
    "session_replaced",
    "standing_session_restarted",
    "runtime_unknown",
    "runtime_lost",
    "runtime_reconnected",
    "runtime_unknown_surfaced",
    "runtime_exit_observed",
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

export const RANGE_MS: Readonly<Record<string, number>> = {
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
      (query.type !== undefined || event.type !== "cross_card_read") &&
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
  "frontend_engineer",
  "reviewer",
  "designer",
  "ui_ux_designer",
  "design_director",
  "tester",
  "host_ops",
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

/**
 * C-494: the host's loaded launch profiles for role pickers — name, harness and
 * model only. Providers, endpoints and secrets never leave the host.
 */
export function launchProfileOptions(config: LaunchConfig | undefined) {
  return Object.entries(config?.profiles ?? {})
    .map(([name, profile]) => ({
      name,
      harness: profile.harness,
      model: profile.model ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** V9b 角色列表: the latest version of every role, inactive ones included. */
export function roleList(
  project_id: ProjectId,
  versions: readonly Role[],
  config?: LaunchConfig,
) {
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
    launch_profiles: launchProfileOptions(config),
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
