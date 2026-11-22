import { deriveCardStatus } from "../derived.js";
import type { Employee, EmployeeActivity } from "../employee.js";
import type * as E from "../entities.js";
import type { DomainError, ErrorCode, Result } from "../errors.js";
import { HOST_OPS_FORBIDDEN_TOOLS, hostOpsPending } from "../host-ops.js";
import type * as I from "../ids.js";
import type { Member } from "../member.js";
import { mergeBatches } from "../merge-batch.js";
import type { Clock, IdAllocator } from "../ports.js";
import type { ProjectPreferences } from "../preferences.js";
import { assignmentExternalError } from "../standing.js";
import { storyProgress, storyTerminal } from "../story.js";
import type { CardTemplate } from "../templates.js";
import { transition } from "../transitions.js";

export interface CommandEntities {
  machines: E.Machine;
  project_preferences: ProjectPreferences;
  cards: E.Card;
  card_templates: CardTemplate;
  work_items: E.WorkItem;
  assignments: E.Assignment;
  runs: E.Run;
  deliveries: E.Delivery;
  reviews: E.Review;
  decisions: E.Decision;
  human_actions: E.HumanAction;
  attachments: E.Attachment;
  cursors: E.Cursor;
}
export type CommandState = {
  readonly project_id: I.ProjectId;
  /** Live host port, never persisted in a snapshot or accepted from tools. */
  readonly read_machine_placement?: import("../machine-placement.js").ReadMachinePlacement;
  readonly test_review_trust?: import("../test-review.js").TestReviewTrust;
  readonly machines?: readonly E.Machine[];
  readonly project_preferences?: readonly ProjectPreferences[];
  readonly card_templates?: readonly CardTemplate[];
  readonly employees?: readonly Employee[];
  readonly members?: readonly Member[];
  readonly employee_activity?: readonly EmployeeActivity[];
  /** Loaded by the host from trusted configuration; never supplied by MCP callers. */
  readonly project_settings?: {
    readonly merge_gate_enabled?: boolean;
    readonly merge_queue?: {
      readonly max_batch_size: number;
      readonly conflict_threshold?: number;
      readonly window_timeout_ms?: number;
    };
    /** Push routes: merges into `base_branch` are pushed to `branch` of `target`. */
    readonly merge_push?: readonly {
      readonly target: string;
      readonly branch: string;
      readonly base_branch: string;
      /** The registered baseline: older records without a branch belong here. */
      readonly registered?: boolean;
    }[];
  };
  /** Effective issuance tools, read in the flow-upgrade caller's fresh transaction. */
  readonly assignment_tool_scopes?: Readonly<
    Record<string, readonly E.ToolName[]>
  >;
  readonly roles: readonly E.RoleReference[];
  readonly events: readonly E.Event[];
  readonly timeline: readonly E.TimelineEntry[];
} & {
  readonly [K in Exclude<
    keyof CommandEntities,
    "card_templates" | "project_preferences" | "machines"
  >]: readonly CommandEntities[K][];
};
export type EntityChange = {
  [K in keyof CommandEntities]: {
    readonly collection: K;
    readonly entity: CommandEntities[K];
  };
}[keyof CommandEntities];
export interface CommandPorts {
  readonly unreservedAssignment?: import("../ports.js").UnreservedAssignment;
  /** Workbench confirmation for ungranted scope changes. D12 high risks are gated by the actor. */
  readonly human_confirmation?: "workbench";
  readonly clock: Clock;
  readonly ids: IdAllocator;
  /** Registered repositories of this project, supplied by the host, not the proposal. */
  readonly project_repositories?: readonly {
    readonly repo: string;
    readonly base_branch: string | null;
  }[];
  /** Host-provided template configuration, never MCP parameters. */
  readonly templates?: readonly CardTemplate[];
  /** Host-only token row: authenticated request token, or its current row at settlement. Never MCP parameters. */
  readonly run_token?: {
    readonly id: string;
    readonly project_id: I.ProjectId;
    readonly assignment_id: I.AssignmentId;
    readonly role_version: number;
    readonly allowed_tools: readonly E.ToolName[];
    readonly revoked_at: string | null;
  };
}
export interface TokenRequest {
  readonly token_id: string;
  readonly assignment_id: I.AssignmentId;
  readonly role_version: number;
  readonly allowed_tools: readonly E.ToolName[];
}
export interface CommandEffect<T> {
  readonly data: T;
  readonly changes: readonly EntityChange[];
  readonly events: readonly E.Event[];
  readonly timeline: readonly E.TimelineEntry[];
  readonly token_requests: readonly TokenRequest[];
}

