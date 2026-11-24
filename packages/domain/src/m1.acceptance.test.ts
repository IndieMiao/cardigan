/**
 * M1 domain acceptance tests (M1.T1).
 *
 * Written from `docs/plans/phase-1-m1.md` §5 (M1.T1), `packages/domain/COMMANDS.md`
 * and the development plan (§4.4 state machines, §4.5 invariants), using only
 * the public exports of `@cardigan/domain`. Commands are always driven from
 * real states: cards, work items and assignments are created by `createCard` /
 * `assign`, and only the outer "a Run is running" fact is simulated here
 * (the real provisioning lives outside the domain).
 */
import { describe, expect, expectTypeOf, test } from "vitest";
import { machine } from "./commands/test-fixtures.js";
import {
  type Actor,
  type Assignment,
  type AttachmentStore,
  assign,
  type CardId,
  type Clock,
  type CommandEffect,
  type CommandPorts,
  type CommandState,
  completeHumanAction,
  createCard,
  createWorkItem,
  type DeliveryVerifier,
  type DomainError,
  finishRun,
  formatId,
  formatTimelineEntryId,
  heartbeat,
  type IdAllocator,
  type ProjectId,
  postComment,
  prepareAttachment,
  prepareDelivery,
  type ReadableIdKind,
  type Result,
  type RoleReference,
  type Run,
  recordDecision,
  reportBlocker,
  requestDecision,
  requestHumanAction,
  resolveDelegatedDecision,
  resolvePendingAttachmentRefs,
  setProjectPreferences,
  submitDelivery,
  submitReview,
  type ToolName,
  transition,
  updateCard,
  updateWorkItem,
  uploadAttachment,
  type WorkItem,
} from "./index.js";

const TEST_PLAIN_SUMMARY = {
  changed: "测试用的改动说明",
  impact: "测试用的影响说明",
  risk: "无",
};

const project_id = "p-acceptance" as ProjectId;
const NOW = "2026-01-01T00:00:00.000Z";

// ---------------------------------------------------------------- harness ---

class TestClock implements Clock {
  #tick = 0;
  now(): string {
    this.#tick += 1;
    const seconds = String(this.#tick % 60).padStart(2, "0");
    return `2026-01-01T00:${String(Math.floor(this.#tick / 60)).padStart(2, "0")}:${seconds}.000Z`;
  }
}

class TestIds implements IdAllocator {
  readonly #counters = new Map<string, number>();
  readonly #sequences = new Map<string, number>();
  readonly #timeline = new Map<string, number>();
  #event = 0;
  #attachment = 0;

  #bump(map: Map<string, number>, key: string): number {
    const next = (map.get(key) ?? 0) + 1;
    map.set(key, next);
    return next;
  }

