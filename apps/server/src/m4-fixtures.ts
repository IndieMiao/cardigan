/**
 * M4 test support: drive real domain commands to a card that is `awaiting_merge`.
 *
 * Only public package APIs are used (createCard, assign, queueRun/dispatchRun/
 * acknowledgeRun/finishRun, prepareDelivery/submitDelivery, submitReview,
 * recordDecision). Nothing is pre-seeded except the project row and the role
 * rows, which are project bootstrap data like `cardigan project create` and
 * `cardigan role add` write them.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Actor,
  Assignment,
  Card,
  CardTemplate,
  Clock,
  CommandEffect,
  CommandPorts,
  CommandState,
  Decision,
  Delivery,
  DeliveryVerifier,
  ProjectId,
  Result,
  Review,
  Role,
  RoleReference,
  Run,
  ToolName,
  WorkItem,
} from "@cardigan/domain";
import {
  acknowledgeRun,
  assign,
  createCard,
  developmentCardTemplate,
  dispatchRun,
  finishRun,
  prepareDelivery,
  queueRun,
  recordDecision,
  submitDelivery,
  submitReview,
} from "@cardigan/domain";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import { Store, writeRole } from "@cardigan/store";

const TEST_PLAIN_SUMMARY = {
  changed: "测试用的改动说明",
  impact: "测试用的影响说明",
  risk: "无",
};

export const PM_TOOLS: readonly ToolName[] = [
  "create_card",
  "update_card",
  "create_work_item",
  "assign",
  "record_decision",
  "submit_review",
  "finish_run",
];
export const OPS_TOOLS = PM_TOOLS.filter((tool) => tool !== "record_decision");
export const CODER_TOOLS: readonly ToolName[] = [
  "submit_delivery",
  "request_decision",
  "finish_run",
];
export const REVIEWER_TOOLS: readonly ToolName[] = [
  "submit_review",
  "finish_run",
];

/** M4.1 state-machine tests do not exercise Git. */
export const acceptingVerifier: DeliveryVerifier = {
  verify: async () => ({ ok: true, value: [] }),
};

export interface M4Scenario {
  readonly card: Card;
  readonly development: WorkItem;
  readonly codeReview: WorkItem;
  readonly acceptance: WorkItem;
  readonly coder: Assignment;
  readonly reviewer: Assignment;
  readonly pmAcceptance: Assignment;
}

export interface M4Fixture {
  readonly project_id: ProjectId;
  readonly dataDir: string;
  readonly store: Store;
  readonly clock: Clock;
  readonly human: Actor;
  close(): void;
  state(): CommandState;
  apply<T>(
    reduce: (
      state: CommandState,
      actor: Actor,
      ports: CommandPorts,
    ) => Result<CommandEffect<T>>,
    actor?: Actor,
  ): T;
  card(id?: string): Card;
  item(id: WorkItem["id"]): WorkItem;
  actorFor(assignment: Assignment, tools?: readonly ToolName[]): Actor;
  startRun(
    assignment: Assignment,
    worktree?: { path: string; branch: string },
  ): Run;
  endRun(assignment: Assignment, outcome?: "completed" | "failed"): Run;
  deliver(
    assignment: Assignment,
    work_item_id: WorkItem["id"],
    input: {
      readonly kind?: Delivery["kind"];
      readonly subject: string;
      readonly subject_kind?: "git_head" | "artifact_sha256" | "doc_version";
      readonly verifiers: readonly WorkItem["id"][];
    },
  ): Promise<Delivery>;
  review(
    assignment: Assignment,
    delivery: Delivery,
    kind?: "code" | "product",
  ): Review;
  decide(decision: Decision, option: string): Decision;
}

