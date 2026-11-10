import { deriveCardStatus } from "../derived.js";
import type { Employee, EmployeeActivity } from "../employee.js";
import type * as E from "../entities.js";
import type { DomainError, ErrorCode, Result } from "../errors.js";
import type * as I from "../ids.js";
import type { Clock, IdAllocator } from "../ports.js";
import type { ProjectPreferences } from "../preferences.js";
import type { CardTemplate } from "../templates.js";
import { transition } from "../transitions.js";

export interface CommandEntities {
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
  readonly project_preferences?: readonly ProjectPreferences[];
  readonly card_templates?: readonly CardTemplate[];
  readonly employees?: readonly Employee[];
  readonly employee_activity?: readonly EmployeeActivity[];
  /** Loaded by the host from trusted configuration; never supplied by MCP callers. */
  readonly project_settings?: {
    readonly merge_gate_enabled?: boolean;
    readonly merge_push?: { readonly target: string; readonly branch: string };
  };
  readonly roles: readonly E.RoleReference[];
  readonly events: readonly E.Event[];
  readonly timeline: readonly E.TimelineEntry[];
} & {
  readonly [K in Exclude<
    keyof CommandEntities,
    "card_templates" | "project_preferences"
  >]: readonly CommandEntities[K][];
};
export type EntityChange = {
  [K in keyof CommandEntities]: {
    readonly collection: K;
    readonly entity: CommandEntities[K];
  };
}[keyof CommandEntities];
export interface CommandPorts {
  /** Workbench confirmation for ungranted scope changes. D12 high risks are gated by the actor. */
  readonly human_confirmation?: "workbench";
  readonly clock: Clock;
  readonly ids: IdAllocator;
  /** Host-provided template configuration, never MCP parameters. */
  readonly templates?: readonly CardTemplate[];
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
  | "rotate_standing_pm"
  | "queue_run"
  | "dispatch_run"
  | "acknowledge_run"
  | "abort_dispatch"
  | "manage_inactive_run_stop"
  | "set_project_preferences"
  | "mark_notices_read"
  | "set_card_sensitive"
  | "auto_confirm_merge"
  | "remind_decision_followups"
  | "request_merge"
  | "record_merge_result"
  | "begin_merge_push"
  | "record_merge_push_result"
  | "record_merge_check"
  | "recheck_merge"
  | "release_assignment"
  | "supersede_card"
  | "manage_templates"
  | "mark_card_done"
  | "request_worktree_cleanup";
export function ensure(
  condition: unknown,
  code: ErrorCode,
  message: string,
): asserts condition {
  if (!condition) throw new Rejection({ code, message });
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

// A private draft: rejection never exposes a partially applied entity/event batch.
export class CommandDraft {
  readonly changes: EntityChange[] = [];
  readonly events: E.Event[] = [];
  readonly timeline: E.TimelineEntry[] = [];
  readonly token_requests: TokenRequest[] = [];
  readonly assignment: E.Assignment | undefined;
  readonly author: E.Author;
  constructor(
    readonly state: CommandState,
    readonly actor: E.Actor,
    tool: CommandName,
    readonly ports?: CommandPorts,
  ) {
    ensure(
      tool !== "supersede_card" || actor.kind === "human",
      "forbidden_tool",
      "Only the human can supersede a card",
    );
    const hostOnly = [
      "queue_run",
      "dispatch_run",
      "abort_dispatch",
      "pause_standing_assignment",
    ].includes(tool);
    const systemOnly = [
      "manage_inactive_run_stop",
      "auto_confirm_merge",
      "remind_decision_followups",
      "record_merge_result",
      "record_merge_check",
      "begin_merge_push",
      "record_merge_push_result",
      "request_worktree_cleanup",
    ].includes(tool);
    ensure(
      tool !== "recheck_merge" || actor.kind === "human",
      "unauthorized",
      "Only the human can request another merge check",
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
      const role = state.roles.find(
        (r) =>
          r.role_id === actor.role_id && r.role_version === actor.role_version,
      );
      ensure(
        role &&
          (tool === "acknowledge_run" ||
            tool === "request_merge" ||
            tool === "release_assignment" ||
            (role.allowed_tools.includes(tool as E.ToolName) &&
              actor.allowed_tools.includes(tool as E.ToolName))),
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
    const values = new Map<string, CommandEntities[K]>(
      (this.state[collection] ?? []).map(
        (entity) => [keyOf(entity), entity] as [string, CommandEntities[K]],
      ),
    );
    for (const change of this.changes)
      if (change.collection === collection)
        values.set(keyOf(change.entity), change.entity as CommandEntities[K]);
    return [...values.values()];
  }
  get<K extends keyof CommandEntities>(
    collection: K,
    id: string,
  ): CommandEntities[K] {
    const entity = this.list(collection).find((value) => keyOf(value) === id);
    ensure(entity, "not_found", `${collection}:${id} was not found`);
    return entity;
  }
  put<K extends keyof CommandEntities>(
    collection: K,
    entity: CommandEntities[K],
  ): void {
    const index = this.changes.findIndex(
      (c) => c.collection === collection && keyOf(c.entity) === keyOf(entity),
    );
    const change = { collection, entity } as EntityChange;
    if (index < 0) this.changes.push(change);
    else this.changes[index] = change;
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
          this.assignment.role_id === "pm"),
      "unauthorized",
      "A project-scoped PM assignment is required",
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
  ): E.Event {
    const event: E.Event = {
      id: this.ids.nextEventId(),
      ...(card_id ? { card_id } : {}),
      seq: this.ids.nextEventSequence(this.state.project_id, card_id),
      type,
      actor: this.actor,
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
    return {
      data,
      changes: draft.changes,
      events: draft.events,
      timeline: draft.timeline,
      token_requests: draft.token_requests,
    };
  });
}
