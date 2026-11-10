/**
 * M4.4 merge CLI (plan §4 M4.4): `cardigan merge status|confirm|request`.
 *
 * Drives the real domain commands (create → assign → deliver → review →
 * completion → review) to the `awaiting_merge` state, then exercises only the
 * CLI surface. The merge execution itself is covered by
 * `apps/server/src/merge-loop.test.ts`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Actor,
  Assignment,
  CardTemplate,
  CommandEffect,
  CommandPorts,
  CommandState,
  Decision,
  Delivery,
  ProjectId,
  Result,
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
  submitDelivery,
  submitReview,
} from "@cardigan/domain";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import { routeEvent } from "@cardigan/router";
import { Store, writeRole } from "@cardigan/store";
import { afterEach, beforeEach, expect, test } from "vitest";
import { main } from "./index.js";
import type { CliIo } from "./io.js";

const project = "p-merge-cli" as ProjectId;
const NOW = "2030-01-01T00:00:00.000Z";
const SHA = "a".repeat(40);
const ROLE_TOOLS: readonly ToolName[] = [
  "submit_delivery",
  "submit_review",
  "finish_run",
];

let store: Store;
let dataDir: string;
let output: string[];
let errors: string[];
let card_id: string;

const io = (): CliIo => ({
  env: {},
  cwd: dataDir,
  platform: "linux",
  stdout: (line) => output.push(line),
  stderr: (line) => errors.push(line),
  signals: { on: () => undefined, off: () => undefined },
  spawnInherit: () => {
    throw new Error("merge commands must not spawn");
  },
  captureCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
});

async function cardigan(...argv: string[]) {
  output = [];
  errors = [];
  const code = await main([...argv, "--data-dir", dataDir], io());
  return { code, out: output.join("\n"), err: errors.join("\n") };
}

const human: Actor = { kind: "human", project_id: project };
const state = (): CommandState =>
  store.uow.read((tx) => loadCommandState(tx, project));
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
      reduce(loadCommandState(tx, project), actor, {
        clock: { now: () => NOW },
        ids: tx.ids,
      }),
    );
    persistEffect(tx, project, effect);
    return effect.data;
  });
const asActor = (assignment: Assignment): Actor =>
  ({
    kind: "assignment",
    project_id: project,
    assignment_id: assignment.id,
    role_id: assignment.role_id,
    role_version: assignment.role_version,
    allowed_tools: [...ROLE_TOOLS],
    capabilities: [],
  }) as never;
function runFor(assignment: Assignment) {
  const run = apply((s, a, p) =>
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
  );
  apply((s, a, p) =>
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
        },
      },
      p,
    ),
  );
  return apply(
    (s, a, p) => acknowledgeRun(s, a, { run_id: run.id }, p),
    asActor(assignment),
  );
}
function endRun(assignment: Assignment) {
  const run = state()
    .runs.filter(
      (candidate) =>
        candidate.assignment_id === assignment.id &&
        !["completed", "failed", "cancelled"].includes(candidate.status),
    )
    .at(-1);
  if (run === undefined) throw new Error("missing run");
  apply(
    (s, a, p) =>
      finishRun(
        s,
        a,
        { run_id: run.id, outcome: "completed", summary: "done" },
        p,
      ),
    asActor(assignment),
  );
}
async function deliver(
  assignment: Assignment,
  work_item_id: string,
  input: { kind?: Delivery["kind"]; verifiers: readonly string[] },
): Promise<Delivery> {
  const actor = asActor(assignment),
    params = {
      work_item_id: work_item_id as never,
      kind: input.kind ?? ("code" as const),
      summary: "fixture",
      subject: { kind: "git_head" as const, value: SHA },
      requested_verifiers: [...input.verifiers] as never,
    },
    prepared = await prepareDelivery(state(), actor, params, {
      verify: async () => ({ ok: true, value: [] }),
    });
  if (!prepared.ok) throw new Error(prepared.error.code);
  return store.uow.run((tx) => {
    const effect = unwrap(
      submitDelivery(
        loadCommandState(tx, project),
        actor,
        params,
        prepared.value,
        { clock: { now: () => NOW }, ids: tx.ids },
      ),
    );
    persistEffect(tx, project, effect);
    return effect.data;
  });
}
function review(assignment: Assignment, delivery: Delivery) {
  apply(
    (s, a, p) =>
      submitReview(
        s,
        a,
        {
          delivery_id: delivery.id,
          target_sha: SHA,
          kind: delivery.kind === "card_completion" ? "product" : "code",
          issues: [],
        },
        p,
      ),
    asActor(assignment),
  );
}

/** createCard → assign → deliver → review → completion → review. */
async function seatAwaitingMerge() {
  for (const role_id of ["coder", "reviewer", "pm"])
    store.uow.run((tx) =>
      writeRole(
        tx,
        project,
        {
          role_id,
          version: 1,
          display_name: role_id,
          kind: "work",
          core_prompt: role_id,
          harness: "pi",
          launch_profile_ref: "fixture",
          allowed_tools: [...ROLE_TOOLS] as never,
          capabilities: [],
          abilities: [],
          worktree: role_id === "coder" ? "write" : "none",
          required_machine_tags: [],
        },
        { mode: "add" },
      ),
    );
  const templates: readonly CardTemplate[] = [
    { ...developmentCardTemplate, merge: "confirm" },
  ];
  const card = apply(
    (s, a, p) =>
      createCard(
        s,
        a,
        {
          title: "Merge card",
          goal: "Ship",
          acceptance_criteria: ["merged"],
          source: { kind: "quote", text: "fixture" },
          repo: "example/repo",
          base_branch: "main",
        },
        { ...p, templates },
      ),
    human,
  );
  card_id = card.id;
  const items = state().work_items.filter((work) => work.card_id === card.id),
    development = items.find((work) => work.kind === "produce") as WorkItem,
    codeReview = items.find(
      (work) =>
        work.kind === "verify" && work.target_work_item_id === development.id,
    ) as WorkItem,
    acceptance = items.find(
      (work) =>
        work.kind === "verify" && work.target_work_item_id === undefined,
    ) as WorkItem;
  const assignOne = (work: WorkItem, role_id: string) =>
    apply(
      (s, a, p) => assign(s, a, { work_item_id: work.id, role_id }, p),
      human,
    );
  const coder = assignOne(development, "coder"),
    reviewer = assignOne(codeReview, "reviewer"),
    pm = assignOne(acceptance, "pm");

  runFor(coder);
  const product = await deliver(coder, development.id, {
    verifiers: [codeReview.id],
  });
  endRun(coder);
  runFor(reviewer);
  review(reviewer, product);
  endRun(reviewer);
  runFor(coder);
  const completion = await deliver(coder, development.id, {
    kind: "card_completion",
    verifiers: [acceptance.id],
  });
  endRun(coder);
  runFor(pm);
  review(pm, completion);
  endRun(pm);
  return {
    card,
    development,
    confirmation: state().decisions.at(-1) as Decision,
  };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cardigan-merge-cli-"));
  store = Store.open({ dataDir, clock: { now: () => NOW } });
  store.createProject({ id: project, name: "Merge CLI" });
});
afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("merge status lists the card, the confirmation and the plan", async () => {
  await seatAwaitingMerge();
  const result = await cardigan("merge", "status");
  expect(result.code).toBe(0);
  expect(result.out).toContain(
    `${card_id} awaiting_merge merge_policy=confirm`,
  );
  expect(result.out).toContain("confirmation: q(1) open");
  expect(result.out).toContain("delivery: D-1 W-1 git_head=");
  expect(result.out).toContain("plan: not ready");
  expect(result.out).toContain("Merge confirmation has not been granted");
});