export function m4Fixture(
  options: {
    readonly project_id?: string;
    readonly policy?: "confirm" | "auto";
    readonly clock?: Clock;
    /** Share a real database for cross-project scheduling tests. */
    readonly dataDir?: string;
    /** Single-connection tests that do not exercise on-disk recovery. */
    readonly memoryDatabase?: boolean;
    readonly reviewer_worktree?: "none" | "readonly";
    readonly pm_worktree?: "none" | "readonly";
  } = {},
): M4Fixture {
  const project_id = (options.project_id ?? "p-m4") as ProjectId;
  const dataDir =
    options.dataDir ?? mkdtempSync(join(tmpdir(), "cardigan-m4-"));
  const time = Date.parse("2030-01-01T00:00:00.000Z");
  const clock: Clock = options.clock ?? {
    now: () => new Date(time).toISOString(),
  };
  const store = Store.open({
    dataDir,
    clock,
    ...(options.memoryDatabase ? { dbPath: ":memory:" } : {}),
  });
  store.createProject({ id: project_id, name: "M4 fixture" });
  const role = (
    role_id: string,
    tools: readonly ToolName[],
    worktree: Role["worktree"],
  ): Role => ({
    role_id,
    version: 1,
    display_name: role_id,
    kind: "work",
    core_prompt: `You are the ${role_id}.`,
    harness: "pi",
    launch_profile_ref: "fixture",
    allowed_tools: [...tools],
    capabilities: [],
    abilities: [],
    worktree,
    required_machine_tags: [],
  });
  for (const [role_id, tools, worktree] of [
    ["pm", PM_TOOLS, options.pm_worktree ?? "none"],
    ["coder", CODER_TOOLS, "write"],
    ["reviewer", REVIEWER_TOOLS, options.reviewer_worktree ?? "none"],
  ] as const)
    store.uow.run((tx) =>
      writeRole(tx, project_id, role(role_id, tools, worktree), {
        mode: "add",
      }),
    );

  const human: Actor = { kind: "human", project_id };
  const apply = <T>(
    reduce: (
      state: CommandState,
      actor: Actor,
      ports: CommandPorts,
    ) => Result<CommandEffect<T>>,
    actor: Actor = human,
  ): T =>
    store.uow.run((tx) => {
      const effect = unwrap(
        reduce(loadCommandState(tx, project_id), actor, {
          clock,
          ids: tx.ids,
        }),
      );
      persistEffect(tx, project_id, effect);
      return effect.data;
    });
  const state = () => store.uow.read((tx) => loadCommandState(tx, project_id));
  const card = (id?: string): Card => {
    const found = state().cards.find(
      (entry) => id === undefined || entry.id === id,
    );
    if (found === undefined) throw new Error(`missing card ${id ?? ""}`);
    return found;
  };
  const item = (id: WorkItem["id"]): WorkItem => {
    const found = state().work_items.find((entry) => entry.id === id);
    if (found === undefined) throw new Error(`missing work item ${id}`);
    return found;
  };
  const actorFor = (
    assignment: Assignment,
    tools: readonly ToolName[] = roleOf(assignment).allowed_tools,
  ): Actor => ({
    kind: "assignment",
    project_id,
    assignment_id: assignment.id,
    role_id: assignment.role_id,
    role_version: assignment.role_version,
    allowed_tools: [...tools],
    capabilities: [],
  });

  const roleOf = (assignment: Assignment): RoleReference => {
    const found = store.uow.read((tx) =>
      tx.roles.get(project_id, {
        role_id: assignment.role_id,
        role_version: assignment.role_version,
      }),
    );
    if (found === undefined) throw new Error("missing role");
    return found;
  };

  const startRun = (
    assignment: Assignment,
    worktree?: { path: string; branch: string },
  ): Run => {
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
              ...(worktree === undefined
                ? {}
                : { worktree_path: worktree.path, branch: worktree.branch }),
            },
            ...(worktree === undefined ? {} : { base_sha: "1".repeat(40) }),
          },
          p,
        ),
      human,
    );
    return apply(
      (s, a, p) => acknowledgeRun(s, a, { run_id: run.id }, p),
      actorFor(assignment),
    );
  };
  const endRun = (
    assignment: Assignment,
    outcome: "completed" | "failed" = "completed",
  ): Run => {
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
          { run_id: run.id, outcome, summary: "fixture done" },
          p,
        ),
      actorFor(assignment),
    );
  };
  const deliver: M4Fixture["deliver"] = async (
    assignment,
    work_item_id,
    input,
  ) => {
    const actor = actorFor(assignment),
      params = {
        work_item_id,
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
      },
      prepared = await prepareDelivery(
        state(),
        actor,
        params,
        acceptingVerifier,
      );
    if (!prepared.ok)
      throw new Error(
        `prepare failed ${prepared.error.code}: ${prepared.error.message}`,
      );
    return store.uow.run((tx) => {
      const effect = unwrap(
        submitDelivery(
          loadCommandState(tx, project_id),
          actor,
          params,
          prepared.value,
          { clock, ids: tx.ids },
        ),
      );
      persistEffect(tx, project_id, effect);
      return effect.data;
    });
  };
  const review = (
    assignment: Assignment,
    delivery: Delivery,
    kind: "code" | "product" = delivery.kind === "card_completion"
      ? "product"
      : "code",
  ): Review =>
    apply(
      (s, a, p) =>
        submitReview(
          s,
          a,
          {
            delivery_id: delivery.id,
            target_sha: delivery.subject.value,
            kind,
            issues: [],
          },
          p,
        ),
      actorFor(assignment),
    );
  const decide = (decision: Decision, option: string): Decision =>
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

  return {
    project_id,
    dataDir,
    store,
    clock,
    human,
    close: () => {
      store.close();
      if (!options.dataDir) rmSync(dataDir, { recursive: true, force: true });
    },
    state,
    apply,
    card,
    item,
    actorFor,
    startRun,
    endRun,
    deliver,
    review,
    decide,
  };
}

