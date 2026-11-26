/**
 * M4.4 merge CLI (plan §4 M4.4): `cardigan merge status|confirm|request`.
 *
 * Drives the real domain commands (create → assign → deliver → review →
 * completion → review) to the `awaiting_merge` state, then exercises only the
 * CLI surface. The merge execution itself is covered by
 * `apps/server/src/merge-loop.test.ts`.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  Actor,
  Assignment,
  CardTemplate,
  CommandEffect,
  CommandPorts,
  CommandState,
  Decision,
  DecisionId,
  Delivery,
  ProjectId,
  Result,
  ToolName,
  WorkItem,
} from "@cardigan/domain";
import {
  acknowledgeRun,
  assign,
  autoMergeSchedule,
  createCard,
  developmentCardTemplate,
  dispatchRun,
  finishRun,
  prepareDelivery,
  prepareMergePlan,
  queueRun,
  recordMergeCheck,
  recordMergeCheckBlockers,
  recordMergePreparation,
  requestHumanAction,
  submitDelivery,
  submitReview,
  updateCard,
} from "@cardigan/domain";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import { routeEvent } from "@cardigan/router";
import { Store, writeRole } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { main } from "./index.js";
import type { CliIo } from "./io.js";

const TEST_PLAIN_SUMMARY = {
  changed: "测试用的改动说明",
  impact: "测试用的影响说明",
  risk: "无",
};

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
  env: { CARDIGAN_CONFIG_DIR: dataDir },
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
      ...(input.kind === "card_completion"
        ? { plain_summary: TEST_PLAIN_SUMMARY }
        : {}),
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
    plain_summary: TEST_PLAIN_SUMMARY,
    verifiers: [acceptance.id],
  });
  endRun(coder);
  runFor(pm);
  review(pm, completion);
  endRun(pm);
  return {
    card,
    development,
    completion,
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
  // C-674: full numbers, so the output means the same outside the project.
  expect(result.out).toContain(
    `MER-${card_id} awaiting_merge merge_policy=confirm`,
  );
  expect(result.out).toContain("confirmation: MER-Q-1 open");
  expect(result.out).toContain("delivery: MER-D-1 MER-W-1 git_head=");
  expect(result.out).toContain("plan: not ready");
  expect(result.out).toContain(
    `无法生成合并计划 ${card_id}：本次完成申请尚未获得合并确认（illegal_transition）`,
  );
});

test.each([false, true])(
  "C-577: enabling auto-merge uses the current gate when reassigning confirmations (configured=%s)",
  async (configured) => {
    const { confirmation } = await seatAwaitingMerge();
    expect(confirmation.decider).toBe("human");
    if (configured) enableMergeGate();
    expect((await cardigan("preference", "set", "auto-merge", "on")).code).toBe(
      0,
    );
    const open = state().decisions.filter(
      (q) => q.trigger === "merge_confirmation" && q.status === "open",
    );
    if (configured) {
      expect(open.map((q) => q.decider)).toEqual(["system"]);
    } else {
      expect(open).toEqual([confirmation]);
      expect((await cardigan("needs-you")).out).toContain("待你拍板（1）");
    }
  },
);

test("C-577: merge status reports the persisted system decider before handoff", async () => {
  await seatAwaitingMerge();
  store.uow.run((tx) => {
    const q = tx.decisions
      .list(project)
      .find((q) => q.trigger === "merge_confirmation");
    if (!q) throw new Error("Missing confirmation");
    tx.decisions.put(project, { ...q, decider: "system" });
  });
  expect((await cardigan("merge", "status", card_id)).out).toContain(
    "Q-1 open decider=system",
  );
});

test("C-112: merge status names the human action that holds the merge", async () => {
  await seatAwaitingMerge();
  expect((await cardigan("merge", "confirm", card_id)).code).toBe(0);
  const ask = (blocks_merge: boolean) =>
    apply((s, a, p) =>
      requestHumanAction(
        s,
        a,
        {
          card_id,
          instructions: "请查看主机日志",
          why_human: "只有主机能看",
          expected_return: "日志摘要",
          blocked_work_items: [],
          ...(blocks_merge
            ? { blocks_merge, prerequisite: "credential" as const }
            : {}),
        },
        p,
      ),
    );
  ask(false);
  expect((await cardigan("merge", "status", card_id)).out).toContain(
    "plan: ready",
  );
  const blocking = ask(true);
  apply((s, a, p) => recordMergeCheckBlockers(s, a, {}, p), {
    kind: "system",
    project_id: project,
  });
  const result = await cardigan("merge", "status", card_id);
  const since = new Date(NOW).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  expect(result.out).toContain(
    `合并检查未开始：被 ${blocking.id} 挡住（自 ${since} 起）：请查看主机日志`,
  );
  expect(result.out).toContain(
    `无法生成合并计划 ${card_id}：合并被待执行的人工事项 ${blocking.id} 挡住（illegal_transition）`,
  );
});

test("merge confirm records the merge decision with the command as the quote", async () => {
  await seatAwaitingMerge();
  const result = await cardigan("merge", "confirm", card_id);
  expect(result.code).toBe(0);
  expect(result.out).toContain(`已确认合并 ${card_id}`);
  expect(state().decisions.find((d) => d.id === "Q-1")).toMatchObject({
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
    state().decisions.find((d) => d.id === "Q-1")?.resolution?.raw_quote,
  ).toBe("merge it");
});

test("an unknown card is refused", async () => {
  const result = await cardigan("merge", "confirm", "C-9");
  expect(result.code).not.toBe(0);
  expect(result.err).toContain("C-9");
});

test.each(["open", "failed", "timed_out"] as const)(
  "merge request-changes records the human reason and routes a fix (%s)",
  async (status) => {
    const { development, confirmation } = await seatAwaitingMerge();
    if (status !== "open") {
      await cardigan("merge", "confirm", card_id);
      recordCheck("queued");
      recordCheck("running");
      recordCheck(status);
    }
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
    expect(
      current.decisions.find((q) => q.id === confirmation.id),
    ).toMatchObject({
      status: status === "open" ? "resolved" : "superseded",
      resolution:
        status === "open"
          ? {
              option: "request_changes",
              rationale: reason,
              raw_quote: reason,
              resolved_by: "human",
              via: "needs_you",
            }
          : { option: "merge" },
    });
    expect(current.cards[0]?.status).toBe("in_progress");
    const producer = current.work_items.find((w) => w.id === development.id);
    expect(producer?.status).toBe("changes_requested");
    const event = current.events.findLast(
      (e) => e.type === "merge_changes_requested",
    );
    if (!event) throw new Error("Missing return event");
    expect(routeEvent({ event, snapshot: current }).notifications).toEqual([
      expect.objectContaining({
        recipient: {
          kind: "assignment",
          assignment_id: producer?.assignment_id,
        },
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
  },
);

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

function enableMergeGate() {
  writeFileSync(
    join(dataDir, "merge-gate.yaml"),
    JSON.stringify({
      projects: { [project]: { checks: [{ name: "test", run: "true" }] } },
    }),
    { mode: 0o600 },
  );
}

function recordCheck(
  status:
    | "queued"
    | "running"
    | "passed"
    | "failed"
    | "timed_out"
    | "interrupted",
) {
  const plan = unwrap(prepareMergePlan(state(), card_id as never));
  const identity = {
    card_id: plan.card_id,
    completion_id: plan.completion_id,
    attempt_id: "cli-check",
    candidate_sha: SHA,
    tree_sha: "b".repeat(40),
  };
  apply(
    (s, a, p) =>
      recordMergeCheck(
        { ...s, project_settings: { merge_gate_enabled: true } },
        a,
        status === "queued" || status === "running"
          ? { ...identity, status }
          : {
              ...identity,
              status,
              checks: [
                {
                  name: "test",
                  status,
                  exit_code: status === "passed" ? 0 : 1,
                },
              ],
              summary: "fixture result",
              log_ref: "cli-check.log",
            },
        p,
      ),
    { kind: "system", project_id: project },
  );
}

test("merge recheck explains a missing card in Chinese without writing state", async () => {
  enableMergeGate();
  const before = JSON.stringify(state());
  const result = await cardigan("merge", "recheck", "C-99");
  expect(result.code).toBe(2);
  expect(result.err).toContain("C-99 不存在");
  expect(result.out).toBe("");
  expect(JSON.stringify(state())).toBe(before);
});

test("merge recheck explains a card outside awaiting_merge in Chinese without writing state", async () => {
  enableMergeGate();
  await seatAwaitingMerge();
  expect(
    (
      await cardigan(
        "merge",
        "request-changes",
        card_id,
        "--reason",
        "先修正交付",
      )
    ).code,
  ).toBe(0);
  const before = JSON.stringify(state());
  const result = await cardigan("merge", "recheck", card_id);
  expect(result.code).toBe(2);
  expect(result.err).toContain(`${card_id} 当前状态是 in_progress`);
  expect(result.err).toContain("只有 awaiting_merge");
  expect(result.out).toBe("");
  expect(JSON.stringify(state())).toBe(before);
});

test.each(["never", "queued", "running", "passed", "interrupted"] as const)(
  "merge recheck explains no retryable result in Chinese (%s)",
  async (status) => {
    enableMergeGate();
    await seatAwaitingMerge();
    if (status !== "never") recordCheck("queued");
    if (!["never", "queued"].includes(status)) recordCheck("running");
    if (status === "passed" || status === "interrupted") recordCheck(status);
    const before = JSON.stringify(state());
    const result = await cardigan("merge", "recheck", card_id);
    expect(result.code).toBe(2);
    expect(result.err).toContain(
      `${card_id} 当前完成申请没有失败或超时的检查结果，不能重新检查。`,
    );
    expect(result.err).not.toContain("Only a failed or timed-out");
    expect(result.out).toBe("");
    expect(JSON.stringify(state())).toBe(before);
  },
);

test.each(["failed", "timed_out"] as const)(
  "merge recheck accepts %s once and refuses a duplicate in Chinese",
  async (status) => {
    enableMergeGate();
    await seatAwaitingMerge();
    recordCheck("queued");
    recordCheck("running");
    recordCheck(status);
    const result = await cardigan("merge", "recheck", card_id);
    expect(result.code).toBe(0);
    expect(result.out).toContain(`已将 ${card_id} 的合并候选重新排队检查`);
    const before = JSON.stringify(state());
    const duplicate = await cardigan("merge", "recheck", card_id);
    expect(duplicate.code).toBe(2);
    expect(duplicate.err).toContain("当前完成申请没有失败或超时的检查结果");
    expect(JSON.stringify(state())).toBe(before);
  },
);

test.each([
  ["queued", "排队"],
  ["running", "运行中"],
  ["passed", "通过"],
  ["failed", "失败"],
  ["timed_out", "超时"],
  ["interrupted", "中断"],
] as const)(
  "needs-you waits until the current merge check passes (%s)",
  async (status, label) => {
    await seatAwaitingMerge();
    enableMergeGate();
    recordCheck("queued");
    if (status !== "queued") recordCheck("running");
    if (status !== "queued" && status !== "running") recordCheck(status);
    const result = await cardigan("needs-you");
    expect(result.code).toBe(0);
    // C-171: ended checks never pass by themselves; list them for the human.
    expect(result.out).toContain("待你拍板（1）");
    expect(result.out).toContain(`合并检查：${label}`);
    expect(result.out).not.toContain("排队或运行中");
    // C-675: the hint uses the full number, which the commands accept.
    const hint = `cardigan merge recheck MER-${card_id}`;
    if (status === "failed" || status === "timed_out")
      expect(result.out).toContain(
        `检查未通过，不会自己变成通过：cardigan merge request-changes MER-${card_id} --reason <原因>，偶发失败可 ${hint}`,
      );
    else expect(result.out).not.toContain(hint);
  },
);

test("C-115: a host-verified noop is actionable in needs-you without a fabricated pass", async () => {
  await seatAwaitingMerge();
  enableMergeGate();
  const plan = unwrap(prepareMergePlan(state(), card_id as never));
  apply(
    (s, a, p) =>
      recordMergePreparation(
        { ...s, project_settings: { merge_gate_enabled: true } },
        a,
        {
          card_id: plan.card_id,
          completion_id: plan.completion_id,
          base_sha: SHA,
          noop: true,
        },
        p,
      ),
    { kind: "system", project_id: project },
  );
  const result = await cardigan("needs-you");
  expect(result.code).toBe(0);
  expect(result.out).toContain("待你拍板");
  expect(result.out).toContain("交付已在基线中，无需合并检查");
  expect(result.out).not.toContain("排队或运行中");
  expect(result.out).not.toContain("合并检查：通过");
});

test("needs-you leaves projects without a gate unchanged and counts pending checks", async () => {
  await seatAwaitingMerge();
  expect((await cardigan("needs-you")).out).not.toContain("合并检查");
  enableMergeGate();
  expect((await cardigan("needs-you")).out).toContain("待你拍板（1）");
});

test.each([
  "projects: [private-config-fixture",
  JSON.stringify({
    projects: {
      [project]: { checks: [], env: { PRIVATE: "private-config-fixture" } },
    },
  }),
])(
  "needs-you warns about invalid configuration without echoing it (%s)",
  async (config) => {
    await seatAwaitingMerge();
    writeFileSync(join(dataDir, "merge-gate.yaml"), config, { mode: 0o600 });
    const before = JSON.stringify(state());
    const result = await cardigan("needs-you");
    expect(result.code).toBe(0);
    expect(result.out).toContain("待你拍板（1）");
    expect(result.out).toContain("合并闸门配置无效，请查看 server 启动日志");
    expect(result.out).not.toContain("合并检查：排队");
    expect(result.out + result.err).not.toContain("private-config-fixture");
    expect(JSON.stringify(state())).toBe(before);
  },
);
test.each(["queued", "running", "passed"] as const)(
  "merge request-changes refuses a confirmed %s check in Chinese without writes",
  async (status) => {
    await seatAwaitingMerge();
    await cardigan("merge", "confirm", card_id);
    recordCheck("queued");
    if (status !== "queued") recordCheck("running");
    if (status === "passed") recordCheck("passed");
    const before = JSON.stringify(state());
    const result = await cardigan(
      "merge",
      "request-changes",
      card_id,
      "--reason",
      "修复检查",
    );
    expect(result.code).not.toBe(0);
    expect(result.err).toContain("最新检查失败或超时");
    expect(JSON.stringify(state())).toBe(before);
  },
);

// C-65: the human answers PM-held merges directly and flags sensitive cards.
const holdWithPm = () =>
  store.uow.run((tx) => {
    const q = tx.decisions.get(project, "Q-1");
    if (!q) throw new Error("Missing confirmation");
    tx.decisions.put(project, { ...q, decider: "role:pm" });
  });

test.each([
  ["confirm", "merge"],
  ["hold", "hold"],
] as const)(
  "merge %s answers a PM-held confirmation as the human",
  async (sub, option) => {
    await seatAwaitingMerge();
    holdWithPm();
    expect((await cardigan("merge", "status", card_id)).out).toContain(
      "confirmation: MER-Q-1 open decider=PM（可直接处理）",
    );
    const needs = await cardigan("needs-you");
    expect(needs.out).toContain("PM 代确认中的合并（1");
    expect(needs.out).toContain(`cardigan merge confirm|hold MER-${card_id}`);
    // C-675: the full number from the hint works as the command argument.
    const result = await cardigan(
      "merge",
      sub,
      `MER-${card_id}`,
      ...(sub === "hold" ? ["--reason", "等待核对"] : []),
    );
    expect(result.code).toBe(0);
    expect(result.out).toContain("PM 代确认中，已按你的拍板记录");
    expect(state().decisions.find((d) => d.id === "Q-1")).toMatchObject({
      decider: "human",
      plain_summary: TEST_PLAIN_SUMMARY,
      ...(sub === "hold"
        ? { status: "snoozed", snooze: { reason: "等待核对", by: "human" } }
        : {
            status: "resolved",
            resolution: {
              option,
              resolved_by: "human",
              via: "needs_you",
              taken_over_from: "role:pm",
            },
          }),
    });
    expect((await cardigan("needs-you")).out).not.toContain(
      "PM 代确认中的合并",
    );
  },
);

test("merge request-changes answers a PM-held confirmation as the human", async () => {
  await seatAwaitingMerge();
  holdWithPm();
  const result = await cardigan(
    "merge",
    "request-changes",
    card_id,
    "--reason",
    "我来退回",
  );
  expect(result.code).toBe(0);
  expect(state().decisions.find((d) => d.id === "Q-1")).toMatchObject({
    decider: "human",
    plain_summary: TEST_PLAIN_SUMMARY,
    resolution: { option: "request_changes", taken_over_from: "role:pm" },
  });
});

test("card sensitive on|off is recorded and hands a PM-held merge to the human", async () => {
  await seatAwaitingMerge();
  holdWithPm();
  const on = await cardigan("card", "sensitive", card_id, "on");
  expect(on.code).toBe(0);
  expect(on.out).toContain(`已将 ${card_id} 标为敏感`);
  expect(state().cards.find((c) => c.id === card_id)?.sensitive).toBe(true);
  expect(state().decisions.find((d) => d.id === "Q-1")).toMatchObject({
    decider: "human",
    plain_summary: TEST_PLAIN_SUMMARY,
    status: "open",
  });
  const off = await cardigan("card", "sensitive", card_id, "off");
  expect(off.code).toBe(0);
  expect(
    state().cards.find((c) => c.id === card_id)?.sensitive,
  ).toBeUndefined();
  expect(
    state()
      .events.filter((e) => e.type === "card_sensitivity_changed")
      .map((e) => [
        e.actor.kind,
        (e.payload as { sensitive: boolean }).sensitive,
      ]),
  ).toEqual([
    ["human", true],
    ["human", false],
  ]);
  expect((await cardigan("card", "sensitive", card_id, "maybe")).code).toBe(2);
  // C-69: auto-merge is off here, so the unmark says nothing about a timeout.
  expect(off.out).not.toContain("分钟");
});

test("C-69: unmarking says when the timeout will auto-merge, only if it is on", async () => {
  await seatAwaitingMerge();
  expect(
    (await cardigan("preference", "set", "auto-merge-after", "15")).code,
  ).toBe(0);
  expect(
    (await cardigan("card", "sensitive", card_id, "on")).out,
  ).not.toContain("15 分钟");
  const off = await cardigan("card", "sensitive", card_id, "off");
  expect(off.code).toBe(0);
  expect(off.out).toContain(
    `已取消 ${card_id} 的敏感标记。如有等你处理的合并确认，从现在起重新计时，15 分钟内无人处理将按项目设置自动合并。`,
  );
});

test("C-72: a repeated unmark does not promise a restarted timeout", async () => {
  await seatAwaitingMerge();
  expect(
    (await cardigan("preference", "set", "auto-merge-after", "15")).code,
  ).toBe(0);
  expect((await cardigan("card", "sensitive", card_id, "on")).code).toBe(0);
  const first = await cardigan("card", "sensitive", card_id, "off");
  expect(first.out).toContain("从现在起重新计时");
  const changes = () =>
    state().events.filter((e) => e.type === "card_sensitivity_changed").length;
  const before = changes();
  const again = await cardigan("card", "sensitive", card_id, "off");
  expect(again.code).toBe(0);
  expect(changes()).toBe(before);
  expect(again.out).not.toContain("重新计时，");
  expect(again.out).toContain(
    `${card_id} 本来就没有敏感标记，这次没有改动，合并确认的超时计时也没有重新开始。`,
  );
  // The actual due time is unchanged by the no-op and shown as is.
  const due = unwrap(autoMergeSchedule(state(), "Q-1" as DecisionId)).due_at;
  expect(again.out).toContain(`当前合并确认将于 ${due} 按项目设置自动合并。`);
});

test("C-72: unmarking a never-sensitive card with the timeout off says so", async () => {
  await seatAwaitingMerge();
  const off = await cardigan("card", "sensitive", card_id, "off");
  expect(off.code).toBe(0);
  expect(off.out).toContain(`${card_id} 本来就没有敏感标记`);
  expect(off.out).not.toContain("重新计时，");
  expect(off.out).not.toContain("自动合并。");
});

test("merge push-accept validates its arguments and refuses an action without a push hold", async () => {
  const before = JSON.stringify(state());
  const bad = await cardigan("merge", "push-accept", "x1", "--text", "接受");
  expect(bad.code).toBe(2);
  expect(bad.err).toContain("HumanAction 编号不合法");
  const empty = await cardigan("merge", "push-accept", "H-1");
  expect(empty.code).toBe(2);
  expect(empty.err).toContain("--text");
  const missing = await cardigan(
    "merge",
    "push-accept",
    "H-1",
    "--text",
    "接受",
  );
  expect(missing.code).not.toBe(0);
  expect(missing.out).toBe("");
  expect(JSON.stringify(state())).toBe(before);
});

const setCheck = (
  label: string,
  status: "pending" | "passed" | "failed",
  note?: string,
) =>
  apply((s, a, p) =>
    updateCard(
      s,
      a,
      {
        card_id: card_id as never,
        pre_merge_check: { label, status, ...(note ? { note } : {}) },
      },
      p,
    ),
  );

test("C-264: unfinished pre-merge checks reject confirmation even with --yes", async () => {
  await seatAwaitingMerge();
  setCheck("独立安全审核", "pending");
  setCheck("截图核对", "failed", "按钮颜色不对");
  const status = await cardigan("merge", "status", card_id);
  expect(status.out).toContain(
    "合并前核对：!! 等待独立安全审核、截图核对，请先不要确认合并",
  );
  expect(status.out).toContain("    - 独立安全审核：待完成");
  expect(status.out).toContain("    - 截图核对：有问题（按钮颜色不对）");

  const refused = await cardigan("merge", "confirm", card_id);
  expect(refused.code).not.toBe(0);
  expect(refused.err).toContain("等待中：");
  expect(refused.err).toContain("独立安全审核：待核");
  expect(refused.err).toContain("截图核对：未通过");
  expect(state().decisions.find((d) => d.id === "Q-1")?.status).toBe("open");
  const anyway = await cardigan("merge", "confirm", card_id, "--yes");
  expect(anyway.code).not.toBe(0);
  expect(anyway.err).toContain("强行合并理由");
  expect(state().decisions.find((d) => d.id === "Q-1")?.status).toBe("open");
});

test("C-160: once every check passes, status says so and confirm needs no --yes", async () => {
  await seatAwaitingMerge();
  setCheck("独立安全审核", "passed");
  const status = await cardigan("merge", "status", card_id);
  expect(status.out).toContain("合并前核对：核对已完成，可以确认合并");
  expect(status.out).toContain("    - 独立安全审核：已通过");
  const result = await cardigan("merge", "confirm", card_id);
  expect(result.code).toBe(0);
  expect(result.out).not.toContain("!!");
});

test("C-160: hold is not gated by unfinished pre-merge checks", async () => {
  await seatAwaitingMerge();
  setCheck("独立安全审核", "pending");
  const result = await cardigan(
    "merge",
    "hold",
    card_id,
    "--reason",
    "等待核对",
  );
  expect(result.code).toBe(0);
});

test("C-180: hold requires a reason, accepts an explicit expiry, and merge status and needs-you show it", async () => {
  await seatAwaitingMerge();
  expect((await cardigan("merge", "hold", card_id)).code).toBe(2);
  expect(state().decisions.find((q) => q.id === "Q-1")?.status).toBe("open");
  const until = new Date(Date.now() + 90 * 60_000).toISOString();
  expect(
    (
      await cardigan(
        "merge",
        "hold",
        card_id,
        "--reason",
        "等待核对",
        "--until",
        until,
      )
    ).code,
  ).toBe(0);
  expect(state().decisions.find((q) => q.id === "Q-1")).toMatchObject({
    status: "snoozed",
    snooze: { reason: "等待核对", until },
  });
  const time = new Date(until).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  expect((await cardigan("merge", "status", card_id)).out).toContain(
    `已暂缓：等待核对（到 ${time}）`,
  );
  expect((await cardigan("needs-you")).out).toContain(
    `已暂缓：等待核对（到 ${time}）`,
  );
});

test("C-193: CLI surfaces snooze cap failures without changing the confirmation", async () => {
  await seatAwaitingMerge();
  const before = state().decisions;
  const result = await cardigan(
    "merge",
    "hold",
    card_id,
    "--reason",
    "等待",
    "--until",
    new Date(Date.now() + 4321 * 60_000).toISOString(),
  );
  expect(result.code).not.toBe(0);
  expect(result.err).toContain("暂缓到期时间距现在不能超过 4320 分钟");
  expect(state().decisions).toEqual(before);
});

test("C-264: CLI uses the configured gate and rejects queued/running checks, then allows passed", async () => {
  await seatAwaitingMerge();
  enableMergeGate();
  for (const status of [undefined, "queued", "running", "passed"] as const) {
    if (status) recordCheck(status);
    const result = await cardigan("merge", "confirm", card_id);
    if (status === "passed") expect(result.code).toBe(0);
    else {
      expect(result.code).not.toBe(0);
      expect(result.err).toContain("合并检查：");
      expect(state().decisions.find((q) => q.id === "Q-1")?.status).toBe(
        "open",
      );
    }
  }
});

test("Q-440: CLI requires an explicit override reason and records the observed blockers", async () => {
  await seatAwaitingMerge();
  setCheck("截图核对", "pending");
  const before = JSON.stringify(state());
  expect(
    (await cardigan("merge", "confirm", card_id, "--yes", "--reason", " "))
      .code,
  ).not.toBe(0);
  expect(JSON.stringify(state())).toBe(before);
  const result = await cardigan(
    "merge",
    "confirm",
    card_id,
    "--yes",
    "--reason",
    "已人工核实紧急事项",
  );
  expect(result.code).toBe(0);
  expect(result.out).toContain("已记录强行确认");
  expect(
    state().decisions.find((q) => q.id === "Q-1")?.resolution?.merge_override,
  ).toEqual({ reason: "已人工核实紧急事项", blockers: ["截图核对：待核"] });
  expect(
    state().timeline.some(
      (t) =>
        t.body.includes("已人工核实紧急事项") &&
        t.body.includes("截图核对：待核"),
    ),
  ).toBe(true);
});

test("C-760: CLI override refuses an open hold unless --follow-up-actions turns it into a follow-up", async () => {
  await seatAwaitingMerge();
  const hold = apply((s, a, p) =>
    requestHumanAction(
      s,
      a,
      {
        card_id: card_id as never,
        instructions: "在 Google 后台配置账号",
        why_human: "只有所有者有账号",
        executor: "owner",
        expected_return: "配置完成",
        blocked_work_items: [],
        blocks_merge: true,
        prerequisite: "external_account",
      },
      p,
    ),
  );
  const before = JSON.stringify(state().decisions);
  const refused = await cardigan(
    "merge",
    "confirm",
    card_id,
    "--yes",
    "--reason",
    "账号合并后再配",
  );
  expect(refused.code).not.toBe(0);
  expect(refused.err).toContain(hold.id);
  expect(JSON.stringify(state().decisions)).toBe(before);
  const result = await cardigan(
    "merge",
    "confirm",
    card_id,
    "--yes",
    "--reason",
    "账号合并后再配",
    "--follow-up-actions",
  );
  expect(result.code).toBe(0);
  expect(state().human_actions.find((h) => h.id === hold.id)).toMatchObject({
    status: "open",
    blocks_merge: false,
    merge_blocking_changes: [{ via: "merge_override", by: "human" }],
  });
});

test("Q-440: CLI Token mode cannot use the human override", async () => {
  await seatAwaitingMerge();
  setCheck("截图核对", "pending");
  const before = JSON.stringify(state());
  const cli = io();
  const code = await main(
    [
      "merge",
      "confirm",
      card_id,
      "--yes",
      "--reason",
      "已核实",
      "--data-dir",
      dataDir,
    ],
    { ...cli, env: { ...cli.env, CARDIGAN_TOKEN: "fixture-agent-token" } },
  );
  expect(code).not.toBe(0);
  expect(JSON.stringify(state())).toBe(before);
});

test.each([
  { name: "blank", reason: " \n\t ", valid: false },
  { name: "499", reason: "字".repeat(499), valid: true },
  { name: "500", reason: "字".repeat(500), valid: true },
  { name: "501", reason: "字".repeat(501), valid: false },
  {
    name: "500 astral plus trim",
    reason: ` \n${"😀".repeat(500)}\t `,
    valid: true,
  },
  { name: "501 astral", reason: "😀".repeat(501), valid: false },
  { name: "500 combining", reason: "e\u0301".repeat(250), valid: true },
  { name: "501 combining", reason: `${"e\u0301".repeat(250)}a`, valid: false },
])(
  "Q-458: CLI enforces $name code-point boundary",
  async ({ reason, valid }) => {
    await seatAwaitingMerge();
    setCheck("截图核对", "pending");
    const before = JSON.stringify(state());
    const result = await cardigan(
      "merge",
      "confirm",
      card_id,
      "--yes",
      "--reason",
      reason,
    );
    expect(result.code === 0).toBe(valid);
    if (valid) {
      expect(
        state().decisions.find((q) => q.id === "Q-1")?.resolution
          ?.merge_override?.reason,
      ).toBe(reason.trim());
      expect(state().timeline.some((t) => t.body.includes(reason.trim()))).toBe(
        true,
      );
    } else {
      expect(JSON.stringify(state())).toBe(before);
      if (reason.trim())
        expect(result.err).toContain("理由最多500个字符，请缩短后再提交。");
    }
  },
);

test("human can explicitly recheck a residual registration without reopening the merge or granting deletion", async () => {
  const { CheckRecoveryJournal } = await import("@cardigan/store");
  const sample = (
    await import("../../../packages/domain/src/commands/test-fixtures.js")
  ).card();
  card_id = sample.id;
  store.uow.run((tx) =>
    tx.cards.put(project, { ...sample, project_id: project }),
  );
  const registration = store.uow.run((tx) => {
    const e = {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(project, card_id),
      card_id,
      type: "merge_check_checkout_registered",
      actor: { kind: "system" as const, project_id: project },
      created_at: NOW,
      payload: {
        attempt_id: "residual-attempt",
        candidate_sha: SHA,
        executor_key: "synthetic-executor",
        binding: {},
      },
    };
    tx.events.append(project, e);
    return e.id;
  });
  const journal = new CheckRecoveryJournal(store),
    row = journal.get(project, registration);
  if (!row) throw new Error("Missing registration fixture");
  store.uow.run(() => {
    const revision = journal.claim(project, row, "2099-01-01T00:00:00.000Z");
    if (revision === undefined) throw new Error("Missing fixture claim");
    journal.settle(
      project,
      row,
      revision,
      { status: "manual_attention", reason: "unverified", processes: [] },
      "synthetic",
    );
  });
  const result = await cardigan("merge", "recovery-recheck", registration);
  expect(result.code).toBe(0);
  expect(journal.get(project, registration)).toMatchObject({
    state: "pending",
    next_inspection_at: "",
  });
  expect(state().events.at(-1)).toMatchObject({
    type: "merge_check_recovery_recheck_requested",
    actor: human,
  });
  const before = state().events.length;
  expect(
    (await cardigan("merge", "recovery-recheck", "unknown-registration")).code,
  ).not.toBe(0);
  expect(state().events).toHaveLength(before);
  const tokenIo = {
    ...io(),
    env: { ...io().env, CARDIGAN_TOKEN: "synthetic-denied-token" },
  };
  expect(
    await main(
      ["merge", "recovery-recheck", registration, "--data-dir", dataDir],
      tokenIo,
    ),
  ).not.toBe(0);
  expect(state().events).toHaveLength(before);
});

async function abandonedCliDispatch() {
  const { card, completion } = await seatAwaitingMerge();
  const {
    GithubCheckExecutor,
    GithubClient,
    GithubDispatchJournal,
    loadMergeGateConfig,
    githubCheckRunName,
  } = await import("@cardigan/host");
  writeFileSync(join(dataDir, "ci.key"), "synthetic", { mode: 0o600 });
  const cfg = {
    executors: {
      ci: {
        type: "github",
        repo: "fixture/project",
        workflow: ".github/workflows/check.yml",
        app_id: 1,
        installation_id: 2,
        private_key_file: "ci.key",
        bot_login: "fixture[bot]",
        max_concurrent: 1,
      },
    },
    projects: {
      [project]: { checks: [{ name: "test", run: "true" }], executor: "ci" },
    },
  };
  writeFileSync(join(dataDir, "merge-gate.yaml"), JSON.stringify(cfg), {
    mode: 0o600,
  });
  const config = (
    await loadMergeGateConfig({ dataDir, env: io().env })
  ).forExecutor?.("ci");
  if (config?.type !== "github") throw new Error("Missing test executor");
  const attempt = "old-cli-check",
    tree = "b".repeat(40);
  apply(
    (s, a, p) =>
      recordMergeCheck(
        { ...s, project_settings: { merge_gate_enabled: true } },
        a,
        {
          card_id: card.id,
          completion_id: completion.id,
          attempt_id: attempt,
          candidate_sha: SHA,
          tree_sha: tree,
          status: "queued",
          executor: { name: "ci", type: "github" },
        },
        p,
      ),
    { kind: "system", project_id: project },
  );
  const journal = new GithubDispatchJournal(store);
  const request = {
    kind: "merge_check" as const,
    project,
    attempt,
    sha: SHA,
    tree,
    checks: [{ name: "test", run: "true" }],
  };
  const executor = new GithubCheckExecutor({
    config,
    journal,
    now: () => Date.parse("2020-01-01T00:00:00Z"),
    context: () => ({
      card: card.id,
      delivery: completion.id,
      baselineBranch: "main",
    }),
    client: {
      token: async () => "fixture",
      dispatch: async () => undefined,
      runs: async () => [],
      run: vi.fn(),
    },
    push: async () => ({ status: "pushed" }),
    isBaselineAncestor: async () => true,
    lifecycle: { cancel: vi.fn(), poll: vi.fn(), fetchFailureLog: vi.fn() },
  });
  await expect(executor.dispatch(request)).rejects.toMatchObject({
    retryAt: expect.any(Number),
  });
  journal.reconcile([project], () => ({ status: "disabled" }));
  const cli = () => cardigan("merge", "finish-undispatched", card.id, attempt);
  const list = vi.spyOn(GithubClient.prototype, "runs");
  return {
    card,
    cli,
    journal,
    list,
    matchingRun: {
      id: 123,
      run_attempt: 1,
      path: config.workflow,
      event: "workflow_dispatch",
      head_branch: "main",
      head_sha: SHA,
      actor: { login: config.botLogin },
      html_url: `https://github.com/${config.repo}/actions/runs/123`,
      created_at: "2020-01-01T00:00:00Z",
      display_title: githubCheckRunName({
        sha: SHA,
        tree,
        attempt,
        kind: "merge_check",
        card: card.id,
        delivery: completion.id,
      }),
    },
  };
}

test.each(["dead_writer", "live_legacy"] as const)(
  "finish-undispatched handles the POST writer without a background worker (%s)",
  async (mode) => {
    const { card, cli, journal, list } = await abandonedCliDispatch();
    try {
      const [current] = journal.admitted();
      if (!current) throw new Error("Missing dispatch");
      store.uow.run((tx) => {
        const history = tx.events.listAfter(project, card.id, 0);
        const publishing = history.find(
          (e) =>
            e.type === "github_check_dispatch" &&
            e.payload.phase === "publishing",
        );
        const publisher = publishing?.payload.publisher as {
          pid: number;
          start: string;
        };
        expect(publisher.pid).toBe(process.pid);
        const {
          absenceNotBefore: _,
          nextDiscoveryAt: _cadence,
          ...rest
        } = current;
        tx.events.append(project, {
          id: tx.ids.nextEventId(),
          seq: tx.ids.nextEventSequence(project, card.id),
          card_id: card.id,
          actor: { kind: "system", project_id: project },
          type: "github_check_dispatch",
          payload: JSON.parse(
            JSON.stringify({
              ...rest,
              ...(mode === "dead_writer"
                ? {
                    postOwner: { ...publisher, start: `${publisher.start}0` },
                  }
                : {}),
            }),
          ),
          created_at: NOW,
        });
      });
      expect((await cli()).code).not.toBe(0);
      expect(list).not.toHaveBeenCalled();
      const [held] = journal.admitted();
      if (!held) throw new Error("Missing held dispatch");
      if (mode === "live_legacy") {
        expect(held.absenceNotBefore).toBeUndefined();
        expect(held.nextDiscoveryAt).toBeUndefined();
        return;
      }
      expect(held.absenceNotBefore).toBeGreaterThan(Date.now());
      expect(held.postOwner).toBeUndefined();
      const grace = held.absenceNotBefore;
      if (!grace) throw new Error("Missing visibility window");
      const clock = vi.spyOn(Date, "now");
      try {
        clock.mockReturnValue(grace - 1);
        expect((await cli()).code).not.toBe(0);
        expect(list).not.toHaveBeenCalled();
        clock.mockReturnValue(grace);
        list.mockResolvedValueOnce([]);
        expect((await cli()).code).toBe(0);
        expect(list).toHaveBeenCalledOnce();
        expect(journal.admitted()).toEqual([]);
      } finally {
        clock.mockRestore();
      }
    } finally {
      list.mockRestore();
    }
  },
);

test.each(["absent", "match"] as const)(
  "finish-undispatched verifies the original GitHub workflow online (%s)",
  async (mode) => {
    const { cli, journal, list, matchingRun } = await abandonedCliDispatch();
    try {
      list.mockRejectedValueOnce(new Error("partial listing"));
      expect((await cli()).code).not.toBe(0);
      expect(journal.admitted()).toHaveLength(1);
      if (mode === "match") {
        list.mockResolvedValueOnce([matchingRun]);
        expect((await cli()).code).not.toBe(0);
        expect(journal.admitted()).toHaveLength(1);
        list.mockResolvedValue([]);
        expect((await cli()).code).not.toBe(0);
        expect(journal.admitted()).toMatchObject([{ observedRunIds: [123] }]);
        return;
      }
      list.mockResolvedValueOnce([]);
      expect(await cli()).toMatchObject({
        code: 0,
        out: expect.stringContaining("已核实未派发"),
      });
      expect(list).toHaveBeenCalledTimes(2);
      expect(journal.admitted()).toEqual([]);
      expect(journal.all()[0]?.undispatched).toMatchObject({
        source: "human",
        listed: 0,
      });
    } finally {
      list.mockRestore();
    }
  },
);

test("finish-undispatched rechecks online after another reader retired under a SQLite write lock", async () => {
  const { cli, journal, list } = await abandonedCliDispatch();
  try {
    const [intent] = journal.admitted();
    if (!intent) throw new Error("Missing dispatch");
    const scan = journal.beginDiscovery(intent, Date.now(), 20_000);
    list.mockResolvedValue([]);
    expect((await cli()).code).not.toBe(0);
    expect(list).not.toHaveBeenCalled();
    const db = store.database.location();
    if (!db) throw new Error("Missing fixture DB");
    store.database.exec("PRAGMA busy_timeout=10");
    const locker = new DatabaseSync(db);
    try {
      locker.exec("BEGIN IMMEDIATE");
      expect(() => journal.endListing(scan, [])).toThrow();
    } finally {
      locker.exec("ROLLBACK");
      locker.close();
    }
    expect(journal.admitted()).toHaveLength(1);
    expect((await cli()).code).toBe(0);
    expect(list).toHaveBeenCalledOnce();
    expect(journal.admitted()).toEqual([]);
  } finally {
    list.mockRestore();
  }
});

test("finish-undispatched preserves uncertainty when it is the first to recover an interrupted reader", async () => {
  const { card, cli, journal, list } = await abandonedCliDispatch();
  try {
    const [intent] = journal.admitted();
    if (!intent) throw new Error("Missing dispatch");
    const scan = journal.beginDiscovery(intent, Date.now(), 20_000);
    const owner = scan.scanOwner;
    if (!owner) throw new Error("Missing scan owner");
    // Durable state after a reader exits before any receipt; even a reused PID isn't that incarnation.
    store.uow.run((tx) =>
      tx.events.append(project, {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(project, card.id),
        card_id: card.id,
        actor: { kind: "system", project_id: project },
        type: "github_check_dispatch",
        payload: JSON.parse(
          JSON.stringify({
            ...scan,
            scanOwner: { ...owner, start: `${owner.start}0` },
          }),
        ),
        created_at: NOW,
      }),
    );
    list.mockResolvedValue([]);
    for (let i = 0; i < 2; i++) {
      expect((await cli()).code).not.toBe(0);
      expect(journal.admitted()).toMatchObject([
        { attempt: intent.attempt, scanEvidenceLost: true },
      ]);
      expect(journal.admitted()[0]?.undispatched).toBeUndefined();
    }
    expect(list).not.toHaveBeenCalled();
  } finally {
    list.mockRestore();
  }
});