  next<K extends ReadableIdKind>(_project: ProjectId, kind: K) {
    const result = formatId(kind, this.#bump(this.#counters, kind));
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  }

  nextTimelineEntryId(_project: ProjectId, card_id: CardId) {
    const result = formatTimelineEntryId(
      card_id,
      this.#bump(this.#timeline, card_id),
    );
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  }

  nextEventId() {
    this.#event += 1;
    return `01J${String(this.#event).padStart(23, "0")}` as ReturnType<
      IdAllocator["nextEventId"]
    >;
  }

  nextEventSequence(_project: ProjectId, card_id?: CardId) {
    return this.#bump(this.#sequences, card_id ?? "<project>");
  }

  nextAttachmentId(_project: ProjectId) {
    this.#attachment += 1;
    return `attachment-${this.#attachment}` as ReturnType<
      IdAllocator["nextAttachmentId"]
    >;
  }
}

const keyOf = (entity: object): string =>
  "id" in entity
    ? String((entity as { id: string }).id)
    : `${(entity as { assignment_id: string }).assignment_id}/${(entity as { card_id: string }).card_id}`;

interface Harness {
  state: CommandState;
  ports: CommandPorts;
}

function emptyState(roles: readonly RoleReference[]): CommandState {
  return {
    project_id,
    machines: [machine()],
    roles,
    project_preferences: [],
    events: [],
    timeline: [],
    cards: [],
    work_items: [],
    assignments: [],
    runs: [],
    deliveries: [],
    reviews: [],
    decisions: [],
    human_actions: [],
    attachments: [],
    cursors: [],
  };
}

/** Apply a command effect the way the store would: replace by id, append events. */
function commit<T>(h: Harness, result: Result<CommandEffect<T>>): T {
  if (!result.ok) {
    throw new Error(
      `unexpected rejection ${result.error.code}: ${result.error.message}`,
    );
  }
  const next: Record<string, unknown> = { ...h.state };
  for (const change of result.value.changes) {
    const list = [...(next[change.collection] as object[])];
    const index = list.findIndex((e) => keyOf(e) === keyOf(change.entity));
    if (index >= 0) list[index] = change.entity;
    else list.push(change.entity);
    next[change.collection] = list;
  }
  next.events = [...h.state.events, ...result.value.events];
  next.timeline = [...h.state.timeline, ...result.value.timeline];
  h.state = next as unknown as CommandState;
  return result.value.data;
}

function errorOf<T>(result: Result<T>): DomainError {
  if (result.ok) throw new Error("expected a rejection, got success");
  return result.error;
}

const pmTools: readonly ToolName[] = [
  "create_card",
  "update_card",
  "create_work_item",
  "update_work_item",
  "assign",
  "project_snapshot",
  "list_needs_you",
  "record_decision",
  "submit_review",
  "post_comment",
  "request_decision",
  "request_human_action",
  "upload_attachment",
  "report_blocker",
  "heartbeat",
  "finish_run",
];
const coderTools: readonly ToolName[] = [
  "submit_delivery",
  "post_comment",
  "request_decision",
  "request_human_action",
  "report_blocker",
  "upload_attachment",
  "heartbeat",
  "finish_run",
];
const reviewerTools: readonly ToolName[] = [
  "submit_review",
  "post_comment",
  "request_decision",
  "report_blocker",
  "heartbeat",
  "finish_run",
];

const roles: readonly RoleReference[] = [
  {
    role_id: "pm",
    role_version: 1,
    allowed_tools: pmTools,
    capabilities: ["manage"],
  },
  {
    role_id: "coder",
    role_version: 1,
    allowed_tools: coderTools,
    capabilities: ["code"],
  },
  {
    role_id: "reviewer",
    role_version: 1,
    allowed_tools: reviewerTools,
    capabilities: ["review"],
  },
];

const human: Actor = { kind: "human", project_id };

function newHarness(): Harness {
  return {
    state: emptyState(roles),
    ports: { clock: new TestClock(), ids: new TestIds() },
  };
}

/**
 * The store would already hold a standing PM assignment for the project.
 * Its token scope is decided by the caller (Office vs Ops).
 */
function seatStandingPm(h: Harness): Assignment {
  const id = h.ports.ids.next(project_id, "assignment");
  const assignment: Assignment = {
    id,
    scope: "standing",
    role_id: "pm",
    role_version: 1,
    status: "active",
    runtime_state: "not_running" as Assignment["runtime_state"],
    machine_id: "local",
    runtime_ref: null,
    mcp_token_id: `token-${id}`,
    created_at: NOW,
  };
  h.state = { ...h.state, assignments: [...h.state.assignments, assignment] };
  return assignment;
}

const seatPmOffice = seatStandingPm;

/** Register the real delegation tool only for these synthetic Ops scenarios. */
function seatDelegationOps(h: Harness): Actor {
  const ops = seatStandingPm(h);
  const tools: readonly ToolName[] = [...pmTools, "resolve_delegated_decision"];
  h.state = {
    ...h.state,
    roles: h.state.roles.map((r) =>
      r.role_id === "pm" ? { ...r, allowed_tools: tools } : r,
    ),
    assignments: h.state.assignments.map((a) =>
      a.scope === "standing" && a.id === ops.id
        ? { ...a, standing_mode: "ops" as const }
        : a,
    ),
  };
  return actorFor(h, ops.id, "pm", tools);
}

function actorFor(
  h: Harness,
  assignmentId: Assignment["id"],
  roleId: string,
  tools: readonly ToolName[],
): Actor {
  const assignment = h.state.assignments.find((a) => a.id === assignmentId);
  if (assignment === undefined)
    throw new Error(`no assignment ${assignmentId}`);
  return {
    kind: "assignment",
    project_id,
    assignment_id: assignmentId,
    role_id: roleId,
    role_version: assignment.role_version,
    allowed_tools: tools,
    capabilities: [],
  };
}

/**
 * The outer layer's job: an assignment gets a running Run. The domain only
 * requires "exactly one running Run"; creating it (and its version snapshot)
 * is not a domain command.
 */
function startRun(
  h: Harness,
  assignment: Assignment,
  overrides: Partial<Run> = {},
): Run {
  const run: Run = {
    id: h.ports.ids.next(project_id, "run"),
    assignment_id: assignment.id,
    trigger_event_id: h.ports.ids.nextEventId(),
    kind: "initial",
    status: "running",
    role_version: assignment.role_version,
    model: "fictional-model",
    agent_cli_version: "0.0.1",
    started_at: NOW,
    outcome: null,
    summary: "",
    ...overrides,
  };
  h.state = { ...h.state, runs: [...h.state.runs, run] };
  return run;
}

function endRun(
  h: Harness,
  actor: Actor,
  run: Run,
  outcome: "completed" | "blocked" = "completed",
): void {
  commit(
    h,
    finishRun(
      h.state,
      actor,
      { run_id: run.id, outcome, summary: `${outcome} (fictional)` },
      h.ports,
    ),
  );
}

const verifier: DeliveryVerifier = {
  verify: async () => ({
    ok: true,
    value: [{ kind: "commit", details: { sha: "fictional", checked: true } }],
  }),
};

const sha = (letter: string): string => letter.repeat(40);

/**
 * The adapter hashes the content before the preflight; the domain only checks
 * the digest shape, so a fixed 64-hex digest is enough for the port stub.
 */
const contentDigest = "a".repeat(64);

/** In-memory AttachmentStore port implementation for the artifact test. */
const attachmentStore = (): AttachmentStore => {
  const files = new Map<string, Uint8Array>();
  return {
    put: async (digest, content) => {
      files.set(digest, content);
      return { storage_path: `fictional/${digest.slice(0, 8)}` };
    },
    get: async (digest) => files.get(digest),
  };
};

interface DeliveryInput {
  readonly summary?: string;
  readonly kind?: "code" | "card_completion";
  readonly subject?: string;
  readonly verifiers: readonly WorkItem["id"][];
}

async function deliver(
  h: Harness,
  actor: Actor,
  workItemId: WorkItem["id"],
  input: DeliveryInput,
): Promise<string> {
  const params = {
    work_item_id: workItemId,
    kind: input.kind ?? ("code" as const),
    summary: input.summary ?? "fictional delivery",
    subject: { kind: "git_head" as const, value: input.subject ?? sha("a") },
    requested_verifiers: [...input.verifiers],
    ...(input.kind === "card_completion"
      ? { plain_summary: TEST_PLAIN_SUMMARY }
      : {}),
  };
  const prepared = await prepareDelivery(h.state, actor, params, verifier);
  if (!prepared.ok) {
    throw new Error(
      `prepare failed ${prepared.error.code}: ${prepared.error.message}`,
    );
  }
  const delivery = commit(
    h,
    submitDelivery(h.state, actor, params, prepared.value, h.ports),
  );
  return delivery.id;
}

function workItem(h: Harness, id: WorkItem["id"]): WorkItem {
  const item = h.state.work_items.find((w) => w.id === id);
  if (item === undefined) throw new Error(`no work item ${id}`);
  return item;
}

function review(
  h: Harness,
  actor: Actor,
  params: {
    delivery_id: string;
    target_sha: string;
    kind?: "code" | "product";
    issues?: readonly {
      readonly severity: "critical" | "major" | "minor";
      readonly description: string;
      readonly impact?: import("./entities.js").ReviewImpact;
      readonly must_fix: boolean;
      readonly pre_existing: boolean;
      readonly proof?: string;
    }[];
  },
) {
  return submitReview(
    h.state,
    actor,
    {
      delivery_id: params.delivery_id as never,
      target_sha: params.target_sha,
      kind: params.kind ?? "code",
      issues: [...(params.issues ?? [])],
    },
    h.ports,
  );
}

interface Scenario {
  readonly h: Harness;
  readonly card: CardId;
  readonly development: WorkItem;
  readonly codeReview: WorkItem;
  readonly acceptance: WorkItem;
  readonly coder: Assignment;
  readonly reviewer: Assignment;
  readonly pmAcceptance: Assignment;
  readonly pmOffice: Assignment;
  readonly coderActor: Actor;
  readonly reviewerActor: Actor;
  readonly pmAcceptanceActor: Actor;
  readonly pmOfficeActor: Actor;
}

/** Build a dev card through the commands, then assign its three work items. */
function scenario(): Scenario {
  const h = newHarness();
  const pmOffice = seatPmOffice(h);
  const pmOfficeActor = actorFor(h, pmOffice.id, "pm", pmTools);

  const card = commit(
    h,
    createCard(
      h.state,
      human,
      {
        title: "Fictional card",
        goal: "Prove the M1 commands compose",
        acceptance_criteria: ["tests pass"],
        source: { kind: "quote", text: "fictional request" },
        repo: "example/repo",
        base_branch: "main",
      },
      h.ports,
    ),
  );

  const items = h.state.work_items.filter((w) => w.card_id === card.id);
  const development = items.find((w) => w.role_id === "coder");
  const codeReview = items.find((w) => w.role_id === "reviewer");
  const acceptance = items.find((w) => w.role_id === "pm");
  if (!development || !codeReview || !acceptance) {
    throw new Error("dev template did not create the three work items");
  }

  const assignOne = (item: WorkItem, role: string) =>
    commit(
      h,
      assign(
        h.state,
        pmOfficeActor,
        { work_item_id: item.id, role_id: role },
        h.ports,
      ),
    );

  const coder = assignOne(development, "coder");
  const reviewer = assignOne(codeReview, "reviewer");
  const pmAcceptance = assignOne(acceptance, "pm");

  return {
    h,
    card: card.id,
    development,
    codeReview,
    acceptance,
    coder,
    reviewer,
    pmAcceptance,
    pmOffice,
    coderActor: actorFor(h, coder.id, "coder", coderTools),
    reviewerActor: actorFor(h, reviewer.id, "reviewer", reviewerTools),
    pmAcceptanceActor: actorFor(h, pmAcceptance.id, "pm", pmTools),
    pmOfficeActor,
  };
}

// ------------------------------------------------- §4.4 transition tables ---

interface TableCase {
  readonly machine: Parameters<typeof transition>[0];
  /** The states §4.4 defines for this machine. */
  readonly from: string;
  /** States reachable in one validated transition. */
  readonly to: readonly string[];
}

/**
 * §4.4 state machines transcribed as allowed targets per state. Event names are
 * an implementation detail, so the table is checked by reachability: every
 * allowed target must be reachable, and nothing else may be.
 */
const machineTables: readonly TableCase[] = [
  {
    machine: "card",
    from: "backlog",
    to: ["todo", "cancelled"],
  },
  // §4.4: in_progress / review come from derivation (D4), not from a table edge.
  { machine: "card", from: "todo", to: ["backlog", "cancelled"] },
  { machine: "card", from: "in_progress", to: ["review", "cancelled"] },
  {
    machine: "card",
    from: "review",
    to: ["review", "awaiting_merge", "in_progress", "cancelled"],
  },
  { machine: "card", from: "done", to: [] },
  { machine: "card", from: "cancelled", to: [] },
  { machine: "produce", from: "todo", to: ["ready", "cancelled"] },
  { machine: "produce", from: "ready", to: ["in_progress", "cancelled"] },
  {
    machine: "produce",
    from: "in_progress",
    to: ["delivered", "blocked", "waiting_decision", "cancelled"],
  },
  {
    machine: "produce",
    from: "delivered",
    to: ["delivered", "accepted", "changes_requested", "cancelled"],
  },
  {
    machine: "produce",
    from: "accepted",
    to: ["delivered", "changes_requested", "cancelled"],
  },
  {
    machine: "produce",
    from: "changes_requested",
    to: ["in_progress", "cancelled"],
  },
  { machine: "produce", from: "blocked", to: ["in_progress", "cancelled"] },
  {
    machine: "produce",
    from: "waiting_decision",
    to: ["in_progress", "cancelled"],
  },
  { machine: "produce", from: "cancelled", to: [] },
  {
    machine: "verify",
    from: "todo",
    to: ["ready", "cancelled"],
  },
  {
    machine: "verify",
    from: "ready",
    to: ["in_progress", "waiting_decision", "todo", "cancelled"],
  },
  {
    machine: "verify",
    from: "in_progress",
    to: [
      "passed",
      "failed",
      "ready",
      "todo",
      "waiting_decision",
      "blocked",
      "cancelled",
    ],
  },
  {
    machine: "verify",
    from: "failed",
    to: ["ready", "todo", "waiting_decision", "cancelled"],
  },
  { machine: "verify", from: "passed", to: ["ready", "todo"] },
  { machine: "verify", from: "blocked", to: ["in_progress", "cancelled"] },
  { machine: "verify", from: "waiting_decision", to: ["ready", "cancelled"] },
  { machine: "verify", from: "cancelled", to: [] },
  {
    machine: "delivery",
    from: "submitted",
    to: ["accepted", "rejected", "superseded"],
  },
  { machine: "delivery", from: "accepted", to: ["superseded"] },
  { machine: "delivery", from: "rejected", to: ["superseded"] },
  { machine: "delivery", from: "superseded", to: [] },
  {
    machine: "decision",
    from: "open",
    to: ["resolved", "provisional", "withdrawn", "superseded"],
  },
  { machine: "decision", from: "provisional", to: ["resolved", "revoked"] },
  { machine: "decision", from: "resolved", to: ["revoked", "superseded"] },
  { machine: "decision", from: "withdrawn", to: [] },
  { machine: "decision", from: "superseded", to: [] },
  { machine: "decision", from: "revoked", to: [] },
  { machine: "human_action", from: "open", to: ["done", "cancelled"] },
  { machine: "human_action", from: "done", to: [] },
  { machine: "human_action", from: "cancelled", to: [] },
  { machine: "assignment", from: "active", to: ["suspended", "released"] },
  { machine: "assignment", from: "suspended", to: ["active", "released"] },
  { machine: "assignment", from: "released", to: [] },
  {
    machine: "runtime",
    from: "not_provisioned",
    to: ["provisioning", "released"],
  },
  {
    machine: "runtime",
    from: "provisioning",
    to: ["idle", "unknown", "released"],
  },
  { machine: "runtime", from: "idle", to: ["running", "unknown", "released"] },
  { machine: "runtime", from: "running", to: ["idle", "unknown", "released"] },
  { machine: "runtime", from: "unknown", to: ["idle", "lost", "released"] },
  { machine: "runtime", from: "lost", to: ["released"] },
  { machine: "runtime", from: "released", to: [] },
  { machine: "run", from: "queued", to: ["dispatched", "cancelled"] },
  { machine: "run", from: "dispatched", to: ["acked", "unknown", "cancelled"] },
  { machine: "run", from: "acked", to: ["running", "unknown", "cancelled"] },
  {
    machine: "run",
    from: "running",
    to: ["completed", "failed", "cancelled", "unknown"],
  },
  { machine: "run", from: "unknown", to: ["running", "cancelled"] },
  { machine: "run", from: "completed", to: [] },
  { machine: "run", from: "failed", to: [] },
  { machine: "run", from: "cancelled", to: [] },
];

const events = [
  "dependencies_met",
  "run_started",
  "delivery_submitted",
  "verifiers_passed",
  "review_passed",
  "review_rejected",
  "review_limit_exceeded",
  "target_delivered",
  "target_redelivered",
  "target_withdrawn",
  "withdraw_pass",
  "decision_resolved",
  "block",
  "request_decision",
  "resume",
  "cancel",
  "accept",
  "reject",
  "supersede",
  "resolve",
  "provisionally_resolve",
  "withdraw",
  "revoke",
  "complete",
  "suspend",
  "release",
  "provision",
  "provisioned",
  "connection_lost",
  "reconnected",
  "declared_lost",
  "run_finished",
  "dispatch",
  "acknowledge",
  "start",
  "fail",
  "set_todo",
  "set_backlog",
  "completion_submitted",
  "completion_review_passed",
  "merge_conflicted",
  "completion_review_rejected",
  "unknown_event",
] as const;

/** Collect the targets reachable from `from` using any known event. */
function reachable(machine: TableCase["machine"], from: string): string[] {
  const targets = new Set<string>();
  for (const event of events) {
    const result = transition(machine, from as never, event);
    if (result.ok) targets.add(result.value);
  }
  return [...targets].sort();
}

describe("§4.4 state machines: allowed and forbidden transitions", () => {
  for (const table of machineTables) {
    test(`${table.machine}: from ${table.from} only reaches ${table.to.join(", ") || "(nothing)"}`, () => {
      expect(reachable(table.machine, table.from)).toEqual(
        [...table.to].sort(),
      );
    });
  }

  test("unknown events never transition", () => {
    for (const table of machineTables) {
      const result = transition(
        table.machine,
        table.from as never,
        "unknown_event",
      );
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error.code).toBe(
        "illegal_transition",
      );
    }
  });

  test("the transitions §4.4 names explicitly use those event names", () => {
    expect(transition("produce", "todo", "dependencies_met")).toEqual({
      ok: true,
      value: "ready",
    });
    expect(transition("produce", "ready", "run_started")).toEqual({
      ok: true,
      value: "in_progress",
    });
    expect(transition("produce", "in_progress", "delivery_submitted")).toEqual({
      ok: true,
      value: "delivered",
    });
    expect(transition("produce", "delivered", "verifiers_passed")).toEqual({
      ok: true,
      value: "accepted",
    });
    expect(transition("produce", "delivered", "review_rejected")).toEqual({
      ok: true,
      value: "changes_requested",
    });
    expect(transition("verify", "todo", "target_delivered")).toEqual({
      ok: true,
      value: "ready",
    });
    expect(transition("verify", "in_progress", "review_passed")).toEqual({
      ok: true,
      value: "passed",
    });
    expect(transition("verify", "in_progress", "review_rejected")).toEqual({
      ok: true,
      value: "failed",
    });
    expect(transition("verify", "in_progress", "target_redelivered")).toEqual({
      ok: true,
      value: "ready",
    });
    expect(transition("verify", "passed", "target_withdrawn")).toEqual({
      ok: true,
      value: "todo",
    });
    expect(transition("verify", "ready", "review_limit_exceeded")).toEqual({
      ok: true,
      value: "waiting_decision",
    });
    expect(
      transition("verify", "waiting_decision", "decision_resolved"),
    ).toEqual({
      ok: true,
      value: "ready",
    });
    expect(
      transition("produce", "waiting_decision", "decision_resolved"),
    ).toEqual({
      ok: true,
      value: "in_progress",
    });
    expect(transition("run", "queued", "dispatch")).toEqual({
      ok: true,
      value: "dispatched",
    });
    expect(transition("run", "dispatched", "acknowledge")).toEqual({
      ok: true,
      value: "acked",
    });
    expect(transition("run", "acked", "start")).toEqual({
      ok: true,
      value: "running",
    });
    expect(transition("run", "running", "complete")).toEqual({
      ok: true,
      value: "completed",
    });
    expect(transition("run", "unknown", "reconnected")).toEqual({
      ok: true,
      value: "running",
    });
    expect(transition("runtime", "unknown", "declared_lost")).toEqual({
      ok: true,
      value: "lost",
    });
    expect(transition("card", "review", "completion_review_passed")).toEqual({
      ok: true,
      value: "awaiting_merge",
    });
    expect(transition("card", "review", "completion_review_rejected")).toEqual({
      ok: true,
      value: "in_progress",
    });
  });

  test("terminal states stay terminal", () => {
    for (const machine of [
      "delivery",
      "human_action",
      "assignment",
      "run",
    ] as const) {
      const terminal =
        machine === "delivery"
          ? "superseded"
          : machine === "human_action"
            ? "done"
            : machine === "assignment"
              ? "released"
              : "completed";
      for (const event of events) {
        expect(transition(machine, terminal as never, event).ok).toBe(false);
      }
    }
  });

  test("invariant 11: an illegal transition is rejected, never rewritten", () => {
    const result = transition("produce", "todo", "delivery_submitted");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe("illegal_transition");
  });
});