/** Create a dev card and assign its three work items (§4.4, D4). */
export function m4Scenario(
  fixture: M4Fixture,
  policy: "confirm" | "auto" = "confirm",
  base_branch = "main",
): M4Scenario {
  const templates: readonly CardTemplate[] = [
    { ...developmentCardTemplate, merge: policy },
  ];
  const card = fixture.apply(
    (s, a, p) =>
      createCard(
        s,
        a,
        {
          title: "M4 card",
          goal: "prove the merge path",
          acceptance_criteria: ["merged"],
          source: { kind: "quote", text: "fixture" },
          repo: "example/repo",
          base_branch,
        },
        { ...p, templates },
      ),
    fixture.human,
  );
  const items = fixture
    .state()
    .work_items.filter((work) => work.card_id === card.id);
  const development = items.find((work) => work.kind === "produce");
  const codeReview = items.find(
    (work) =>
      work.kind === "verify" && work.target_work_item_id === development?.id,
  );
  const acceptance = items.find(
    (work) => work.kind === "verify" && work.target_work_item_id === undefined,
  );
  if (!development || !codeReview || !acceptance)
    throw new Error("dev template work items missing");
  const assignOne = (work: WorkItem, role_id: string) =>
    fixture.apply(
      (s, a, p) => assign(s, a, { work_item_id: work.id, role_id }, p),
      fixture.human,
    );
  return {
    card,
    development,
    codeReview,
    acceptance,
    coder: assignOne(development, "coder"),
    reviewer: assignOne(codeReview, "reviewer"),
    pmAcceptance: assignOne(acceptance, "pm"),
  };
}

/**
 * Deliver → review → completion → review. Returns the accepted deliveries; the
 * card is `awaiting_merge` and, for `confirm`, one open merge confirmation.
 */
export async function acceptThroughMergeGate(
  fixture: M4Fixture,
  scenario: M4Scenario,
  sha: string,
  worktree?: { readonly path: string; readonly branch: string },
) {
  fixture.startRun(scenario.coder, worktree);
  const product = await fixture.deliver(
    scenario.coder,
    scenario.development.id,
    {
      subject: sha,
      verifiers: [scenario.codeReview.id],
    },
  );
  fixture.endRun(scenario.coder);
  fixture.startRun(scenario.reviewer);
  fixture.review(scenario.reviewer, product);
  fixture.endRun(scenario.reviewer);
  fixture.startRun(scenario.coder);
  const completion = await fixture.deliver(
    scenario.coder,
    scenario.development.id,
    {
      kind: "card_completion",
      subject: sha,
      verifiers: [scenario.acceptance.id],
    },
  );
  fixture.endRun(scenario.coder);
  fixture.startRun(scenario.pmAcceptance);
  fixture.review(scenario.pmAcceptance, completion);
  fixture.endRun(scenario.pmAcceptance);
  return { product, completion };
}

/** The open merge confirmation of a card, if the policy asks for one. */
export function mergeConfirmation(
  fixture: M4Fixture,
  card_id: string,
): Decision | undefined {
  return fixture
    .state()
    .decisions.filter(
      (decision) =>
        decision.trigger === "merge_confirmation" &&
        decision.card_id === card_id,
    )
    .at(-1);
}
