/**
 * M4.T1 cross-acceptance for M4.1 (`feat/m4-domain-merge`, #92/#93).
 *
 * Oracles: docs/plans/phase-1-m4.md §3.8 and §4 (M4.1), development plan §4.4,
 * §4.5 (invariants 13, 14) and §12.5–§12.6. Only public interfaces are used:
 * the domain commands, the transition table, the Store and the real command
 * runner from `@cardigan/mcp-server`. Cards, work items and their Assignments
 * are created through `createCard` / `assign`; Runs go through `queueRun`,
 * `dispatchRun`, `acknowledgeRun` and `finishRun`, so no test writes a card,
 * work item, assignment or run row by hand.
 *
 * The only bootstrap write is the standing PM Assignment: no domain command
 * creates one (the CLI documents it as project bootstrap data, like the project
 * row), so the release tests seat Office/Ops the way `cardigan pm create` does.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Actor,
  Assignment,
  Card,
  CardId,
  CardTemplate,
  CommandEffect,
  CommandPorts,
  CommandState,
  Decision,
  Delivery,
  DeliveryVerifier,
  Result,
  RoleReference,
  Run,
  ToolName,
  WorkItem,
} from "@cardigan/domain";
import {
  acknowledgeRun,
  assign,
  createCard,
  createWorkItem,
  developmentCardTemplate,
  dispatchRun,
  expireMergeSnoozes,
  finishRun,
  mergePlan,
  prepareDelivery,
  queueRun,
  recordDecision,
  recordMergeResult,
  releaseAssignment,
  requestDecision,
  requestMerge,
  requestWorktreeCleanup,
  resolveDelegatedDecision,
  setProjectPreferences,
  submitDelivery,
  submitReview,
  transition,
  updateCard,
} from "@cardigan/domain";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import { routeEvent } from "@cardigan/router";
import { Store, writeRole } from "@cardigan/store";
import { afterEach, beforeEach, expect, test } from "vitest";
import { main } from "./index.js";
import type { CliIo } from "./io.js";

const TEST_PLAIN_SUMMARY = {
  changed: "测试用的改动说明",
  impact: "测试用的影响说明",
  risk: "无",
};

const project = "p-m4t1";
const human: Actor = { kind: "human", project_id: project };
const system: Actor = { kind: "system", project_id: project };
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const BASE = "1".repeat(40);

const pmTools: readonly ToolName[] = [
  "create_card",
  "update_card",
  "create_work_item",
  "assign",
  "release_assignment",
  "record_decision",
  "resolve_delegated_decision",
  "submit_review",
  "finish_run",
];
const opsTools = pmTools.filter((tool) => tool !== "record_decision");
const coderTools: readonly ToolName[] = [
  "submit_delivery",
  "request_decision",
  "finish_run",
];
const reviewerTools: readonly ToolName[] = ["submit_review", "finish_run"];

/** The adapter would check Git; M4.1 tests only exercise the state machine. */
const verifier: DeliveryVerifier = {
  verify: async () => ({ ok: true, value: [] }),
};

interface Scenario {
  readonly card: Card;
  readonly development: WorkItem;
  readonly codeReview: WorkItem;
  readonly acceptance: WorkItem;
  readonly coder: Assignment;
  readonly reviewer: Assignment;
  readonly pmAcceptance: Assignment;
  readonly office: Assignment;
  readonly ops: Assignment;
}

interface Harness {
  readonly dataDir: string;
  readonly store: Store;
  readonly clock: { now(): string };
  close(): void;
}

let h: Harness;