// ------------------------------------------------------------ invariants ---

describe("inventory of §4.5 invariants", () => {
  test("invariant 1: a role holds capabilities and permissions, not a worktree or session", () => {
    expectTypeOf<RoleReference>().toHaveProperty("allowed_tools");
    expectTypeOf<RoleReference>().not.toHaveProperty("worktree_path");
    expectTypeOf<RoleReference>().not.toHaveProperty("session_ref");
    expectTypeOf<Assignment>().toHaveProperty("worktree_path");
    expectTypeOf<Assignment>().toHaveProperty("session_ref");
  });

  test("invariant 2: assigning the same work item twice keeps one coding assignment", () => {
    const s = scenario();
    const repeated = assign(
      s.h.state,
      s.pmOfficeActor,
      { work_item_id: s.development.id, role_id: "coder" },
      s.h.ports,
    );
    const again = commit(s.h, repeated);

    expect(again.id).toBe(s.coder.id);
    // COMMANDS.md: a repeat assignment reuses the context and issues no token.
    expect(repeated.ok && repeated.value.token_requests).toEqual([]);
    const codingAssignments = s.h.state.assignments.filter(
      (a) => a.scope === "work_item" && a.work_item_id === s.development.id,
    );
    expect(codingAssignments).toHaveLength(1);
    // Two work items get two independent assignments.
    expect(s.reviewer.id).not.toBe(s.coder.id);
  });

  test("invariant 5: a rework Run reuses the assignment instead of replacing it", async () => {
    const s = scenario();
    const first = startRun(s.h, s.coder);
    const delivery = await deliver(s.h, s.coderActor, s.development.id, {
      verifiers: [s.codeReview.id],
      subject: sha("a"),
    });
    endRun(s.h, s.coderActor, first);

    const reviewRun = startRun(s.h, s.reviewer);
    commit(
      s.h,
      review(s.h, s.reviewerActor, {
        delivery_id: delivery,
        target_sha: sha("a"),
        issues: [
          {
            severity: "major",
            description: "fictional bug",
            impact: "functional" as const,
            must_fix: true,
            pre_existing: false,
          },
        ],
      }),
    );
    endRun(s.h, s.reviewerActor, reviewRun);

    const rework = startRun(s.h, s.coder, { kind: "rework" });
    expect(rework.assignment_id).toBe(s.coder.id);
    expect(
      s.h.state.assignments.filter(
        (a) => a.scope === "work_item" && a.work_item_id === s.development.id,
      ),
    ).toHaveLength(1);
  });

  test("invariant 8: only a review pass accepts work, not Run lifecycle facts", async () => {
    const s = scenario();
    const run = startRun(s.h, s.coder);
    const delivery = await deliver(s.h, s.coderActor, s.development.id, {
      verifiers: [s.codeReview.id],
      subject: sha("a"),
    });

    commit(
      s.h,
      heartbeat(s.h.state, s.coderActor, { run_id: run.id }, s.h.ports),
    );
    endRun(s.h, s.coderActor, run);

    // The Run ended, the delivery exists, but nothing has been accepted.
    expect(workItem(s.h, s.development.id).status).toBe("delivered");

    const reviewRun = startRun(s.h, s.reviewer);
    const passed = commit(
      s.h,
      review(s.h, s.reviewerActor, {
        delivery_id: delivery,
        target_sha: sha("a"),
      }),
    );
    expect(passed.verdict).toBe("pass");
    expect(workItem(s.h, s.development.id).status).toBe("accepted");
    expect(reviewRun.status).toBe("running");
  });

  test("invariant 10: a blocking decision ends the Run and work resumes with a new one", () => {
    const s = scenario();
    const run = startRun(s.h, s.coder);
    commit(
      s.h,
      requestDecision(
        s.h.state,
        s.coderActor,
        {
          card_id: s.card,
          kind: "choose",
          category: "general",
          question: "Fictional choice?",
          context: "Fictional context",
          options: [
            { key: "a", description: "Option A", impact: "none" },
            { key: "b", description: "Option B", impact: "none" },
          ],
          recommended: "a",
          affected_cards: [s.card],
          affected_work_items: [],
          blocking: true,
          decider: "human",
          plain_summary: TEST_PLAIN_SUMMARY,
        },
        s.h.ports,
      ),
    );

    // §4.4: a Run ends as `completed`; "blocked" is the outcome, not a status.
    const ended = s.h.state.runs.find((r) => r.id === run.id);
    expect(ended?.status).toBe("completed");
    expect(ended?.outcome).toBe("blocked");
    expect(workItem(s.h, s.development.id).status).toBe("waiting_decision");
    // Nothing runs while the decision is open.
    expect(
      s.h.state.runs.filter(
        (r) => r.assignment_id === s.coder.id && r.status === "running",
      ),
    ).toEqual([]);
  });

  test("invariant 11: permissions and transitions are checked by the domain", () => {
    const s = scenario();

    // The coder may not use a PM tool.
    const forbidden = createCard(
      s.h.state,
      s.coderActor,
      {
        title: "Sneaky card",
        goal: "should fail",
        acceptance_criteria: ["x"],
        source: { kind: "quote", text: "x" },
        repo: "example/repo",
        base_branch: "main",
      },
      s.h.ports,
    );
    expect(errorOf(forbidden).code).toBe("forbidden_tool");

    // Progress states cannot be set by hand.
    const manual = updateWorkItem(
      s.h.state,
      s.pmOfficeActor,
      { work_item_id: s.development.id, status: "in_progress" },
      s.h.ports,
    );
    expect(errorOf(manual).code).toBe("illegal_transition");

    // A self-declared author in the body does not change the author.
    const comment = commit(
      s.h,
      postComment(
        s.h.state,
        s.coderActor,
        { card_id: s.card, body: "author: human", mentions: [] },
        s.h.ports,
      ),
    );
    expect(comment?.author).toBe(`assignment:${s.coder.id}`);
  });

  test("invariant 11: a Run that lost its role snapshot cannot act", async () => {
    const s = scenario();
    startRun(s.h, s.coder, { role_version: 2 });
    const prepared = await prepareDelivery(
      s.h.state,
      s.coderActor,
      {
        work_item_id: s.development.id,
        kind: "code",
        summary: "fictional delivery",
        subject: { kind: "git_head", value: sha("a") },
        requested_verifiers: [s.codeReview.id],
      },
      verifier,
    );
    expect(prepared.ok).toBe(false);
    expect(prepared.ok === false && prepared.error.code).toBe(
      "invariant_violation",
    );
  });

  test("invariant 12: every Run records role version, model and CLI version", async () => {
    const s = scenario();
    const run = startRun(s.h, s.coder);
    expect(run.role_version).toBe(s.coder.role_version);
    expect(run.model).not.toBe("");
    expect(run.agent_cli_version).not.toBe("");

    const missing = startRun(s.h, s.coder, { model: "" });
    expect(() =>
      commit(
        s.h,
        heartbeat(s.h.state, s.coderActor, { run_id: missing.id }, s.h.ports),
      ),
    ).toThrow(/invariant_violation/);
  });

  test("invariant 13: the card is never done without a completion review", async () => {
    const s = scenario();
    const coderRun = startRun(s.h, s.coder);
    const delivery = await deliver(s.h, s.coderActor, s.development.id, {
      verifiers: [s.codeReview.id],
      subject: sha("a"),
    });
    endRun(s.h, s.coderActor, coderRun);

    const reviewRun = startRun(s.h, s.reviewer);
    commit(
      s.h,
      review(s.h, s.reviewerActor, {
        delivery_id: delivery,
        target_sha: sha("a"),
      }),
    );
    endRun(s.h, s.reviewerActor, reviewRun);

    // Every other required work item passed; the card still is not done.
    expect(workItem(s.h, s.development.id).status).toBe("accepted");
    expect(workItem(s.h, s.codeReview.id).status).toBe("passed");
    expect(s.h.state.cards[0]?.status).not.toBe("done");

    // Nobody can flip the card to done by hand.
    const manual = updateCard(
      s.h.state,
      s.pmOfficeActor,
      { card_id: s.card, status: "done" },
      s.h.ports,
    );
    expect(errorOf(manual).code).toBe("illegal_transition");
    // The acceptance step only exists after a completion request.
    const premature = review(s.h, s.pmAcceptanceActor, {
      delivery_id: delivery,
      target_sha: sha("a"),
      kind: "product",
    });
    expect(errorOf(premature).code).toBe("unauthorized");
    expect(s.h.state.cards[0]?.status).not.toBe("done");
  });

  test("invariant 14: a new delivery invalidates the review of the old version", async () => {
    const s = scenario();
    const coderRun = startRun(s.h, s.coder);
    const first = await deliver(s.h, s.coderActor, s.development.id, {
      verifiers: [s.codeReview.id],
      subject: sha("a"),
    });
    endRun(s.h, s.coderActor, coderRun);

    const reviewRun = startRun(s.h, s.reviewer);
    commit(
      s.h,
      review(s.h, s.reviewerActor, {
        delivery_id: first,
        target_sha: sha("a"),
        issues: [
          {
            severity: "major",
            description: "fictional bug",
            impact: "functional" as const,
            must_fix: true,
            pre_existing: false,
          },
        ],
      }),
    );
    endRun(s.h, s.reviewerActor, reviewRun);

    const reworkRun = startRun(s.h, s.coder, { kind: "rework" });
    const second = await deliver(s.h, s.coderActor, s.development.id, {
      verifiers: [s.codeReview.id],
      subject: sha("b"),
    });

    expect(s.h.state.deliveries.find((d) => d.id === first)?.status).toBe(
      "superseded",
    );
    expect(workItem(s.h, s.codeReview.id).status).toBe("ready");

    // The old review no longer satisfies the new version.
    const stale = submitReview(
      s.h.state,
      s.reviewerActor,
      {
        delivery_id: first as never,
        target_sha: sha("a"),
        kind: "code",
        issues: [],
      },
      s.h.ports,
    );
    expect(errorOf(stale).code).toBe("stale_target");
    expect(second).not.toBe(first);
    expect(reworkRun.assignment_id).toBe(s.coder.id);
  });

  test("C-615: ref_slot binds a comment's attachment-new-N to one file of its author", async () => {
    const s = scenario();
    const prepared = await prepareAttachment(
      contentDigest,
      new Uint8Array([1, 2, 3]),
      attachmentStore(),
    );
    if (!prepared.ok) throw new Error("attachment preflight failed");
    const receipt = prepared.value;
    const comment = commit(
      s.h,
      postComment(
        s.h.state,
        human,
        { card_id: s.card, body: "见 attachment-new-1", mentions: [] },
        s.h.ports,
      ),
    );
    if (!comment) throw new Error("comment missing");
    const upload = (actor: Actor, ref_slot?: number) =>
      uploadAttachment(
        s.h.state,
        actor,
        {
          card_id: s.card,
          mime: "text/plain",
          kind: "evidence",
          attach_to: { kind: "timeline_entry", id: comment.id },
          ...(ref_slot === undefined ? {} : { ref_slot }),
        },
        receipt,
        s.h.ports,
      );
    // Another file on the same comment, without a slot, takes none.
    const extra = commit(s.h, upload(human));
    const first = commit(s.h, upload(human, 1));
    expect(first.ref_slot).toBe(1);
    expect(extra.ref_slot).toBeUndefined();
    expect(
      resolvePendingAttachmentRefs(
        comment.body,
        comment,
        s.h.state.attachments,
      ),
    ).toBe(`见 ${first.id}`);
    // A slot is filled once, by an integer in range, on a comment only.
    expect(errorOf(upload(human, 1)).code).toBe("validation_failed");
    expect(errorOf(upload(human, 0)).code).toBe("validation_failed");
    expect(errorOf(upload(human, 1.5)).code).toBe("validation_failed");
    expect(errorOf(upload(human, 101)).code).toBe("validation_failed");
    // Only the comment's author fills its slots.
    const coderRun = startRun(s.h, s.coder);
    expect(errorOf(upload(s.coderActor, 2)).code).toBe("unauthorized");
    endRun(s.h, s.coderActor, coderRun);
  });

  test("invariant 14: an artifact attachment requires a decision basis", async () => {
    const s = scenario();
    // A real receipt comes from prepareAttachment (in-memory AttachmentStore).
    const content = new Uint8Array([1, 2, 3]);
    const prepared = await prepareAttachment(
      contentDigest,
      content,
      attachmentStore(),
    );
    if (!prepared.ok) throw new Error("attachment preflight failed");
    const receipt = prepared.value;

    const coderRun = startRun(s.h, s.coder);
    const delivery = await deliver(s.h, s.coderActor, s.development.id, {
      verifiers: [s.codeReview.id],
      subject: sha("a"),
    });
    endRun(s.h, s.coderActor, coderRun);

    const attachTo = { kind: "delivery" as const, id: delivery as never };
    const withoutBasis = uploadAttachment(
      s.h.state,
      s.coderActor,
      {
        card_id: s.card,
        mime: "image/png",
        kind: "artifact",
        attach_to: attachTo,
      },
      receipt,
      s.h.ports,
    );
    expect(errorOf(withoutBasis).code).toBe("validation_failed");
    expect(errorOf(withoutBasis).message).toMatch(/basis/i);

    // Contrast: the same receipt and target are accepted for evidence.
    const evidence = commit(
      s.h,
      uploadAttachment(
        s.h.state,
        s.coderActor,
        {
          card_id: s.card,
          mime: "image/png",
          kind: "evidence",
          attach_to: attachTo,
        },
        receipt,
        s.h.ports,
      ),
    );
    expect(evidence.kind).toBe("evidence");
    expect(evidence.basis).toBeUndefined();

    // And an artifact is accepted once a real decision basis exists.
    const decision = commit(
      s.h,
      requestDecision(
        s.h.state,
        s.coderActor,
        {
          card_id: s.card,
          kind: "choose",
          category: "general",
          question: "Fictional artifact basis?",
          context: "Fictional context",
          options: [
            { key: "a", description: "Option A", impact: "none" },
            { key: "b", description: "Option B", impact: "none" },
          ],
          recommended: "a",
          affected_cards: [s.card],
          affected_work_items: [],
          blocking: false,
          decider: "human",
          plain_summary: TEST_PLAIN_SUMMARY,
        },
        s.h.ports,
      ),
    );
    const artifact = commit(
      s.h,
      uploadAttachment(
        s.h.state,
        s.coderActor,
        {
          card_id: s.card,
          mime: "image/png",
          kind: "artifact",
          attach_to: attachTo,
          basis: decision.key,
        },
        receipt,
        s.h.ports,
      ),
    );
    expect(artifact.kind).toBe("artifact");
    expect(artifact.basis).toBe(decision.key);
  });
});