class Rejection {
  constructor(readonly error: DomainError) {}
}
type CommandName =
  | E.ToolName
  | "pause_standing_assignment"
  | "stop_assignment"
  | "rotate_standing_pm"
  | "rotate_deployed_pm"
  | "upgrade_idle_assignment_role"
  | "record_deployment"
  | "control_deployment"
  | "create_host_ops_assignment"
  | "rotate_host_ops_assignment"
  | "manage_host_ops_action"
  | "queue_run"
  | "dispatch_run"
  | "refresh_run_target_wait"
  | "acknowledge_run"
  | "abort_dispatch"
  | "recover_dispatch"
  | "manage_dispatch_stop"
  | "resolve_dispatch_attention"
  | "manage_inactive_run_stop"
  | "settle_pending_run_finish"
  | "upgrade_card_flow"
  | "set_project_preferences"
  | "mark_notices_read"
  | "set_card_sensitive"
  | "system_review_limit"
  | "refresh_test_review_limits"
  | "refresh_required_verifiers"
  | "refresh_human_action_follow_ups"
  | "cancel_human_action"
  | "refresh_cancelled_human_actions"
  | "auto_assign_verifier"
  | "auto_assign_producer"
  | "resume_work_waits"
  | "maintain_pm_coordination"
  | "recover_standing_pm"
  | "apply_auto_risk_tags"
  | "record_merge_shadow"
  | "remind_system_waits"
  | "system_complete_card"
  | "refresh_card_dependencies"
  | "system_confirm_merge"
  | "auto_confirm_merge"
  | "expire_merge_snoozes"
  | "remind_decision_followups"
  | "request_merge"
  | "record_merge_result"
  | "manage_merge_batch"
  | "begin_merge_push"
  | "record_merge_push_result"
  | "check_merge_push_range"
  | "accept_merge_push_hold"
  | "record_merge_executor"
  | "record_precheck"
  | "record_merge_check"
  | "record_merge_preparation"
  | "record_merge_check_blockers"
  | "record_automatic_merge_waits"
  | "record_merge_check_wait"
  | "recheck_merge"
  | "supersede_card"
  | "manage_machines"
  | "manage_templates"
  | "mark_card_done"
  | "confirm_story_proposal"
  | "clear_released_runtime_refs"
  | "request_worktree_cleanup";
export function ensure(
  condition: unknown,
  code: ErrorCode,
  message: string,
  details?: DomainError["details"],
): asserts condition {
  if (!condition)
    throw new Rejection({ code, message, ...(details ? { details } : {}) });
}
export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Rejection(result.error);
  return result.value;
}
export function text(value: unknown, field: string): asserts value is string {
  ensure(
    typeof value === "string" && value.trim().length > 0,
    "validation_failed",
    `${field} is required`,
  );
}
export function attempt<T>(operation: () => T): Result<T> {
  try {
    return { ok: true, value: operation() };
  } catch (error) {
    if (error instanceof Rejection) return { ok: false, error: error.error };
    throw error;
  }
}

type Entry = Pick<E.TimelineEntry, "type" | "body"> & {
  readonly author?: "system";
} & Partial<
    Pick<
      E.TimelineEntry,
      | "work_item_id"
      | "delivery_id"
      | "decision_id"
      | "human_action_id"
      | "run_id"
      | "reply_to"
      | "refs"
      | "supersedes"
      | "mentions"
    >
  >;
const keyOf = (entity: CommandEntities[keyof CommandEntities]) =>
  "version" in entity
    ? `${entity.id}@${entity.version}`
    : "id" in entity
      ? entity.id
      : `${entity.assignment_id}/${entity.card_id}`;

/**
 * C-230: per-snapshot key index for `CommandDraft.get`. Like C-221's
 * `eventById`/`hasRunTarget`, it relies on command state collections being
 * immutable snapshots: the Store's snapshot cache and every fixture build a new
 * array on change and nothing mutates one in place, so an index keyed by array
 * identity cannot go stale. Draft writes live in `changes` and are consulted
 * first; a rolled-back transaction keeps reading its old array and old index.
 */