function harness(): Harness {
  const dataDir = mkdtempSync(join(tmpdir(), "cardigan-m4t1-"));
  const time = Date.parse("2030-01-01T00:00:00.000Z");
  const clock = { now: () => new Date(time).toISOString() };
  const store = Store.open({ dataDir, clock });
  store.createProject({ id: project, name: "M4.T1" });
  for (const [role_id, tools] of [
    ["pm", pmTools],
    ["coder", coderTools],
    ["reviewer", reviewerTools],
  ] as const)
    store.uow.run((tx) =>
      writeRole(
        tx,
        project,
        {
          role_id,
          version: 1,
          display_name: role_id,
          kind: "work",
          core_prompt: `You are the ${role_id}.`,
          harness: "pi",
          launch_profile_ref: "fixture",
          allowed_tools: [...tools] as never,
          capabilities: [],
          abilities: [],
          worktree: role_id === "coder" ? "write" : "none",
          required_machine_tags: [],
        },
        { mode: "add" },
      ),
    );
  return {
    dataDir,
    store,
    clock,
    close: () => {
      store.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

beforeEach(() => {
  h = harness();
});
afterEach(() => h.close());

const ports = (tx: { readonly ids: CommandPorts["ids"] }): CommandPorts => ({
  clock: h.clock,
  ids: tx.ids,
});

/** Run one command without persisting: used for allowed-path assertions. */
function attempt<T>(
  reduce: (
    state: CommandState,
    actor: Actor,
    ports: CommandPorts,
  ) => Result<CommandEffect<T>>,
  actor: Actor = human,
): Result<CommandEffect<T>> {
  return h.store.uow.run((tx) =>
    reduce(loadCommandState(tx, project), actor, ports(tx)),
  );
}

/** Run one command and persist its effect. */
function apply<T>(
  reduce: (
    state: CommandState,
    actor: Actor,
    ports: CommandPorts,
  ) => Result<CommandEffect<T>>,
  actor: Actor = human,
): T {
  return h.store.uow.run((tx) => {
    const effect = unwrap(
      reduce(loadCommandState(tx, project), actor, ports(tx)),
    );
    persistEffect(tx, project, effect);
    return effect.data;
  });
}

/** The rejection a command must produce; fails the test if it succeeds. */
function reject<T>(
  reduce: (
    state: CommandState,
    actor: Actor,
    ports: CommandPorts,
  ) => Result<CommandEffect<T>>,
  actor: Actor = human,
) {
  const result = attempt(reduce, actor);
  if (result.ok) throw new Error("expected a rejection, got success");
  return result.error;
}

const state = (): CommandState =>
  h.store.uow.read((tx) => loadCommandState(tx, project));

const roleOf = (assignment: Assignment): RoleReference => {
  const role = h.store.uow.read((tx) =>
    tx.roles.get(project, {
      role_id: assignment.role_id,
      role_version: assignment.role_version,
    }),
  );
  if (role === undefined) throw new Error("missing role");
  return role;
};

/** The Assignment actor its token would produce; `tools` narrows it (PM Ops). */
const actorFor = (
  assignment: Assignment,
  tools: readonly ToolName[] = roleOf(assignment).allowed_tools,
): Actor =>
  ({
    kind: "assignment",
    project_id: project,
    assignment_id: assignment.id,
    role_id: assignment.role_id,
    role_version: assignment.role_version,
    allowed_tools: [...tools],
    capabilities: [],
  }) as never;

const item = (id: WorkItem["id"]): WorkItem => {
  const work = state().work_items.find((w) => w.id === id);
  if (work === undefined) throw new Error(`missing work item ${id}`);
  return work;
};
const card = (id: CardId): Card => {
  const found = state().cards.find((c) => c.id === id);
  if (found === undefined) throw new Error(`missing card ${id}`);
  return found;
};

/** A CLI IO that records nothing: `pm create` only needs the data directory. */
const cliIo = (): CliIo => ({
  env: { CARDIGAN_DATA_DIR: h.dataDir, CARDIGAN_PROJECT: project },
  cwd: h.dataDir,
  platform: "linux",
  stdout: () => undefined,
  stderr: () => undefined,
  signals: { on: () => undefined, off: () => undefined },
  spawnInherit: () => {
    throw new Error("pm create must not spawn");
  },
  captureCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
});

/**
 * The two standing PM Assignments (§7.1). They are project bootstrap data with
 * no domain command, so the test seats them through the public CLI command the
 * user runs (`cardigan pm create --office|--ops`), never by writing a row.
 */
async function seatStanding(office: boolean): Promise<Assignment> {
  const code = await main(
    [
      "pm",
      "create",
      office ? "--office" : "--ops",
      "--project",
      project,
      "--data-dir",
      h.dataDir,
    ],
    cliIo(),
  );
  if (code !== 0) throw new Error(`pm create exited ${code}`);
  const standing = h.store.uow.run((tx) =>
    tx.assignments.list(project).find(
      (a) =>
        a.scope === "standing" &&
        a.role_id === "pm" &&
        a.status === "active" &&
        // The token scope is the only place Office and Ops differ (M3).
        (
          tx.tokensForAssignment(project, a.id).at(-1)?.allowed_tools ?? []
        ).includes("record_decision") === office,
    ),
  );
  if (standing === undefined) throw new Error("pm create did not seat a PM");
  return standing;
}

async function scenario(
  policy: "confirm" | "auto" = "confirm",
): Promise<Scenario> {
  const office = await seatStanding(true);
  const ops = await seatStanding(false);
  // C-49 defaults merge confirmation to PM Ops; this suite covers the human path.
  apply(
    (s, a, p) =>
      setProjectPreferences(s, a, { pm_merge_confirmation: false }, p),
    human,
  );
  const templates: readonly CardTemplate[] = [
    { ...developmentCardTemplate, merge: policy },
  ];
  const created = apply(
    (s, a, p) =>
      createCard(
        s,
        a,
        {
          title: "M4.T1 card",
          goal: "prove the merge gate",
          acceptance_criteria: ["merged"],
          source: { kind: "quote", text: "fixture" },
          repo: "example/repo",
          base_branch: "main",
        },
        { ...p, templates },
      ),
    human,
  );
  const items = state().work_items.filter((w) => w.card_id === created.id);
  const development = items.find((w) => w.kind === "produce");
  const codeReview = items.find(
    (w) => w.kind === "verify" && w.target_work_item_id === development?.id,
  );
  const acceptance = items.find(
    (w) => w.kind === "verify" && w.target_work_item_id === undefined,
  );
  if (!development || !codeReview || !acceptance)
    throw new Error("dev template items missing");
  const assignOne = (work: WorkItem, role_id: string) =>
    apply(
      (s, a, p) => assign(s, a, { work_item_id: work.id, role_id }, p),
      human,
    );
  return {
    card: created,
    development,
    codeReview,
    acceptance,
    coder: assignOne(development, "coder"),
    reviewer: assignOne(codeReview, "reviewer"),
    pmAcceptance: assignOne(acceptance, "pm"),
    office,
    ops,
  };
}

interface RunOptions {
  readonly worktree?: { readonly path: string; readonly branch: string };
}
/** queueRun → dispatchRun → acknowledgeRun: one live, running Run. */
function startRun(assignment: Assignment, options: RunOptions = {}) {
  const run = apply(
    (s, a, p) =>
      queueRun(
        s,
        a,
        {
          assignment_id: assignment.id,
          model: "fixture-model",
          agent_cli_version: "pi 1.5.0",
        },
        p,
      ),
    human,
  );
  apply(
    (s, a, p) =>
      dispatchRun(
        s,
        a,
        {
          run_id: run.id,
          runtime_ref: {
            machine_id: "local",
            runtime_machine: "local",
            terminal_ref: `t-${assignment.id}`,
            agent_name: `agent-${assignment.id}`,
            ...(options.worktree === undefined
              ? {}
              : {
                  worktree_path: options.worktree.path,
                  branch: options.worktree.branch,
                }),
          },
          ...(options.worktree === undefined ? {} : { base_sha: BASE }),
        },
        p,
      ),
    human,
  );
  return apply(
    (s, a, p) => acknowledgeRun(s, a, { run_id: run.id }, p),
    actorFor(assignment),
  );
}

function endRun(assignment: Assignment): Run {
  const run = state()
    .runs.filter(
      (candidate) =>
        candidate.assignment_id === assignment.id &&
        !["completed", "failed", "cancelled"].includes(candidate.status),
    )
    .at(-1);
  if (run === undefined) throw new Error("missing run");
  return apply(
    (s, a, p) =>
      finishRun(
        s,
        a,
        { run_id: run.id, outcome: "completed", summary: "fixture done" },
        p,
      ),
    actorFor(assignment),
  );
}

interface DeliveryInput {
  readonly kind?: "code" | "card_completion";
  readonly subject: string;
  readonly subject_kind?: "git_head" | "doc_version";
  readonly verifiers: readonly WorkItem["id"][];
  readonly known_gaps?: readonly {
    readonly description: string;
    readonly followup_card_id: CardId;
    readonly precondition: string;
  }[];
}
async function deliver(
  assignment: Assignment,
  workItemId: WorkItem["id"],
  input: DeliveryInput,
): Promise<Delivery> {
  const actor = actorFor(assignment),
    params = {
      work_item_id: workItemId,
      kind: input.kind ?? ("code" as const),
      summary: `fixture ${input.kind ?? "code"}`,
      subject: {
        kind: input.subject_kind ?? ("git_head" as const),
        value: input.subject,
      },
      requested_verifiers: [...input.verifiers],
      ...(input.kind === "card_completion"
        ? { plain_summary: TEST_PLAIN_SUMMARY }
        : {}),
      ...(input.known_gaps === undefined
        ? {}
        : { known_gaps: [...input.known_gaps] }),
    },
    prepared = await prepareDelivery(state(), actor, params, verifier);
  if (!prepared.ok)
    throw new Error(
      `prepare failed ${prepared.error.code}: ${prepared.error.message}`,
    );
  return h.store.uow.run((tx) => {
    const effect = unwrap(
      submitDelivery(
        loadCommandState(tx, project),
        actor,
        params,
        prepared.value,
        ports(tx),
      ),
    );
    persistEffect(tx, project, effect);
    return effect.data;
  });
}

const reviewParams = (
  delivery: Delivery,
  target_sha: string,
  kind: "code" | "product" = "code",
) => ({
  delivery_id: delivery.id,
  target_sha,
  kind,
  issues: [],
});

function review(
  assignment: Assignment,
  delivery: Delivery,
  target_sha: string,
  kind: "code" | "product" = "code",
) {
  return apply(
    (s, a, p) =>
      submitReview(s, a, reviewParams(delivery, target_sha, kind), p),
    actorFor(assignment),
  );
}

function reviewRejection(
  assignment: Assignment,
  delivery: Delivery,
  target_sha: string,
  kind: "code" | "product" = "code",
) {
  return reject(
    (s, a, p) =>
      submitReview(s, a, reviewParams(delivery, target_sha, kind), p),
    actorFor(assignment),
  );
}

const decide = (decision: Decision, option: string) =>
  apply(
    (s, a, p) =>
      recordDecision(
        s,
        a,
        {
          decision_id: decision.id,
          option,
          rationale: "fixture rationale",
          raw_quote: `fixture ${option}`,
        },
        p,
      ),
    human,
  );

/** Drive one card to awaiting_merge with an accepted Git delivery and completion. */
async function acceptThroughMergeGate(s: Scenario, subject = SHA_A) {
  startRun(s.coder, {
    worktree: {
      path: `/tmp/cardigan-m4t1/${s.coder.id}`,
      branch: "agent/C-1/W-1",
    },
  });
  const product = await deliver(s.coder, s.development.id, {
    subject,
    verifiers: [s.codeReview.id],
  });
  endRun(s.coder);
  startRun(s.reviewer);
  review(s.reviewer, product, subject);
  endRun(s.reviewer);
  startRun(s.coder);
  const completion = await deliver(s.coder, s.development.id, {
    kind: "card_completion",
    subject,
    verifiers: [s.acceptance.id],
  });
  endRun(s.coder);
  startRun(s.pmAcceptance);
  review(s.pmAcceptance, completion, subject, "product");
  endRun(s.pmAcceptance);
  return { product, completion };
}

const confirmations = (id: CardId) =>
  state().decisions.filter(
    (q) => q.card_id === id && q.trigger === "merge_confirmation",
  );

// ------------------------------------------------------- §4.4 migrations ---

test("§3.8 every new card, produce and verify migration is allowed exactly where the plan says", () => {
  for (const [machine, from, event, to] of [
    ["card", "review", "completion_review_passed", "awaiting_merge"],
    ["card", "awaiting_merge", "merge_not_required", "done"],
    ["card", "awaiting_merge", "merge_succeeded", "done"],
    ["card", "awaiting_merge", "merge_conflicted", "in_progress"],
    ["card", "awaiting_merge", "cancel", "cancelled"],
    ["produce", "accepted", "merge_conflicted", "changes_requested"],
    ["verify", "passed", "target_withdrawn", "todo"],
    ["verify", "ready", "target_withdrawn", "todo"],
    ["verify", "in_progress", "target_withdrawn", "todo"],
  ] as const) {
    const result = transition(machine as never, from as never, event);
    expect(result.ok && result.value).toBe(to);
  }
  for (const [machine, from, event] of [
    // enter awaiting_merge only from review
    ["card", "in_progress", "completion_review_passed"],
    ["card", "awaiting_merge", "completion_review_passed"],
    // done only through the merge verdict or no-merge-needed
    ["card", "done", "merge_succeeded"],
    ["card", "cancelled", "merge_succeeded"],
    ["card", "awaiting_merge", "completion_review_rejected"],
    // a conflict reopens; it never finishes
    ["card", "done", "merge_conflicted"],
    ["produce", "delivered", "merge_conflicted"],
    ["produce", "in_progress", "merge_conflicted"],
    // a cancelled verification item is not silently reopened by a withdrawal
    ["verify", "todo", "target_withdrawn"],
    ["verify", "cancelled", "target_withdrawn"],
  ] as const)
    expect(
      transition(machine as never, from as never, event).ok,
      `${machine} ${from} ${event}`,
    ).toBe(false);
});

test("§12.5 confirm: an unconfirmed merge is impossible until the human merges, and hold reopens at expiry", async () => {
  const s = await scenario("confirm");
  const { completion } = await acceptThroughMergeGate(s);

  expect(card(s.card.id).status).toBe("awaiting_merge");
  expect(card(s.card.id).resolution).toBeUndefined();
  const [first] = confirmations(s.card.id);
  expect(first).toMatchObject({
    trigger: "merge_confirmation",
    status: "open",
    decider: "human",
    plain_summary: TEST_PLAIN_SUMMARY,
    blocking: true,
  });
  expect(first?.options.map((o) => o.key).sort()).toEqual([
    "hold",
    "merge",
    "request_changes",
  ]);
  // Confirm policy: not confirmed ⇒ no plan, no merge result.
  expect(mergePlan(state(), s.card.id).ok).toBe(false);
  expect(
    reject(
      (st, a, p) =>
        recordMergeResult(
          st,
          a,
          {
            card_id: s.card.id,
            completion_id: completion.id,
            result: { kind: "merged", merge_sha: SHA_B, previous_sha: SHA_A },
          },
          p,
        ),
      system,
    ).code,
  ).toBe("illegal_transition");
  expect(card(s.card.id).status).toBe("awaiting_merge");

  if (first === undefined) throw new Error("missing confirmation");
  decide(first, "hold");
  expect(mergePlan(state(), s.card.id).ok).toBe(false);
  // §4: PM Ops may re-request a held merge; a work Assignment may not.
  expect(
    reject(
      (st, a, p) => requestMerge(st, a, { card_id: s.card.id }, p),
      actorFor(s.coder),
    ).code,
  ).toBe("unauthorized");
  const held = confirmations(s.card.id).find((q) => q.id === first.id);
  if (!held?.snooze) throw new Error("Missing snooze");
  const until = held.snooze.until;
  const [requested] = apply(
    (st, a, p) =>
      expireMergeSnoozes(st, a, { ...p, clock: { now: () => until } }),
    system,
  );
  if (!requested) throw new Error("Missing reopened confirmation");
  expect(confirmations(s.card.id)).toHaveLength(1);
  expect(requested.id).toBe(first.id);
  expect(requested.status).toBe("open");
  decide(requested, "merge");
  const plan = mergePlan(state(), s.card.id);
  if (!plan.ok) throw new Error(plan.error.message);
  expect(plan.value).toMatchObject({
    card_id: s.card.id,
    base_branch: "main",
    completion_id: completion.id,
  });
  expect(plan.value.deliveries).toHaveLength(1);
  expect(plan.value.deliveries[0]?.work_item_id).toBe(s.development.id);
  // Only the human (or PM Ops) may request a re-merge; a work Assignment may not.
});

test("§3.8 an auto-policy card needs no confirmation", async () => {
  const s = await scenario("auto");
  await acceptThroughMergeGate(s);
  expect(card(s.card.id).status).toBe("awaiting_merge");
  expect(confirmations(s.card.id)).toHaveLength(0);
  expect(mergePlan(state(), s.card.id).ok).toBe(true);
});

test("invariant 13: a card without any Git delivery needs no merge and the completion review completes it", async () => {
  const s = await scenario();
  startRun(s.coder);
  const product = await deliver(s.coder, s.development.id, {
    subject: "doc-v1",
    subject_kind: "doc_version",
    verifiers: [s.codeReview.id],
  });
  endRun(s.coder);
  startRun(s.reviewer);
  review(s.reviewer, product, "doc-v1");
  endRun(s.reviewer);
  startRun(s.coder);
  const completion = await deliver(s.coder, s.development.id, {
    kind: "card_completion",
    subject: "doc-v1",
    subject_kind: "doc_version",
    verifiers: [s.acceptance.id],
  });
  endRun(s.coder);
  expect(card(s.card.id).status).toBe("review");
  startRun(s.pmAcceptance);
  review(s.pmAcceptance, completion, "doc-v1", "product");

  expect(card(s.card.id)).toMatchObject({ status: "done", resolution: "done" });
  expect(confirmations(s.card.id)).toHaveLength(0);
  expect(
    state().events.filter(
      (event) => event.type === "card_merged" || event.type === "merge_failed",
    ),
  ).toHaveLength(0);
});

test("§12.5 a known-gap work item is left out of the merge plan", async () => {
  const s = await scenario();
  const followup = apply(
    (st, a, p) =>
      createCard(
        st,
        a,
        {
          title: "Follow-up",
          goal: "carry the gap",
          acceptance_criteria: ["tracked"],
          source: { kind: "quote", text: "fixture" },
          repo: "example/repo",
          base_branch: "main",
          priority: 2,
        },
        p,
      ),
    human,
  );
  // A second, required produce item whose delivery is rejected and deferred.
  const extra = apply(
    (st, a, p) =>
      createWorkItem(
        st,
        a,
        {
          card_id: s.card.id,
          title: "Deferred part",
          kind: "produce",
          role_id: "coder",
          required: true,
          completion_criteria: [],
        },
        p,
      ),
    human,
  );
  const extraCheck = apply(
    (st, a, p) =>
      createWorkItem(
        st,
        a,
        {
          card_id: s.card.id,
          title: "Deferred review",
          kind: "verify",
          role_id: "reviewer",
          required: true,
          completion_criteria: [],
          target_work_item_id: extra.id,
        },
        p,
      ),
    human,
  );
  const extraCoder = apply(
    (st, a, p) =>
      assign(st, a, { work_item_id: extra.id, role_id: "coder" }, p),
    human,
  );
  const extraReviewer = apply(
    (st, a, p) =>
      assign(st, a, { work_item_id: extraCheck.id, role_id: "reviewer" }, p),
    human,
  );
  startRun(extraCoder);
  const rejected = await deliver(extraCoder, extra.id, {
    subject: SHA_B,
    verifiers: [extraCheck.id],
  });
  endRun(extraCoder);
  startRun(extraReviewer);
  apply(
    (st, a, p) =>
      submitReview(
        st,
        a,
        {
          delivery_id: rejected.id,
          target_sha: SHA_B,
          kind: "code",
          issues: [
            {
              severity: "major",
              description: "not acceptable yet",
              must_fix: true,
              pre_existing: false,
            },
          ],
        },
        p,
      ),
    actorFor(extraReviewer),
  );
  endRun(extraReviewer);
  expect(item(extra.id).status).toBe("changes_requested");
  expect(item(extraCheck.id).status).toBe("failed");

  // The primary item is delivered and accepted; the deferred one is a known gap.
  startRun(s.coder);
  const product = await deliver(s.coder, s.development.id, {
    subject: SHA_A,
    verifiers: [s.codeReview.id],
  });
  endRun(s.coder);
  startRun(s.reviewer);
  review(s.reviewer, product, SHA_A);
  endRun(s.reviewer);
  startRun(s.coder);
  const completion = await deliver(s.coder, s.development.id, {
    kind: "card_completion",
    subject: SHA_A,
    verifiers: [s.acceptance.id],
    known_gaps: [
      {
        description: "deferred to its own card",
        followup_card_id: followup.id,
        precondition: `work_item:${extra.id}`,
      },
      {
        description: "deferred review follows the rework",
        followup_card_id: followup.id,
        precondition: `work_item:${extraCheck.id}`,
      },
    ],
  });
  endRun(s.coder);
  startRun(s.pmAcceptance);
  review(s.pmAcceptance, completion, SHA_A, "product");
  const pending = confirmations(s.card.id)[0];
  if (pending === undefined) throw new Error("missing confirmation");

  // C-264 / Q-440: a known gap cannot waive ordinary confirmation checks.
  const confirmation = {
    decision_id: pending.id,
    option: "merge",
    rationale: "fixture rationale",
    raw_quote: "fixture merge",
  };
  const rejectedReview = state().reviews.find(
    (r) => r.delivery_id === rejected.id,
  );
  if (!rejectedReview) throw new Error("missing rejected review");
  const blockers = [
    `Deferred review（${extraCheck.id}）：未通过当前交付审核`,
    `审核 ${rejectedReview.id}：有未处理的必须修复项`,
  ];
  expect(
    reject((st, a, p) => recordDecision(st, a, confirmation, p), human),
  ).toMatchObject({
    code: "illegal_transition",
    details: { merge_blockers: blockers },
  });
  expect(confirmations(s.card.id)[0]?.status).toBe("open");

  const reason = "已确认遗留由后续卡处理，本次只合并已验收的交付";
  const confirmed = apply(
    (st, a, p) =>
      recordDecision(
        st,
        a,
        { ...confirmation, merge_override_reason: reason },
        p,
      ),
    human,
  );
  const evidence = { reason, blockers };
  expect(confirmed.resolution).toMatchObject({
    resolved_by: "human",
    via: "needs_you",
    merge_override: evidence,
  });
  expect(state().events).toContainEqual(
    expect.objectContaining({
      type: "decision_resolved",
      actor: human,
      payload: expect.objectContaining({
        decision_id: pending.id,
        merge_override: evidence,
      }),
    }),
  );
  const entry = state().timeline.find(
    (t) => t.type === "decision_resolved" && t.decision_id === pending.id,
  );
  for (const text of [reason, ...blockers]) expect(entry?.body).toContain(text);

  const plan = mergePlan(state(), s.card.id);
  if (!plan.ok) throw new Error(plan.error.message);
  const planned = plan.value.deliveries;
  expect(planned.map((d) => d.work_item_id)).toEqual([s.development.id]);
  expect(planned.map((d) => d.delivery_id)).not.toContain(rejected.id);
});

test("§12.5/§4.4 conflict reopens the card and the whole path can reach awaiting_merge again", async () => {
  const s = await scenario("confirm");
  const { product, completion } = await acceptThroughMergeGate(s, SHA_A);
  const first = confirmations(s.card.id)[0];
  if (first === undefined) throw new Error("missing confirmation");
  decide(first, "merge");

  apply(
    (st, a, p) =>
      recordMergeResult(
        st,
        a,
        {
          card_id: s.card.id,
          completion_id: completion.id,
          result: {
            kind: "conflicted",
            delivery_id: product.id,
            files: ["a.ts"],
          },
        },
        p,
      ),
    system,
  );
  expect(card(s.card.id).status).toBe("in_progress");
  expect(card(s.card.id).resolution).toBeUndefined();
  expect(item(s.development.id).status).toBe("changes_requested");
  expect(item(s.acceptance.id).status).toBe("todo");
  expect(
    state().deliveries.find((delivery) => delivery.id === completion.id)
      ?.status,
  ).toBe("superseded");
  expect(
    state().events.find((event) => event.type === "merge_conflicted")?.payload,
  ).toMatchObject({
    completion_id: completion.id,
    work_item_id: s.development.id,
    run_kind: "fix",
  });

  // Rework: new version, fresh review, new completion, new acceptance.
  startRun(s.coder);
  const reworked = await deliver(s.coder, s.development.id, {
    subject: SHA_B,
    verifiers: [s.codeReview.id],
  });
  endRun(s.coder);
  // The old review target is stale after the new version (invariant 14).
  expect(reviewRejection(s.reviewer, product, SHA_A).code).toBe("stale_target");
  startRun(s.reviewer);
  review(s.reviewer, reworked, SHA_B);
  endRun(s.reviewer);
  startRun(s.coder);
  const second = await deliver(s.coder, s.development.id, {
    kind: "card_completion",
    subject: SHA_B,
    verifiers: [s.acceptance.id],
  });
  endRun(s.coder);
  startRun(s.pmAcceptance);
  review(s.pmAcceptance, second, SHA_B, "product");

  expect(card(s.card.id).status).toBe("awaiting_merge");
  expect(confirmations(s.card.id)).toHaveLength(2);
  // The fresh completion needs its own confirmation before any result is taken.
  expect(mergePlan(state(), s.card.id).ok).toBe(false);
  const latest = confirmations(s.card.id).find((q) => q.status === "open");
  if (latest === undefined) throw new Error("missing second confirmation");
  decide(latest, "merge");
  const plan = mergePlan(state(), s.card.id);
  if (!plan.ok) throw new Error(plan.error.message);
  expect(plan.value.completion_id).toBe(second.id);
  // The old completion version is refused, not merged.
  expect(
    reject(
      (st, a, p) =>
        recordMergeResult(
          st,
          a,
          {
            card_id: s.card.id,
            completion_id: completion.id,
            result: { kind: "merged", merge_sha: SHA_B, previous_sha: SHA_A },
          },
          p,
        ),
      system,
    ).code,
  ).toBe("stale_target");
  expect(card(s.card.id).status).toBe("awaiting_merge");
  apply(
    (st, a, p) =>
      recordMergeResult(
        st,
        a,
        {
          card_id: s.card.id,
          completion_id: second.id,
          result: { kind: "merged", merge_sha: SHA_B, previous_sha: SHA_A },
        },
        p,
      ),
    system,
  );
  expect(card(s.card.id)).toMatchObject({ status: "done", resolution: "done" });
  expect(
    state().events.filter((event) => event.type === "card_merged"),
  ).toHaveLength(1);
});

test("§4.4/§12.5 recordMergeResult: system only, exact replay writes nothing, validation is strict", async () => {
  const s = await scenario("auto");
  const { completion } = await acceptThroughMergeGate(s);
  const params = {
    card_id: s.card.id,
    completion_id: completion.id,
    result: { kind: "failed" as const, reason: "fixture failure" },
  };
  for (const actor of [
    human,
    actorFor(s.coder),
    { ...system, project_id: "other" },
  ])
    expect(
      reject((st, a, p) => recordMergeResult(st, a, params, p), actor).code,
    ).toBe("unauthorized");
  apply((st, a, p) => recordMergeResult(st, a, params, p), system);
  expect(card(s.card.id).status).toBe("awaiting_merge");
  expect(
    state().events.filter((event) => event.type === "merge_failed"),
  ).toHaveLength(1);
  // Exact replay: no new event, no card change.
  const before = state();
  apply((st, a, p) => recordMergeResult(st, a, params, p), system);
  const after = state();
  expect(after.events).toHaveLength(before.events.length);
  expect(after.cards).toEqual(before.cards);
  // A different result for the same completion is not a replay.
  apply(
    (st, a, p) =>
      recordMergeResult(
        st,
        a,
        { ...params, result: { kind: "failed", reason: "different failure" } },
        p,
      ),
    system,
  );
  for (const result of [
    { kind: "merged" as const, merge_sha: "abc", previous_sha: SHA_A },
    { kind: "merged" as const, merge_sha: SHA_B, previous_sha: "abc" },
    { kind: "conflicted" as const, delivery_id: completion.id, files: [] },
  ])
    expect(
      reject(
        (st, a, p) =>
          recordMergeResult(
            st,
            a,
            { card_id: s.card.id, completion_id: completion.id, result },
            p,
          ),
        system,
      ).code,
    ).toBe("validation_failed");
  // A conflict must name a delivery of the current plan.
  const other = state().deliveries.find(
    (delivery) => delivery.kind === "card_completion",
  );
  expect(
    reject(
      (st, a, p) =>
        recordMergeResult(
          st,
          a,
          {
            card_id: s.card.id,
            completion_id: completion.id,
            result: {
              kind: "conflicted",
              delivery_id: other?.id as never,
              files: ["a.ts"],
            },
          },
          p,
        ),
      system,
    ).code,
  ).toBe("stale_target");

  // Done is terminal for merge results (the card is no longer awaiting merge).
  apply(
    (st, a, p) =>
      recordMergeResult(
        st,
        a,
        {
          card_id: s.card.id,
          completion_id: completion.id,
          result: { kind: "merged", merge_sha: SHA_B, previous_sha: SHA_A },
        },
        p,
      ),
    system,
  );
  expect(card(s.card.id)).toMatchObject({ status: "done", resolution: "done" });
  expect(
    reject(
      (st, a, p) =>
        recordMergeResult(
          st,
          a,
          {
            card_id: s.card.id,
            completion_id: completion.id,
            result: { kind: "failed", reason: "too late" },
          },
          p,
        ),
      system,
    ).code,
  ).toBe("illegal_transition");
  expect(card(s.card.id).status).toBe("done");
});

test("§4.4 progress and completion are not manually writable, and an awaiting card refuses new work", async () => {
  const s = await scenario();
  const { product } = await acceptThroughMergeGate(s);
  for (const status of ["awaiting_merge", "done", "review"] as const)
    expect(
      reject(
        (st, a, p) => updateCard(st, a, { card_id: s.card.id, status }, p),
        human,
      ).code,
    ).toBe("illegal_transition");
  // New deliveries and reviews are refused while awaiting merge.
  startRun(s.coder);
  await expect(
    deliver(s.coder, s.development.id, {
      subject: SHA_B,
      verifiers: [s.codeReview.id],
    }),
  ).rejects.toThrow();
  startRun(s.reviewer);
  expect(reviewRejection(s.reviewer, product, SHA_A).code).toBe(
    "illegal_transition",
  );
  // §3.8: awaiting_merge may still be cancelled, and that cancels the work.
  apply(
    (st, a, p) =>
      updateCard(st, a, { card_id: s.card.id, status: "cancelled" }, p),
    human,
  );
  expect(card(s.card.id).status).toBe("cancelled");
  expect(item(s.development.id).status).toBe("cancelled");
});

test("§12.6 releaseAssignment: permissions are checked and an unfinished Run blocks the release", async () => {
  const s = await scenario();
  // A running Run blocks the release for every actor, including the human.
  startRun(s.coder, {
    worktree: { path: "/tmp/cardigan-m4t1/worktree", branch: "agent/C-1/W-1" },
  });
  for (const actor of [human, actorFor(s.ops, opsTools), system])
    expect(
      reject(
        (st, a, p) =>
          releaseAssignment(st, a, { assignment_id: s.coder.id }, p),
        actor,
      ).code,
    ).toBe("illegal_transition");
  // A work Assignment has no release tool and is never a releaser.
  expect(
    reject(
      (st, a, p) => releaseAssignment(st, a, { assignment_id: s.office.id }, p),
      actorFor(s.coder),
    ).code,
  ).toBe("forbidden_tool");
  expect(state().assignments.find((a) => a.id === s.coder.id)?.status).toBe(
    "active",
  );
  endRun(s.coder);

  // The human may release; the recorded facts reach the event (§12.6).
  apply(
    (st, a, p) => releaseAssignment(st, a, { assignment_id: s.coder.id }, p),
    human,
  );
  expect(state().assignments.find((a) => a.id === s.coder.id)).toMatchObject({
    status: "released",
    runtime_state: "released",
  });
  expect(
    state()
      .events.filter((candidate) => candidate.type === "assignment_released")
      .at(-1)?.payload,
  ).toMatchObject({
    assignment_id: s.coder.id,
    worktree_path: "/tmp/cardigan-m4t1/worktree",
    branch: "agent/C-1/W-1",
    token_id: s.coder.mcp_token_id,
  });

  // PM Ops may release a work-item Assignment ...
  apply(
    (st, a, p) => releaseAssignment(st, a, { assignment_id: s.reviewer.id }, p),
    actorFor(s.ops, opsTools),
  );
  expect(state().assignments.find((a) => a.id === s.reviewer.id)?.status).toBe(
    "released",
  );
  // ...but never a standing one; only the human may.
  expect(
    reject(
      (st, a, p) => releaseAssignment(st, a, { assignment_id: s.office.id }, p),
      actorFor(s.ops, opsTools),
    ).code,
  ).toBe("unauthorized");
  expect(state().assignments.find((a) => a.id === s.office.id)?.status).toBe(
    "active",
  );
  apply(
    (st, a, p) => releaseAssignment(st, a, { assignment_id: s.office.id }, p),
    human,
  );
  expect(state().assignments.find((a) => a.id === s.office.id)?.status).toBe(
    "released",
  );

  // system only auto-releases Assignments of a closed card.
  expect(
    reject(
      (st, a, p) =>
        releaseAssignment(st, a, { assignment_id: s.pmAcceptance.id }, p),
      system,
    ).code,
  ).toBe("illegal_transition");
  apply(
    (st, a, p) =>
      updateCard(st, a, { card_id: s.card.id, status: "cancelled" }, p),
    human,
  );
  apply(
    (st, a, p) =>
      releaseAssignment(st, a, { assignment_id: s.pmAcceptance.id }, p),
    system,
  );
  expect(
    state().assignments.find((a) => a.id === s.pmAcceptance.id)?.status,
  ).toBe("released");
});

test("§12.6 requestWorktreeCleanup: system only, released worktree only, one pending decision per Assignment", async () => {
  const s = await scenario();
  expect(
    reject(
      (st, a, p) =>
        requestWorktreeCleanup(
          st,
          a,
          { assignment_id: s.coder.id, reason: "fixture" },
          p,
        ),
      system,
    ).code,
  ).toBe("illegal_transition");

  startRun(s.coder, {
    worktree: { path: "/tmp/cardigan-m4t1/cleanup", branch: "agent/C-1/W-1" },
  });
  endRun(s.coder);
  for (const actor of [human, actorFor(s.office)])
    expect(
      reject(
        (st, a, p) =>
          requestWorktreeCleanup(
            st,
            a,
            { assignment_id: s.coder.id, reason: "fixture" },
            p,
          ),
        actor,
      ).code,
    ).toBe("unauthorized");
  // Still active: cleanup is only for a released Assignment.
  expect(
    reject(
      (st, a, p) =>
        requestWorktreeCleanup(
          st,
          a,
          { assignment_id: s.coder.id, reason: "fixture" },
          p,
        ),
      system,
    ).code,
  ).toBe("illegal_transition");
  apply(
    (st, a, p) => releaseAssignment(st, a, { assignment_id: s.coder.id }, p),
    human,
  );
  const first = apply(
    (st, a, p) =>
      requestWorktreeCleanup(
        st,
        a,
        { assignment_id: s.coder.id, reason: "uncommitted changes" },
        p,
      ),
    system,
  );
  expect(first).toMatchObject({
    trigger: "worktree_cleanup",
    status: "open",
    decider: "human",
    category: "data_deletion",
    blocking: false,
    assignment_id: s.coder.id,
  });
  expect(first.options.map((option) => option.key).sort()).toEqual([
    "force_clean",
    "keep",
  ]);
  const again = apply(
    (st, a, p) =>
      requestWorktreeCleanup(
        st,
        a,
        { assignment_id: s.coder.id, reason: "second pass" },
        p,
      ),
    system,
  );
  expect(again.id).toBe(first.id);
  expect(
    state().decisions.filter((q) => q.trigger === "worktree_cleanup"),
  ).toHaveLength(1);
  // Released without a worktree: nothing to decide.
  apply(
    (st, a, p) => releaseAssignment(st, a, { assignment_id: s.reviewer.id }, p),
    human,
  );
  expect(
    reject(
      (st, a, p) =>
        requestWorktreeCleanup(
          st,
          a,
          { assignment_id: s.reviewer.id, reason: "no worktree" },
          p,
        ),
      system,
    ).code,
  ).toBe("illegal_transition");
  expect(
    state().decisions.filter((q) => q.trigger === "worktree_cleanup"),
  ).toHaveLength(1);
});

// -------------------------------------------- §4/§6.4 routing of M4 events ---

/**
 * The router is a pure function of one event plus a snapshot. Routing the
 * events these commands really wrote (never a hand-built event) is how M4.1's
 * new rows are accepted.
 */
const eventOf = (
  type: string,
  match: (payload: Record<string, unknown>) => boolean = () => true,
): Event => {
  const events = state().events.filter(
    (event) =>
      event.type === type &&
      match((event.payload ?? {}) as Record<string, unknown>),
  );
  const last = events.at(-1);
  if (last === undefined) throw new Error(`missing ${type} event`);
  return last;
};
const route = (event: Event) => routeEvent({ event, snapshot: state() });
const rules = (result: ReturnType<typeof routeEvent>) =>
  result.notifications.map((note) => note.rule).sort();

test("§4/§6.4 the completion reminder stops once the card is awaiting merge and is sent while it is not", async () => {
  const s = await scenario("auto");
  startRun(s.coder);
  const product = await deliver(s.coder, s.development.id, {
    subject: SHA_A,
    verifiers: [s.codeReview.id],
  });
  endRun(s.coder);
  startRun(s.reviewer);
  review(s.reviewer, product, SHA_A);
  endRun(s.reviewer);

  // Control: the code review passed, the card is not awaiting merge yet.
  expect(card(s.card.id).status).not.toBe("awaiting_merge");
  const codeReview = eventOf(
    "review_submitted",
    (payload) => payload.delivery_id === product.id,
  );
  const beforeCompletion = route(codeReview);
  expect(rules(beforeCompletion)).toContain(
    "6.4/all required work items passed",
  );
  expect(
    beforeCompletion.notifications.find(
      (note) => note.rule === "6.4/all required work items passed",
    ),
  ).toMatchObject({
    recipient: { kind: "assignment", assignment_id: s.coder.id },
    kind: "completion",
  });

  startRun(s.coder);
  const completion = await deliver(s.coder, s.development.id, {
    kind: "card_completion",
    subject: SHA_A,
    verifiers: [s.acceptance.id],
  });
  endRun(s.coder);
  startRun(s.pmAcceptance);
  review(s.pmAcceptance, completion, SHA_A, "product");
  expect(card(s.card.id).status).toBe("awaiting_merge");

  // The same rule must stay silent once the card is past review.
  const acceptance = eventOf(
    "review_submitted",
    (payload) => payload.delivery_id === completion.id,
  );
  const afterAcceptance = route(acceptance);
  expect(rules(afterAcceptance)).not.toContain(
    "6.4/all required work items passed",
  );
});

test("§4/§6.4 merge_conflicted wakes the conflicting work item's producer for a fix Run", async () => {
  const s = await scenario("auto");
  const { product, completion } = await acceptThroughMergeGate(s);
  apply(
    (st, a, p) =>
      recordMergeResult(
        st,
        a,
        {
          card_id: s.card.id,
          completion_id: completion.id,
          result: {
            kind: "conflicted",
            delivery_id: product.id,
            files: ["a.ts"],
          },
        },
        p,
      ),
    system,
  );
  const result = route(eventOf("merge_conflicted"));
  expect(result.notifications).toHaveLength(1);
  expect(result.notifications[0]).toMatchObject({
    recipient: { kind: "assignment", assignment_id: s.coder.id },
    rule: "6.4/merge conflicted",
    kind: "instruction",
    work_item_id: s.development.id,
    run_kind: "fix",
  });
});

test("§4/§6.4 merge_conflicted without an active producer goes to PM Ops", async () => {
  const s = await scenario("auto");
  const { product, completion } = await acceptThroughMergeGate(s);
  // The producer is released before the merge verdict: nothing can take the fix.
  apply(
    (st, a, p) => releaseAssignment(st, a, { assignment_id: s.coder.id }, p),
    human,
  );
  apply(
    (st, a, p) =>
      recordMergeResult(
        st,
        a,
        {
          card_id: s.card.id,
          completion_id: completion.id,
          result: {
            kind: "conflicted",
            delivery_id: product.id,
            files: ["a.ts"],
          },
        },
        p,
      ),
    system,
  );
  const result = route(eventOf("merge_conflicted"));
  expect(result.notifications).toHaveLength(1);
  expect(result.notifications[0]).toMatchObject({
    recipient: { kind: "pm_ops" },
    rule: "6.4/merge conflicted",
    kind: "escalation",
  });
  expect(result.notifications[0]?.run_kind).toBeUndefined();
});

test("§4/§6.4 card_merged and merge_failed notify PM Ops", async () => {
  const merged = await scenario("auto");
  const { completion } = await acceptThroughMergeGate(merged);
  apply(
    (st, a, p) =>
      recordMergeResult(
        st,
        a,
        {
          card_id: merged.card.id,
          completion_id: completion.id,
          result: { kind: "merged", merge_sha: SHA_B, previous_sha: SHA_A },
        },
        p,
      ),
    system,
  );
  expect(route(eventOf("card_merged")).notifications).toMatchObject([
    {
      recipient: { kind: "pm_ops" },
      rule: "6.4/card merged",
      kind: "completion",
    },
  ]);

  h.close();
  h = harness();
  const failed = await scenario("auto");
  const attempt = await acceptThroughMergeGate(failed);
  apply(
    (st, a, p) =>
      recordMergeResult(
        st,
        a,
        {
          card_id: failed.card.id,
          completion_id: attempt.completion.id,
          result: { kind: "failed", reason: "fixture failure" },
        },
        p,
      ),
    system,
  );
  expect(route(eventOf("merge_failed")).notifications).toMatchObject([
    {
      recipient: { kind: "pm_ops" },
      rule: "6.4/merge failed",
      kind: "escalation",
    },
  ]);
  expect(card(failed.card.id).status).toBe("awaiting_merge");
});

test("§4/§6.4 a reconcile finding is escalated to PM Ops", async () => {
  // M4.4 owns the reconcile loop; until it lands the acceptance appends the
  // event through the public Store event repository, the only writer there is.
  h.store.uow.run((tx) =>
    tx.events.append(project, {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(project),
      type: "reconcile_finding",
      actor: system,
      payload: {
        finding: "orphan_worktree",
        path: "/tmp/cardigan-m4t1/orphan",
      },
      created_at: h.clock.now(),
    }),
  );
  expect(route(eventOf("reconcile_finding")).notifications).toMatchObject([
    {
      recipient: { kind: "pm_ops" },
      rule: "6.4/reconcile finding",
      kind: "escalation",
    },
  ]);
});

// ------------------------------------------------- recordDecision audience ---

test("§4.4 recordDecision: PM-authorized choices use the dedicated Ops tool", async () => {
  const s = await scenario("confirm");
  // An authorized process decision belongs to PM Ops, not Office.
  startRun(s.coder);
  const ordinary = apply(
    (st, a, p) =>
      requestDecision(
        st,
        a,
        {
          card_id: s.card.id,
          kind: "choose",
          category: "general",
          question: "Which way?",
          context: "fixture",
          options: [
            { key: "a", description: "A", impact: "none" },
            { key: "b", description: "B", impact: "none" },
          ],
          recommended: "a",
          decider: "role:pm",
          affected_cards: [s.card.id],
          affected_work_items: [],
          blocking: true,
        },
        p,
      ),
    actorFor(s.coder),
  );
  expect(
    reject(
      (st, a, p) =>
        recordDecision(
          st,
          a,
          {
            decision_id: ordinary.id,
            option: "a",
            rationale: "fixture",
            raw_quote: "fixture a",
          },
          p,
        ),
      actorFor(s.office),
    ).code,
  ).toBe("forbidden_tool");
  expect(
    apply(
      (st, a, p) =>
        resolveDelegatedDecision(
          st,
          a,
          {
            decision_id: ordinary.id,
            option: "a",
            rationale: "fixture",
          },
          p,
        ),
      actorFor(s.ops, opsTools),
    ).status,
  ).toBe("resolved");
});

test("§4.4 recordDecision: PM Ops cannot record a merge confirmation or a cleanup decision; the human can", async () => {
  const s = await scenario("confirm");
  const { completion } = await acceptThroughMergeGate(s);
  const [pending] = confirmations(s.card.id);
  if (pending === undefined) throw new Error("missing confirmation");
  expect(
    reject(
      (st, a, p) =>
        recordDecision(
          st,
          a,
          {
            decision_id: pending.id,
            option: "merge",
            rationale: "fixture",
            raw_quote: "fixture merge",
          },
          p,
        ),
      actorFor(s.ops, opsTools),
    ).code,
  ).toBe("forbidden_tool");
  expect(
    apply(
      (st, a, p) =>
        recordDecision(
          st,
          a,
          {
            decision_id: pending.id,
            option: "merge",
            rationale: "fixture",
            raw_quote: "fixture merge",
          },
          p,
        ),
      human,
    ).status,
  ).toBe("resolved");
  expect(mergePlan(state(), s.card.id).ok).toBe(true);

  // Cleanup decision: same audience rule, and the human's keep is final here.
  apply(
    (st, a, p) => releaseAssignment(st, a, { assignment_id: s.coder.id }, p),
    human,
  );
  const cleanup = apply(
    (st, a, p) =>
      requestWorktreeCleanup(
        st,
        a,
        { assignment_id: s.coder.id, reason: "uncommitted changes" },
        p,
      ),
    system,
  );
  expect(
    reject(
      (st, a, p) =>
        recordDecision(
          st,
          a,
          {
            decision_id: cleanup.id,
            option: "keep",
            rationale: "fixture",
            raw_quote: "fixture keep",
          },
          p,
        ),
      actorFor(s.ops, opsTools),
    ).code,
  ).toBe("forbidden_tool");
  const kept = apply(
    (st, a, p) =>
      recordDecision(
        st,
        a,
        {
          decision_id: cleanup.id,
          option: "keep",
          rationale: "fixture",
          raw_quote: "fixture keep",
        },
        p,
      ),
    human,
  );
  expect(kept).toMatchObject({ status: "resolved" });
  expect(kept.resolution?.option).toBe("keep");
  expect(completion.id.length).toBeGreaterThan(0);
});