// --------------------------------------------------------------- end to end ---

describe("end to end: a dev card from creation to merge readiness", () => {
  test("create, assign, deliver, reject, rework, pass, completion, acceptance", async () => {
    const s = scenario();
    const { h } = s;

    expect(h.state.cards[0]?.status).toBe("todo");
    expect(workItem(h, s.development.id).status).toBe("todo");
    expect(workItem(h, s.codeReview.id).status).toBe("todo");
    expect(workItem(h, s.acceptance.id).status).toBe("todo");

    // 1. coder delivers D-1
    const coderRun = startRun(h, s.coder);
    const d1 = await deliver(h, s.coderActor, s.development.id, {
      verifiers: [s.codeReview.id],
      subject: sha("a"),
    });
    expect(workItem(h, s.development.id).status).toBe("delivered");
    expect(workItem(h, s.codeReview.id).status).toBe("ready");
    endRun(h, s.coderActor, coderRun);

    // 2. reviewer rejects D-1
    const reviewRun = startRun(h, s.reviewer);
    const rejected = commit(
      h,
      review(h, s.reviewerActor, {
        delivery_id: d1,
        target_sha: sha("a"),
        issues: [
          {
            severity: "major",
            description: "fictional bug",
            impact: "functional" as const,
            must_fix: true,
            pre_existing: false,
          },
        ],
      }),
    );
    expect(rejected.verdict).toBe("reject");
    expect(h.state.deliveries.find((d) => d.id === d1)?.status).toBe(
      "rejected",
    );
    expect(workItem(h, s.development.id).status).toBe("changes_requested");
    expect(workItem(h, s.codeReview.id).status).toBe("failed");
    endRun(h, s.reviewerActor, reviewRun);

    // 3. coder reworks and delivers D-2
    const reworkRun = startRun(h, s.coder, { kind: "rework" });
    const d2 = await deliver(h, s.coderActor, s.development.id, {
      verifiers: [s.codeReview.id],
      subject: sha("b"),
    });
    expect(d2).not.toBe(d1);
    expect(h.state.deliveries.find((d) => d.id === d1)?.status).toBe(
      "superseded",
    );
    expect(workItem(h, s.codeReview.id).status).toBe("ready");
    endRun(h, s.coderActor, reworkRun);

    // 4. reviewer passes D-2
    const secondReviewRun = startRun(h, s.reviewer);
    const passed = commit(
      h,
      review(h, s.reviewerActor, { delivery_id: d2, target_sha: sha("b") }),
    );
    expect(passed.verdict).toBe("pass");
    expect(workItem(h, s.development.id).status).toBe("accepted");
    expect(workItem(h, s.codeReview.id).status).toBe("passed");
    endRun(h, s.reviewerActor, secondReviewRun);

    // 5. completion request
    const completionRun = startRun(h, s.coder);
    const completion = await deliver(h, s.coderActor, s.development.id, {
      kind: "card_completion",
      verifiers: [s.acceptance.id],
      subject: sha("b"),
    });
    expect(h.state.cards[0]?.status).toBe("review");
    expect(workItem(h, s.acceptance.id).status).toBe("ready");
    endRun(h, s.coderActor, completionRun);

    // 6. PM acceptance
    startRun(h, s.pmAcceptance);
    const accepted = commit(
      h,
      review(h, s.pmAcceptanceActor, {
        delivery_id: completion,
        target_sha: sha("b"),
        kind: "product",
      }),
    );
    expect(accepted.verdict).toBe("pass");
    expect(workItem(h, s.acceptance.id).status).toBe("passed");
    expect(h.state.cards[0]?.status).toBe("awaiting_merge");
    expect(h.state.cards[0]?.resolution).toBeUndefined();
  });
});