test("merge confirm records the merge decision with the command as the quote", async () => {
  await seatAwaitingMerge();
  const result = await cardigan("merge", "confirm", card_id);
  expect(result.code).toBe(0);
  expect(result.out).toContain(`已确认合并 ${card_id}`);
  expect(state().decisions.find((d) => d.id === "q(1)")).toMatchObject({
    status: "resolved",
    resolution: {
      option: "merge",
      raw_quote: `cardigan merge confirm ${card_id}`,
    },
  });
  expect((await cardigan("merge", "status", card_id)).out).toContain(
    "plan: ready",
  );
});

test("merge confirm keeps an explicit --quote", async () => {
  await seatAwaitingMerge();
  await cardigan("merge", "confirm", card_id, "--quote", "merge it");
  expect(
    state().decisions.find((d) => d.id === "q(1)")?.resolution?.raw_quote,
  ).toBe("merge it");
});

test("an unknown card is refused", async () => {
  const result = await cardigan("merge", "confirm", "C-9");
  expect(result.code).not.toBe(0);
  expect(result.err).toContain("C-9");
});

test("merge request-changes records the human reason and routes a fix to the original coder", async () => {
  const { development, confirmation } = await seatAwaitingMerge();
  const reason = "补齐空输入校验";
  const result = await cardigan(
    "merge",
    "request-changes",
    card_id,
    "--reason",
    reason,
    "--project",
    project,
  );
  expect(result.code).toBe(0);
  expect(result.out).toContain(`已将 ${card_id} 退回修改`);
  const current = state();
  expect(current.decisions.find((q) => q.id === confirmation.id)).toMatchObject(
    {
      status: "resolved",
      resolution: {
        option: "request_changes",
        rationale: reason,
        raw_quote: reason,
        resolved_by: "human",
        via: "needs_you",
      },
    },
  );
  expect(current.cards[0]?.status).toBe("in_progress");
  const producer = current.work_items.find((w) => w.id === development.id);
  expect(producer?.status).toBe("changes_requested");
  const event = current.events.findLast(
    (e) => e.type === "merge_changes_requested",
  );
  if (!event) throw new Error("Missing return event");
  expect(routeEvent({ event, snapshot: current }).notifications).toEqual([
    expect.objectContaining({
      recipient: { kind: "assignment", assignment_id: producer?.assignment_id },
      work_item_id: development.id,
      run_kind: "fix",
      summary: expect.stringContaining(reason),
    }),
  ]);
  expect(
    routeEvent({
      event,
      snapshot: {
        ...current,
        assignments: current.assignments.filter(
          (a) => a.id !== producer?.assignment_id,
        ),
      },
    }).notifications[0]?.recipient.kind,
  ).toBe("pm_ops");
});

test.each([[], ["--reason"], ["--reason", ""], ["--reason", " \n "]])(
  "merge request-changes refuses a missing or blank reason (%j)",
  async (...args) => {
    await seatAwaitingMerge();
    const before = JSON.stringify(state());
    const result = await cardigan("merge", "request-changes", card_id, ...args);
    expect(result.code).not.toBe(0);
    expect(result.err).toContain("--reason");
    expect(JSON.stringify(state())).toBe(before);
  },
);

test("merge request-changes refuses an already confirmed merge and documents its usage", async () => {
  await seatAwaitingMerge();
  await cardigan("merge", "confirm", card_id);
  expect(
    (await cardigan("merge", "request-changes", card_id, "--reason", "Fix"))
      .code,
  ).not.toBe(0);
  expect((await cardigan("merge")).err).toContain(
    "request-changes <C-n> --reason <原因>",
  );
  expect((await cardigan("--help")).out).toContain("request-changes");
});