const NONE: readonly never[] = [];
const stateIndexes = new WeakMap<
  readonly object[],
  ReadonlyMap<string, object>
>();
const stateLists = new WeakMap<readonly object[], readonly object[]>();
function stateIndex<T extends CommandEntities[keyof CommandEntities]>(
  entities: readonly T[],
): ReadonlyMap<string, T> {
  let index = stateIndexes.get(entities);
  if (!index) {
    // Same as `new Map(entities.map((e) => [keyOf(e), e]))`: the last entry wins.
    const map = new Map<string, T>();
    for (const entity of entities) map.set(keyOf(entity), entity);
    index = map;
    stateIndexes.set(entities, index);
  }
  return index as ReadonlyMap<string, T>;
}

// A private draft: rejection never exposes a partially applied entity/event batch.
export class CommandDraft {
  private readonly lists = new Map<keyof CommandEntities, readonly object[]>();
  readonly changes: EntityChange[] = [];
  private publishingCards: Set<I.CardId> | undefined;
  readonly events: E.Event[] = [];
  readonly timeline: E.TimelineEntry[] = [];
  readonly token_requests: TokenRequest[] = [];
  readonly assignment: E.Assignment | undefined;
  readonly author: E.Author;
  constructor(
    readonly state: CommandState,
    readonly actor: E.Actor,
    readonly tool: CommandName,
    readonly ports?: CommandPorts,
  ) {
    ensure(
      tool !== "upgrade_card_flow" || actor.kind === "human",
      "unauthorized",
      "只有人能变更卡片流程版本",
    );
    ensure(
      tool !== "supersede_card" || actor.kind === "human",
      "forbidden_tool",
      "Only the human can supersede a card",
    );
    ensure(
      tool !== "create_host_ops_assignment" || actor.kind === "human",
      "unauthorized",
      "Only the human can create a standing host_ops Assignment",
    );
    ensure(
      tool !== "cancel_human_action" || actor.kind === "human",
      "unauthorized",
      "Only the human can close a human action",
    );
    const hostOnly = [
      "queue_run",
      "dispatch_run",
      "refresh_run_target_wait",
      "abort_dispatch",
      "pause_standing_assignment",
    ].includes(tool);
    ensure(
      tool !== "control_deployment" || actor.kind === "human",
      "unauthorized",
      "部署认领和固定仅限人操作",
    );
    const systemOnly = [
      "upgrade_idle_assignment_role",
      "rotate_deployed_pm",
      "record_deployment",
      "manage_host_ops_action",
      "manage_inactive_run_stop",
      "settle_pending_run_finish",
      "system_review_limit",
      "refresh_test_review_limits",
      "refresh_required_verifiers",
      "refresh_human_action_follow_ups",
      "refresh_cancelled_human_actions",
      "auto_assign_verifier",
      "auto_assign_producer",
      "resume_work_waits",
      "maintain_pm_coordination",
      "recover_standing_pm",
      "apply_auto_risk_tags",
      "record_merge_shadow",
      "remind_system_waits",
      "system_complete_card",
      "refresh_card_dependencies",
      "system_confirm_merge",
      "auto_confirm_merge",
      "expire_merge_snoozes",
      "recover_dispatch",
      "manage_dispatch_stop",
      "resolve_dispatch_attention",
      "remind_decision_followups",
      "record_merge_result",
      "manage_merge_batch",
      "record_merge_executor",
      "record_precheck",
      "record_merge_check",
      "record_merge_preparation",
      "record_merge_check_blockers",
      "record_automatic_merge_waits",
      "record_merge_check_wait",
      "begin_merge_push",
      "record_merge_push_result",
      "check_merge_push_range",
      "request_worktree_cleanup",
      "clear_released_runtime_refs",
    ].includes(tool);
    // Only recheck_merge maps onto a host_ops tool. abort_dispatch and
    // pause_standing_assignment are host/human-only: host_ops reaches them
    // solely through the vetted host_ops action flow (actor=system).
    const hostTool =
      tool === "recheck_merge"
        ? ("host_ops_recheck_merge" as const)
        : undefined;
    ensure(
      tool !== "accept_merge_push_hold" || actor.kind === "human",
      "unauthorized",
      "Only the human can accept foreign commits",
    );
    ensure(
      !tool.startsWith("host_ops_") || actor.kind === "assignment",
      "unauthorized",
      "Host operations tools require an authenticated host_ops Assignment",
    );
    ensure(
      tool !== "recheck_merge" ||
        actor.kind === "human" ||
        (actor.kind === "assignment" && actor.role_id === "host_ops"),
      "unauthorized",
      "Only the human or authorized host_ops can request another merge check",
    );
    ensure(
      !systemOnly || actor.kind === "system",
      "unauthorized",
      "Only the system can perform this operation",
    );
    ensure(
      actor.project_id === state.project_id &&
        (actor.kind !== "system" ||
          hostOnly ||
          systemOnly ||
          tool === "release_assignment"),
      "unauthorized",
      "Actor cannot access this project",
    );
    ensure(
      !hostOnly || actor.kind !== "assignment",
      "unauthorized",
      "Only the host can manage launch runs",
    );
    this.author =
      actor.kind === "assignment"
        ? `assignment:${actor.assignment_id}`
        : actor.kind;
    if (actor.kind === "assignment") {
      this.assignment = state.assignments.find(
        (a) => a.id === actor.assignment_id,
      );
      ensure(
        this.assignment,
        "unauthorized",
        "Assignment is not authenticated in this project",
      );
      ensure(
        this.assignment.status === "active" &&
          this.assignment.role_id === actor.role_id &&
          this.assignment.role_version === actor.role_version,
        "unauthorized",
        "Assignment or role version is no longer active",
      );
      ensure(
        (!tool.startsWith("host_ops_") || actor.role_id === "host_ops") &&
          (actor.role_id !== "host_ops" ||
            (this.assignment.scope === "standing" &&
              !(HOST_OPS_FORBIDDEN_TOOLS as readonly string[]).includes(tool))),
        "forbidden_tool",
        "Tool is outside the host_ops role boundary",
      );
      const role = state.roles.find(
        (r) =>
          r.role_id === actor.role_id && r.role_version === actor.role_version,
      );
      ensure(
        role &&
          (tool === "acknowledge_run" ||
            tool === "request_merge" ||
            (role.allowed_tools.includes(hostTool ?? (tool as E.ToolName)) &&
              actor.allowed_tools.includes(hostTool ?? (tool as E.ToolName)))),
        "forbidden_tool",
        `Tool ${tool} is not allowed`,
      );
    }
  }
  get now(): string {
    ensure(
      this.ports,
      "invariant_violation",
      "Clock and allocator are required",
    );
    return this.ports.clock.now();
  }
  get ids(): IdAllocator {
    ensure(this.ports, "invariant_violation", "Allocator is required");
    return this.ports.ids;
  }
  list<K extends keyof CommandEntities>(
    collection: K,
  ): readonly CommandEntities[K][] {
    const cached = this.lists.get(collection);
    if (cached) return cached as readonly CommandEntities[K][];
    const source = (this.state[collection] ??
      NONE) as readonly CommandEntities[K][];
    const changes = this.changes.filter((c) => c.collection === collection);
    let result = stateLists.get(source);
    if (changes.length) {
      const values = new Map(stateIndex(source));
      for (const change of changes)
        values.set(keyOf(change.entity), change.entity as CommandEntities[K]);
      result = [...values.values()];
    } else if (!result) {
      // Preserve last-key-wins and first-key order, including legacy duplicates.
      result = [...stateIndex(source).values()];
      stateLists.set(source, result);
    }
    this.lists.set(collection, result);
    return result as readonly CommandEntities[K][];
  }
  get<K extends keyof CommandEntities>(
    collection: K,
    id: string,
  ): CommandEntities[K] {
    // C-230: same answer as `this.list(collection).find((v) => keyOf(v) === id)`
    // without rebuilding the whole collection on every lookup. `list` keeps the
    // last state entry per key, then the last change per key overrides it.
    let entity: CommandEntities[K] | undefined;
    for (let i = this.changes.length - 1; i >= 0 && !entity; i--) {
      const change = this.changes[i] as EntityChange;
      if (change.collection === collection && keyOf(change.entity) === id)
        entity = change.entity as CommandEntities[K];
    }
    entity ??= stateIndex(
      (this.state[collection] ?? NONE) as readonly CommandEntities[K][],
    ).get(id);
    ensure(entity, "not_found", `${collection}:${id} was not found`);
    ensure(
      collection !== "attachments" ||
        !(entity as E.Attachment).streamed_artifact?.expired,
      "not_found",
      `Attachment ${id} has expired`,
    );
    return entity;
  }
  put<K extends keyof CommandEntities>(
    collection: K,
    entity: CommandEntities[K],
  ): void {
    if (this.tool !== "manage_merge_batch") {
      this.publishingCards ??= new Set(
        mergeBatches(this.state.events)
          .filter((b) => b.status === "publishing")
          .flatMap((b) => b.members.map((m) => m.card_id)),
      );
      const protectedCards = this.publishingCards;
      if (protectedCards.size) {
        const v = entity as {
          id?: string;
          card_id?: I.CardId;
          work_item_id?: I.WorkItemId;
          affected_cards?: readonly I.CardId[];
          blocked_work_items?: readonly I.WorkItemId[];
          affected_work_items?: readonly I.WorkItemId[];
        };
        const card =
          collection === "cards"
            ? v.id
            : (v.card_id ??
              this.state.work_items.find((w) => w.id === v.work_item_id)
                ?.card_id);
        const protectedChange =
          collection === "project_preferences" ||
          (!!card && protectedCards.has(card as I.CardId)) ||
          v.affected_cards?.some((id) => protectedCards.has(id)) ||
          [
            ...(v.blocked_work_items ?? []),
            ...(v.affected_work_items ?? []),
          ].some((id) =>
            this.state.work_items.some(
              (w) => w.id === id && protectedCards.has(w.card_id),
            ),
          );
        const before = this.state[collection]?.find(
          (v) => keyOf(v) === keyOf(entity),
        );
        ensure(
          !protectedChange || JSON.stringify(before) === JSON.stringify(entity),
          "illegal_transition",
          "正在合并，请等待批次发布完成",
        );
      }
    }
    if (collection === "assignments") {
      const assignment = entity as E.Assignment;
      const error = assignmentExternalError(
        assignment,
        this.list("assignments").find((a) => a.id === assignment.id),
      );
      ensure(
        !error,
        "invariant_violation",
        error ?? "Invalid external Assignment",
      );
    }
    const index = this.changes.findIndex(
      (c) => c.collection === collection && keyOf(c.entity) === keyOf(entity),
    );
    const change = { collection, entity } as EntityChange;
    if (index < 0) this.changes.push(change);
    else this.changes[index] = change;
    this.lists.delete(collection);
  }
  pm(): void {
    ensure(
      this.actor.kind === "human" ||
        (this.actor.kind === "assignment" && this.actor.role_id === "pm"),
      "forbidden_tool",
      "Only PM or the human can perform this operation",
    );
  }
  projectAccess(): void {
    ensure(
      this.actor.kind === "human" ||
        this.actor.kind === "system" ||
        (this.assignment?.scope === "standing" &&
          ["pm", "host_ops"].includes(this.assignment.role_id)),
      "unauthorized",
      "A project-scoped PM or host_ops assignment is required",
    );
  }
  card(id: I.CardId): E.Card {
    const card = this.get("cards", id);
    ensure(
      card.project_id === this.state.project_id,
      "unauthorized",
      "Card belongs to another project",
    );
    if (this.assignment?.scope === "work_item")
      ensure(
        this.get("work_items", this.assignment.work_item_id).card_id === id,
        "unauthorized",
        "Card is outside this assignment",
      );
    else this.projectAccess();
    return card;
  }
  work(id: I.WorkItemId): E.WorkItem {
    const item = this.get("work_items", id);
    this.card(item.card_id);
    return item;
  }
  ownWork(id: I.WorkItemId): E.WorkItem {
    const item = this.work(id);
    ensure(
      this.assignment?.scope === "work_item" &&
        this.assignment.work_item_id === id &&
        item.assignment_id === this.assignment.id &&
        item.role_id === this.assignment.role_id,
      "unauthorized",
      "Only the owning assignment can perform this operation",
    );
    return item;
  }
  ownRun(id: I.RunId): E.Run {
    const run = this.get("runs", id);
    ensure(
      !run.dispatch_stop?.stopping &&
        run.launch_publication?.phase !== "stopping" &&
        !hostOpsPending(this.state.events, run.assignment_id),
      "illegal_transition",
      "Run terminal stop is in progress",
    );
    ensure(
      this.assignment && run.assignment_id === this.assignment.id,
      "unauthorized",
      "Run belongs to another assignment",
    );
    ensure(
      run.role_version === this.assignment.role_version &&
        run.model.trim() &&
        run.agent_cli_version.trim(),
      "invariant_violation",
      "Run must retain its role, model and CLI version snapshot",
    );
    return run;
  }
  currentRun(): E.Run {
    const runs = this.list("runs").filter(
      (run) =>
        run.assignment_id === this.assignment?.id && run.status === "running",
    );
    ensure(
      runs.length === 1 && runs[0],
      "illegal_transition",
      "Exactly one running Run is required",
    );
    return this.ownRun(runs[0].id);
  }
  move(item: E.WorkItem, event: string): E.WorkItem {
    return {
      ...item,
      status: unwrap(transition(item.kind, item.status, event)),
    } as E.WorkItem;
  }
  emit(
    type: string,
    card_id: I.CardId | undefined,
    payload: E.JsonValue,
    entry?: Entry,
    actor = this.actor,
  ): E.Event {
    const event: E.Event = {
      id: this.ids.nextEventId(),
      ...(card_id ? { card_id } : {}),
      seq: this.ids.nextEventSequence(this.state.project_id, card_id),
      type,
      actor,
      payload,
      created_at: this.now,
    };
    this.events.push(event);
    if (entry && card_id) {
      const id = this.ids.nextTimelineEntryId(this.state.project_id, card_id);
      this.timeline.push({
        ...entry,
        id,
        short_id: id,
        card_id,
        event_seq: event.seq,
        author: entry.author ?? this.author,
        refs: entry.refs ?? [],
        mentions: entry.mentions ?? [],
        retracted: false,
        created_at: event.created_at,
      });
    }
    return event;
  }
}