// ---------------------------------------------------- decisions and limits ---

describe("decisions", () => {
  test("a blocking decision pauses work and resolution resumes it with a new Run", async () => {
    const s = scenario();
    const run = startRun(s.h, s.coder);

    const decision = commit(
      s.h,
      requestDecision(
        s.h.state,
        s.coderActor,
        {
          card_id: s.card,
          kind: "choose",
          category: "general",
          question: "Fictional choice?",
          context: "Fictional context",
          options: [
            { key: "a", description: "Option A", impact: "none" },
            { key: "b", description: "Option B", impact: "none" },
          ],
          recommended: "a",
          affected_cards: [s.card],
          affected_work_items: [],
          blocking: true,
          decider: "human",
          plain_summary: TEST_PLAIN_SUMMARY,
        },
        s.h.ports,
      ),
    );
    expect(decision.status).toBe("open");
    expect(workItem(s.h, s.development.id).status).toBe("waiting_decision");
    const endedRun = s.h.state.runs.find((r) => r.id === run.id);
    expect(endedRun?.status).toBe("completed");
    expect(endedRun?.outcome).toBe("blocked");
    expect(
      s.h.state.runs.some(
        (r) => r.assignment_id === s.coder.id && r.status === "running",
      ),
    ).toBe(false);

    // The author request is triaged by PM; the human may explicitly take it over.
    commit(
      s.h,
      recordDecision(
        s.h.state,
        human,
        {
          decision_id: decision.id,
          option: "a",
          rationale: "fictional rationale",
          raw_quote: "fictional quote",
        },
        s.h.ports,
      ),
    );

    expect(s.h.state.decisions[0]?.status).toBe("resolved");
    expect(workItem(s.h, s.development.id).status).toBe("in_progress");
    expect(
      s.h.state.runs.some(
        (r) => r.assignment_id === s.coder.id && r.status === "queued",
      ),
    ).toBe(true);

    // The resumed assignment keeps working under the same identity.
    const resumed = startRun(s.h, s.coder, { kind: "decision_resumed" });
    const delivery = await deliver(s.h, s.coderActor, s.development.id, {
      verifiers: [s.codeReview.id],
      subject: sha("a"),
    });
    expect(delivery).toBeDefined();
    expect(resumed.assignment_id).toBe(s.coder.id);
  });

  test("credential delegation needs a human authorization audit", () => {
    const s = scenario();
    seatDelegationOps(s.h);
    for (const enabled of [false, true]) {
      expect(
        setProjectPreferences(
          s.h.state,
          human,
          {
            decision_delegation: { credential: enabled },
          },
          s.h.ports,
        ).ok,
      ).toBe(true);
      // Even malformed legacy preferences cannot delegate permission.
      s.h.state = {
        ...s.h.state,
        project_preferences: [
          {
            id: project_id,
            auto_merge_after_minutes: null,
            decision_delegation: { credential: enabled },
          },
        ],
      };
      const result = requestDecision(
        s.h.state,
        s.coderActor,
        {
          card_id: s.card,
          kind: "choose",
          category: "credential",
          question: "Buy something?",
          context: "Fictional context",
          options: [
            { key: "a", description: "Option A", impact: "money" },
            { key: "b", description: "Option B", impact: "none" },
          ],
          recommended: "a",
          affected_cards: [s.card],
          affected_work_items: [],
          blocking: false,
          plain_summary: {
            changed: "测试凭据拍板",
            impact: "测试",
            risk: "无",
          },
          decider: "role:pm",
        },
        s.h.ports,
      );
      const queued = commit(s.h, result);
      expect(queued.decider).toBe("role:pm");
      expect(queued.delegation_authority).toBeUndefined();
    }
  });

  test.each(["spending", "account", "data_deletion"] as const)(
    "%s waits for PM triage, delegates only on a human grant, and loses authority on revocation",
    (category) => {
      const s = scenario();
      const ops = seatDelegationOps(s.h);
      const ask = () =>
        requestDecision(
          s.h.state,
          s.coderActor,
          {
            card_id: s.card,
            kind: "choose",
            category,
            question: "Handle this synthetic business decision?",
            context: "No execution capability is granted",
            options: [
              {
                key: "a",
                description: "Record a choice",
                impact: "Synthetic decision only",
              },
            ],
            recommended: "a",
            affected_cards: [s.card],
            affected_work_items: [],
            blocking: false,
            decider: "role:pm",
            plain_summary: TEST_PLAIN_SUMMARY,
          },
          s.h.ports,
        );
      const checkHuman = () => {
        const q = commit(s.h, ask());
        expect(q.decider).toBe("role:pm");
        expect(q.delegation_authority).toBeUndefined();
        expect(
          resolveDelegatedDecision(
            s.h.state,
            ops,
            { decision_id: q.id, option: "a", rationale: "Unapproved proxy" },
            s.h.ports,
          ).ok,
        ).toBe(false);
      };
      checkHuman();
      commit(
        s.h,
        setProjectPreferences(
          s.h.state,
          human,
          { decision_delegation: { [category]: false } },
          s.h.ports,
        ),
      );
      checkHuman();
      commit(
        s.h,
        setProjectPreferences(
          s.h.state,
          human,
          { decision_delegation: { [category]: true } },
          s.h.ports,
        ),
      );
      const grant = s.h.state.events.findLast(
        (e) => e.type === "project_preferences_updated",
      );
      const q = commit(s.h, ask());
      expect(q).toMatchObject({
        decider: "role:pm",
        delegation_authority: `project:${project_id}/decision_delegation/${category}/event:${grant?.id}`,
      });
      expect(grant?.actor).toEqual(human);
      const resolved = commit(
        s.h,
        resolveDelegatedDecision(
          s.h.state,
          ops,
          {
            decision_id: q.id,
            option: "a",
            rationale: "Within the human grant",
          },
          s.h.ports,
        ),
      );
      expect(resolved.resolution).toMatchObject({
        via: "delegated",
        resolved_by: `assignment:${ops.kind === "assignment" ? ops.assignment_id : ""}`,
        proxy_authority: q.delegation_authority,
      });
      const pending = commit(s.h, ask());
      commit(
        s.h,
        setProjectPreferences(
          s.h.state,
          human,
          { decision_delegation: { [category]: false } },
          s.h.ports,
        ),
      );
      expect(
        s.h.state.decisions.find((d) => d.id === pending.id)?.decider,
      ).toBe("role:pm");
      expect(
        resolveDelegatedDecision(
          s.h.state,
          ops,
          {
            decision_id: pending.id,
            option: "a",
            rationale: "Old authorization",
          },
          s.h.ports,
        ).ok,
      ).toBe(false);
      checkHuman();
      expect(
        s.h.state.decisions.find((d) => d.id === q.id)?.resolution,
      ).toEqual(resolved.resolution);
    },
  );

  test.each(["spending", "account", "data_deletion"] as const)(
    "%s requested for PM still needs a summary when it falls back to the human, atomically",
    (category) => {
      const s = scenario();
      startRun(s.h, s.coder);
      s.h.state = {
        ...s.h.state,
        work_items: s.h.state.work_items.map((w) =>
          w.id === s.development.id
            ? { ...w, status: "in_progress" as const }
            : w,
        ),
      };
      const before = JSON.stringify(s.h.state);
      const result = requestDecision(
        s.h.state,
        s.pmOfficeActor,
        {
          card_id: s.card,
          kind: "choose",
          category,
          question: "Handle a synthetic decision?",
          context: "No human grant and no summary",
          options: [{ key: "a", description: "Wait", impact: "No operation" }],
          recommended: "a",
          affected_cards: [s.card],
          affected_work_items: [s.development.id],
          blocking: true,
          decider: "role:pm",
        },
        s.h.ports,
      );
      expect(errorOf(result).code).toBe("validation_failed");
      expect(errorOf(result).message).toContain("plain_summary");
      expect(JSON.stringify(s.h.state)).toBe(before);
      if (result.ok) throw new Error("Missing summary must be rejected");
      expect(result).not.toHaveProperty("value");
    },
  );
});

describe("review round limit", () => {
  test("the last allowed round still rejecting pauses the verifier for a decision", async () => {
    const s = scenario();
    const limit = 3; // Third consecutive rejection, independent of the initial budget.
    expect(
      (
        workItem(s.h, s.codeReview.id) as WorkItem & {
          max_review_rounds: number;
        }
      ).max_review_rounds,
    ).toBe(5);

    const rejecting = {
      severity: "major" as const,
      description: "fictional bug",
      impact: "functional" as const,
      must_fix: true,
      pre_existing: false,
    };

    let delivery = "";
    for (let round = 1; round <= limit; round += 1) {
      const coderRun = startRun(s.h, s.coder, {
        kind: round === 1 ? "initial" : "rework",
      });
      delivery = await deliver(s.h, s.coderActor, s.development.id, {
        verifiers: [s.codeReview.id],
        subject: sha(String.fromCharCode(96 + round)),
      });
      endRun(s.h, s.coderActor, coderRun);

      const reviewRun = startRun(s.h, s.reviewer);
      commit(
        s.h,
        review(s.h, s.reviewerActor, {
          delivery_id: delivery,
          target_sha: sha(String.fromCharCode(96 + round)),
          issues: [rejecting],
        }),
      );

      if (round < limit) {
        expect(workItem(s.h, s.codeReview.id).status).toBe("failed");
        endRun(s.h, s.reviewerActor, reviewRun);
      } else {
        // The review Run ends blocked and the verifier waits for a decision.
        const ended = s.h.state.runs.find((r) => r.id === reviewRun.id);
        expect(ended?.status).toBe("completed");
        expect(ended?.outcome).toBe("blocked");
      }
    }

    expect(workItem(s.h, s.codeReview.id).status).toBe("waiting_decision");
    const decision = s.h.state.decisions.find(
      (d) => d.trigger === "review_limit",
    );
    expect(decision).toBeDefined();
    expect(decision?.blocking).toBe(true);
    expect(s.h.state.cards[0]?.status).not.toBe("done");

    // No rework Run is queued for the producer while the limit waits.
    expect(
      s.h.state.runs.filter(
        (r) =>
          r.assignment_id === s.coder.id &&
          ["queued", "running"].includes(r.status),
      ),
    ).toEqual([]);
  });
});

// --------------------------------------------- additional plan-specified rules ---