export function command<T>(
  state: CommandState,
  actor: E.Actor,
  tool: CommandName,
  ports: CommandPorts | undefined,
  operation: (draft: CommandDraft) => T,
  afterOperation?: (draft: CommandDraft) => void,
): Result<CommandEffect<T>> {
  return attempt(() => {
    const draft = new CommandDraft(state, actor, tool, ports);
    const data = operation(draft);
    const cards = new Set(
      draft.changes.flatMap((change) =>
        change.collection === "work_items" ? [change.entity.card_id] : [],
      ),
    );
    for (const id of cards) {
      const card = draft.get("cards", id);
      const items = draft.list("work_items").filter((w) => w.card_id === id);
      const completion = draft
        .list("deliveries")
        .filter(
          (v) =>
            v.kind === "card_completion" &&
            v.status !== "superseded" &&
            items.some((w) => w.id === v.work_item_id),
        )
        .sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)))[0];
      const status = deriveCardStatus(card.status, items, completion);
      if (status !== card.status) draft.put("cards", { ...card, status });
    }
    afterOperation?.(draft);
    // Edge-triggered from the final draft, including merge and human completion.
    const parents = new Set<I.CardId>();
    for (const change of draft.changes) {
      if (change.collection !== "cards") continue;
      const child = change.entity;
      if (!child.parent_card_id || !storyTerminal(child)) continue;
      const before = stateIndex(state.cards).get(child.id);
      if (before && !storyTerminal(before)) parents.add(child.parent_card_id);
    }
    for (const id of parents) {
      const parent = draft.get("cards", id);
      if (!parent.story || storyTerminal(parent)) continue;
      const { finished, total } = storyProgress(draft.list("cards"), parent);
      if (total && total === finished)
        draft.emit(
          "story_children_settled",
          id,
          { total },
          {
            type: "system",
            author: "system",
            body: `${total} 张子卡均已结束，请 Office 提交对照总结。`,
          },
          { kind: "system", project_id: state.project_id },
        );
    }
    return {
      data,
      changes: draft.changes,
      events: draft.events,
      timeline: draft.timeline,
      token_requests: draft.token_requests,
    };
  });
}