describe("blockers, human actions and Run limits", () => {
  test("report_blocker pauses the item and only a PM resume brings it back", async () => {
    const s = scenario();
    const run = startRun(s.h, s.coder);
    commit(
      s.h,
      reportBlocker(
        s.h.state,
        s.coderActor,
        {
          work_item_id: s.development.id,
          reason: "fictional blocker",
          needs: "role",
        },
        s.h.ports,
      ),
    );
    expect(workItem(s.h, s.development.id).status).toBe("blocked");
    // COMMANDS.md: "已有 Run 保持运行" — the blocker does not end the Run.
    expect(s.h.state.runs.find((r) => r.id === run.id)?.status).toBe("running");

    // Only PM/human may resume, and only from blocked to in_progress.
    expect(
      errorOf(
        updateWorkItem(
          s.h.state,
          s.coderActor,
          { work_item_id: s.development.id, status: "in_progress" },
          s.h.ports,
        ),
      ).code,
    ).toBe("forbidden_tool");

    commit(
      s.h,
      updateWorkItem(
        s.h.state,
        s.pmOfficeActor,
        { work_item_id: s.development.id, status: "in_progress" },
        s.h.ports,
      ),
    );
    expect(workItem(s.h, s.development.id).status).toBe("in_progress");
  });

  test("a human action blocks work until the human completes it", async () => {
    const s = scenario();
    startRun(s.h, s.coder);
    const action = commit(
      s.h,
      requestHumanAction(
        s.h.state,
        s.coderActor,
        {
          card_id: s.card,
          instructions: "Fictional manual step",
          why_human: "needs a credential",
          expected_return: "confirmation",
          blocks_merge: true,
          prerequisite: "external_account" as const,
          blocked_work_items: [s.development.id],
        },
        s.h.ports,
      ),
    );
    expect(workItem(s.h, s.development.id).status).toBe("blocked");

    // This unassigned action stays human-only; coder has no host completion tool.
    expect(
      errorOf(
        completeHumanAction(
          s.h.state,
          s.coderActor,
          { human_action_id: action.id, text: "done" },
          s.h.ports,
        ),
      ).code,
    ).toBe("forbidden_tool");

    commit(
      s.h,
      completeHumanAction(
        s.h.state,
        human,
        { human_action_id: action.id, text: "fictional result" },
        s.h.ports,
      ),
    );
    expect(s.h.state.human_actions[0]?.status).toBe("done");
    expect(workItem(s.h, s.development.id).status).toBe("in_progress");
    // The assignment is runnable again: either its Run kept running through the
    // blocker, or a resumed Run was queued for it.
    expect(
      s.h.state.runs.some(
        (r) =>
          r.assignment_id === s.coder.id &&
          ["running", "queued"].includes(r.status),
      ),
    ).toBe(true);
  });

  test("invariant 10: one Run submits at most one review", async () => {
    const s = scenario();
    const coderRun = startRun(s.h, s.coder);
    const delivery = await deliver(s.h, s.coderActor, s.development.id, {
      verifiers: [s.codeReview.id],
      subject: sha("a"),
    });
    endRun(s.h, s.coderActor, coderRun);

    // A conditional review leaves the delivery `submitted`, so the second call
    // reaches the one-review-per-Run rule instead of tripping over the status.
    const reviewRun = startRun(s.h, s.reviewer);
    const conditional = commit(
      s.h,
      submitReview(
        s.h.state,
        s.reviewerActor,
        {
          delivery_id: delivery as never,
          target_sha: sha("a"),
          kind: "code",
          issues: [],
          recheck_required: true,
        },
        s.h.ports,
      ),
    );
    expect(conditional.verdict).toBe("conditional");
    expect(s.h.state.deliveries.find((d) => d.id === delivery)?.status).toBe(
      "submitted",
    );

    const second = review(s.h, s.reviewerActor, {
      delivery_id: delivery,
      target_sha: sha("a"),
    });
    const error = errorOf(second);
    expect(error.code).toBe("invariant_violation");
    expect(error.message).toMatch(/one review/i);

    // A fresh Run may review the same submitted delivery again.
    endRun(s.h, s.reviewerActor, reviewRun);
    startRun(s.h, s.reviewer, { kind: "followup" });
    const passed = commit(
      s.h,
      review(s.h, s.reviewerActor, {
        delivery_id: delivery,
        target_sha: sha("a"),
      }),
    );
    expect(passed.verdict).toBe("pass");
    expect(workItem(s.h, s.codeReview.id).status).toBe("passed");
  });

  test("a delivery needs exactly one running Run", async () => {
    const s = scenario();
    const prepared = await prepareDelivery(
      s.h.state,
      s.coderActor,
      {
        work_item_id: s.development.id,
        kind: "code",
        summary: "fictional delivery",
        subject: { kind: "git_head", value: sha("a") },
        requested_verifiers: [s.codeReview.id],
      },
      verifier,
    );
    expect(prepared.ok).toBe(false);
    expect(prepared.ok === false && prepared.error.code).toBe(
      "illegal_transition",
    );
  });

  test("deliveries require every required verifier and a short summary", async () => {
    const s = scenario();
    // A second required verifier that really targets the development item.
    const extraVerifier = commit(
      s.h,
      createWorkItem(
        s.h.state,
        s.pmOfficeActor,
        {
          card_id: s.card,
          title: "Fictional second review",
          kind: "verify",
          role_id: "reviewer",
          required: true,
          completion_criteria: [],
          target_work_item_id: s.development.id,
        },
        s.h.ports,
      ),
    );

    startRun(s.h, s.coder);
    const missingVerifier = await prepareDelivery(
      s.h.state,
      s.coderActor,
      {
        work_item_id: s.development.id,
        kind: "code",
        summary: "fictional delivery",
        subject: { kind: "git_head", value: sha("a") },
        requested_verifiers: [s.codeReview.id],
      },
      verifier,
    );
    expect(missingVerifier.ok).toBe(false);
    expect(missingVerifier.ok === false && missingVerifier.error.code).toBe(
      "invariant_violation",
    );
    expect(
      missingVerifier.ok === false && missingVerifier.error.message,
    ).toMatch(/required verifiers/i);

    // Requesting both required verifiers succeeds.
    const complete = await prepareDelivery(
      s.h.state,
      s.coderActor,
      {
        work_item_id: s.development.id,
        kind: "code",
        summary: "fictional delivery",
        subject: { kind: "git_head", value: sha("a") },
        requested_verifiers: [s.codeReview.id, extraVerifier.id],
      },
      verifier,
    );
    expect(complete.ok).toBe(true);

    const longSummary = await prepareDelivery(
      s.h.state,
      s.coderActor,
      {
        work_item_id: s.development.id,
        kind: "code",
        summary: "x".repeat(161),
        subject: { kind: "git_head", value: sha("a") },
        requested_verifiers: [s.codeReview.id],
      },
      verifier,
    );
    expect(longSummary.ok).toBe(false);
    expect(longSummary.ok === false && longSummary.error.code).toBe(
      "validation_failed",
    );
  });

  test("a new completion request re-targets the acceptance step", async () => {
    const s = scenario();
    const coderRun = startRun(s.h, s.coder);
    await deliver(s.h, s.coderActor, s.development.id, {
      verifiers: [s.codeReview.id],
      subject: sha("a"),
    });
    endRun(s.h, s.coderActor, coderRun);

    const reviewRun = startRun(s.h, s.reviewer);
    const first = s.h.state.deliveries[0]?.id ?? "";
    commit(
      s.h,
      review(s.h, s.reviewerActor, {
        delivery_id: first,
        target_sha: sha("a"),
      }),
    );
    endRun(s.h, s.reviewerActor, reviewRun);

    const completionRun = startRun(s.h, s.coder);
    const c1 = await deliver(s.h, s.coderActor, s.development.id, {
      kind: "card_completion",
      verifiers: [s.acceptance.id],
      subject: sha("a"),
    });
    expect(workItem(s.h, s.acceptance.id).status).toBe("ready");

    // A second completion request supersedes the first and keeps the step ready.
    const c2 = await deliver(s.h, s.coderActor, s.development.id, {
      kind: "card_completion",
      verifiers: [s.acceptance.id],
      subject: sha("a"),
    });
    expect(c2).not.toBe(c1);
    expect(s.h.state.deliveries.find((d) => d.id === c1)?.status).toBe(
      "superseded",
    );
    expect(workItem(s.h, s.acceptance.id).status).toBe("ready");
    endRun(s.h, s.coderActor, completionRun);
  });

  test("invariant 11: another project's actor is unauthorized", () => {
    const s = scenario();
    const outsider: Actor = {
      kind: "human",
      project_id: "p-other" as ProjectId,
    };
    const result = postComment(
      s.h.state,
      outsider,
      { card_id: s.card, body: "fictional", mentions: [] },
      s.h.ports,
    );
    expect(errorOf(result).code).toBe("unauthorized");
  });

  test("invariant 11: the wrong role cannot call another role's tool", () => {
    const s = scenario();
    const result = submitReview(
      s.h.state,
      s.coderActor,
      {
        delivery_id: "D-1" as never,
        target_sha: sha("a"),
        kind: "code",
        issues: [],
      },
      s.h.ports,
    );
    expect(errorOf(result).code).toBe("forbidden_tool");
  });
});

describe("review outcomes the plan distinguishes", () => {
  test("a conditional review does not count as a required verifier pass", async () => {
    const s = scenario();
    const coderRun = startRun(s.h, s.coder);
    const delivery = await deliver(s.h, s.coderActor, s.development.id, {
      verifiers: [s.codeReview.id],
      subject: sha("a"),
    });
    endRun(s.h, s.coderActor, coderRun);

    const reviewRun = startRun(s.h, s.reviewer);
    const conditional = commit(
      s.h,
      submitReview(
        s.h.state,
        s.reviewerActor,
        {
          delivery_id: delivery as never,
          target_sha: sha("a"),
          kind: "code",
          issues: [],
          recheck_required: true,
        },
        s.h.ports,
      ),
    );

    expect(conditional.verdict).toBe("conditional");
    expect(s.h.state.deliveries.find((d) => d.id === delivery)?.status).toBe(
      "submitted",
    );
    expect(workItem(s.h, s.development.id).status).toBe("delivered");
    expect(workItem(s.h, s.codeReview.id).status).not.toBe("passed");
    expect(reviewRun.id).toBeDefined();
  });

  test("the review limit cannot be bypassed with a fresh Run", async () => {
    const s = scenario();
    const rejecting = {
      severity: "major" as const,
      description: "fictional bug",
      impact: "functional" as const,
      must_fix: true,
      pre_existing: false,
    };

    for (let round = 1; round <= 3; round += 1) {
      const coderRun = startRun(s.h, s.coder, {
        kind: round === 1 ? "initial" : "rework",
      });
      const delivery = await deliver(s.h, s.coderActor, s.development.id, {
        verifiers: [s.codeReview.id],
        subject: sha(String.fromCharCode(96 + round)),
      });
      endRun(s.h, s.coderActor, coderRun);
      const reviewRun = startRun(s.h, s.reviewer);
      commit(
        s.h,
        review(s.h, s.reviewerActor, {
          delivery_id: delivery,
          target_sha: sha(String.fromCharCode(96 + round)),
          issues: [rejecting],
        }),
      );
      if (round < 3) endRun(s.h, s.reviewerActor, reviewRun);
    }
    expect(workItem(s.h, s.codeReview.id).status).toBe("waiting_decision");

    // A new Run does not reset the budget.
    startRun(s.h, s.reviewer, { kind: "followup" });
    const bypass = review(s.h, s.reviewerActor, {
      delivery_id:
        s.h.state.deliveries.filter((d) => d.kind === "code").at(-1)?.id ?? "",
      target_sha: sha("c"),
    });
    expect(errorOf(bypass).code).toBe("illegal_transition");

    // A later delivery keeps waiting on the same limit decision (no duplicate).
    const coderRun = startRun(s.h, s.coder, { kind: "rework" });
    await deliver(s.h, s.coderActor, s.development.id, {
      verifiers: [s.codeReview.id],
      subject: sha("f"),
    });
    endRun(s.h, s.coderActor, coderRun);

    expect(workItem(s.h, s.codeReview.id).status).toBe("waiting_decision");
    expect(
      s.h.state.decisions.filter((d) => d.trigger === "review_limit"),
    ).toHaveLength(1);
  });
});

describe("PM tool boundaries and decision recording", () => {
  /** A non-blocking decision the office can record. */
  function openDecision(s: Scenario): { readonly id: string } {
    return commit(
      s.h,
      requestDecision(
        s.h.state,
        s.pmOfficeActor,
        {
          card_id: s.card,
          kind: "choose",
          category: "general",
          question: "Fictional recorded decision?",
          context: "Fictional context",
          options: [
            { key: "a", description: "Option A", impact: "none" },
            { key: "b", description: "Option B", impact: "none" },
          ],
          recommended: "a",
          affected_cards: [s.card],
          affected_work_items: [],
          blocking: false,
          decider: "human",
          plain_summary: TEST_PLAIN_SUMMARY,
        },
        s.h.ports,
      ),
    );
  }

  test("record_decision is only for the standing PM Office", () => {
    const s = scenario();
    const decision = openDecision(s);

    // A work-item PM assignment cannot record decisions, even with the tool.
    const workItemPm = recordDecision(
      s.h.state,
      s.pmAcceptanceActor,
      {
        decision_id: decision.id as never,
        option: "a",
        rationale: "fictional rationale",
        raw_quote: "fictional quote",
      },
      s.h.ports,
    );
    expect(errorOf(workItemPm).code).toBe("forbidden_tool");

    // A standing PM Ops assignment whose token lacks the tool is refused too.
    const ops = seatStandingPm(s.h);
    const opsActor = actorFor(
      s.h,
      ops.id,
      "pm",
      pmTools.filter((tool) => tool !== "record_decision"),
    );
    const byOps = recordDecision(
      s.h.state,
      opsActor,
      {
        decision_id: decision.id as never,
        option: "a",
        rationale: "fictional rationale",
        raw_quote: "fictional quote",
      },
      s.h.ports,
    );
    expect(errorOf(byOps).code).toBe("forbidden_tool");

    // The Office records it with the original words.
    const recorded = commit(
      s.h,
      recordDecision(
        s.h.state,
        s.pmOfficeActor,
        {
          decision_id: decision.id as never,
          option: "a",
          rationale: "fictional rationale",
          raw_quote: "fictional quote",
        },
        s.h.ports,
      ),
    );
    expect(recorded.status).toBe("resolved");
    expect(recorded.resolution?.raw_quote).toBe("fictional quote");
    // The decider is the human; the Office only records the words.
    expect(recorded.resolution?.resolved_by).toBe("human");
  });

  test("record_decision requires the human's original words", () => {
    const s = scenario();
    const decision = openDecision(s);
    const missing = recordDecision(
      s.h.state,
      s.pmOfficeActor,
      {
        decision_id: decision.id as never,
        option: "a",
        rationale: "fictional rationale",
        raw_quote: "   ",
      },
      s.h.ports,
    );
    expect(errorOf(missing).code).toBe("validation_failed");
    expect(s.h.state.decisions[0]?.status).toBe("open");
  });

  test("PM tools stay PM-only even when the role and token allow them", () => {
    const s = scenario();
    const widened: readonly ToolName[] = [
      ...coderTools,
      "create_card",
      "update_card",
      "create_work_item",
      "assign",
    ];
    s.h.state = {
      ...s.h.state,
      roles: s.h.state.roles.map((role) =>
        role.role_id === "coder"
          ? { ...role, allowed_tools: [...widened] }
          : role,
      ),
    };
    const coder = actorFor(s.h, s.coder.id, "coder", widened);

    const card = createCard(
      s.h.state,
      coder,
      {
        title: "Fictional card",
        goal: "should be refused",
        acceptance_criteria: ["x"],
        source: { kind: "quote", text: "x" },
        repo: "example/repo",
        base_branch: "main",
      },
      s.h.ports,
    );
    expect(errorOf(card).code).toBe("forbidden_tool");
    expect(errorOf(card).message).toMatch(/PM or the human/i);

    const assignment = assign(
      s.h.state,
      coder,
      { work_item_id: s.development.id, role_id: "coder" },
      s.h.ports,
    );
    expect(errorOf(assignment).code).toBe("forbidden_tool");
    expect(errorOf(assignment).message).toMatch(/PM or the human/i);
  });

  test("§4.4: two blockers on one work item must both clear before it resumes", () => {
    // Development plan §4.4: "只有剩余轮次大于零且无其他 open / provisional
    // 阻塞 Decision、open HumanAction，才经 decision_resolved 回到 ready ...
    // 多个阻塞由最后解除者触发恢复" — so two blockers on one work item must
    // both clear before it resumes.
    const s = scenario();
    startRun(s.h, s.coder);

    commit(
      s.h,
      requestHumanAction(
        s.h.state,
        s.coderActor,
        {
          card_id: s.card,
          instructions: "Fictional manual step",
          why_human: "needs a credential",
          expected_return: "confirmation",
          blocks_merge: true,
          prerequisite: "external_account" as const,
          blocked_work_items: [s.development.id],
        },
        s.h.ports,
      ),
    );
    expect(workItem(s.h, s.development.id).status).toBe("blocked");

    const decision = commit(
      s.h,
      requestDecision(
        s.h.state,
        s.coderActor,
        {
          card_id: s.card,
          kind: "choose",
          category: "general",
          question: "Fictional stacked decision?",
          context: "Fictional context",
          options: [
            { key: "a", description: "Option A", impact: "none" },
            { key: "b", description: "Option B", impact: "none" },
          ],
          recommended: "a",
          affected_cards: [s.card],
          affected_work_items: [s.development.id],
          blocking: true,
          decider: "human",
          plain_summary: TEST_PLAIN_SUMMARY,
        },
        s.h.ports,
      ),
    );

    // Clearing only the human action leaves the decision blocking the item.
    const action = s.h.state.human_actions[0];
    if (action === undefined) throw new Error("no human action");
    commit(
      s.h,
      completeHumanAction(
        s.h.state,
        human,
        { human_action_id: action.id, text: "done" },
        s.h.ports,
      ),
    );
    expect(workItem(s.h, s.development.id).status).not.toBe("in_progress");

    // Clearing the decision resumes it.
    commit(
      s.h,
      recordDecision(
        s.h.state,
        human,
        {
          decision_id: decision.id as never,
          option: "a",
          rationale: "fictional rationale",
          raw_quote: "fictional quote",
        },
        s.h.ports,
      ),
    );
    expect(workItem(s.h, s.development.id).status).toBe("in_progress");
  });
});
