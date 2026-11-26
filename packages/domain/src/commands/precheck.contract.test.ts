import { expect, test } from "vitest";
import {
  type Actor,
  CheckHeadFailure,
  type CommandState,
  checkHeadFailureReasons,
  hasPassedMergeCheck,
  type Precheck,
  prechecks,
  precheckView,
  prepareCheck,
  recordMergeResult,
  recordPrecheck,
  requestCheck,
  updateCard,
} from "../index.js";
import {
  actor,
  apply,
  fixture,
  human,
  id,
  ports,
  value,
} from "./test-fixtures.js";

const system: Actor = { kind: "system", project_id: human.project_id };
const params = { work_item_id: id("work_item", 1) };
const head = "a".repeat(40);
function setup() {
  const base = fixture();
  const state: CommandState = {
    ...base,
    cards: base.cards.map((c) => ({ ...c, flow_version: 3 })),
    assignments: base.assignments.map((a) =>
      a.id === id("assignment", 1)
        ? { ...a, branch: "agent/test", worktree_path: "/synthetic/worktree" }
        : a,
    ),
  };
  return { state, io: ports() };
}
async function queued(s: CommandState, io = ports()) {
  const receipt = await prepareCheck(s, actor(), params, {
    head: async () => head,
  });
  if (!receipt.ok) return receipt;
  return requestCheck(s, actor(), params, receipt.value, io);
}
const running = (c: Precheck): Precheck => ({
  ...c,
  status: "running",
  candidate_sha: "b".repeat(40),
  tree_sha: "c".repeat(40),
  base_sha: "d".repeat(40),
  executor: { name: "ci", type: "ssh" },
});

test("candidate-conflict recovery evidence is accepted only before execution and cannot pass a precheck", async () => {
  const f = setup();
  const state = apply(f.state, value(await queued(f.state, f.io)));
  const check = prechecks(state.events)[0]!;
  const conflict = {
    ...check,
    status: "environment_failed" as const,
    failure_kind: "candidate_conflict" as const,
    base_sha: "b".repeat(40),
  };
  expect(
    value(recordPrecheck(state, system, conflict, f.io)).data,
  ).toMatchObject({
    failure_kind: "candidate_conflict",
    status: "environment_failed",
  });
  expect(recordPrecheck(state, actor(), conflict, f.io).ok).toBe(false);
  expect(
    recordPrecheck(state, system, { ...conflict, base_sha: "invalid" }, f.io)
      .ok,
  ).toBe(false);
  expect(
    recordPrecheck(
      state,
      system,
      { ...running(check), failure_kind: "candidate_conflict" },
      f.io,
    ).ok,
  ).toBe(false);
});

test("only the active current producer can request its recorded HEAD, with no duplicate in-flight attempt", async () => {
  const f = setup();
  const e = value(await queued(f.state, f.io));
  const s = apply(f.state, e);
  expect(e.data).toMatchObject({
    head_sha: head,
    status: "queued",
    assignment_id: id("assignment", 1),
  });
  expect(e.events[0]?.actor.kind).toBe("system");
  expect(JSON.stringify(e)).not.toContain("/synthetic");
  expect((await queued(s, f.io)).ok).toBe(false);
  for (const caller of [
    human,
    system,
    actor(2, "reviewer"),
    { ...actor(), project_id: "foreign" },
  ])
    expect(
      (await prepareCheck(f.state, caller, params, { head: async () => head }))
        .ok,
    ).toBe(false);
  const released = {
    ...f.state,
    assignments: f.state.assignments.map((a) => ({
      ...a,
      status: "released" as const,
    })),
  };
  expect((await queued(released)).ok).toBe(false);
});
test.each([undefined, 1, 2])(
  "old flow %s never reaches the host HEAD reader",
  async (version) => {
    const f = setup();
    let reads = 0;
    const state = {
      ...f.state,
      cards: f.state.cards.map(({ flow_version: _old, ...c }) => ({
        ...c,
        ...(version === undefined ? {} : { flow_version: version }),
      })),
    };
    expect(
      (
        await prepareCheck(state, actor(), params, {
          head: async () => {
            reads++;
            return head;
          },
        })
      ).ok,
    ).toBe(false);
    expect(reads).toBe(0);
  },
);
test("C-632: host HEAD failures map to a fixed reason and next step, never the raw error", async () => {
  const f = setup();
  const raw = "fatal: https://user:token@example.invalid /private/path";
  const messages = new Set<string>();
  for (const reason of checkHeadFailureReasons) {
    const result = await prepareCheck(f.state, actor(), params, {
      head: async () => {
        throw new CheckHeadFailure(reason, { cause: new Error(raw) });
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) continue;
    expect(result.error).toMatchObject({
      code: "validation_failed",
      details: {
        reason,
        retryable: reason === "repository_busy" || reason === "fetch_failed",
      },
    });
    expect(JSON.stringify(result.error)).not.toMatch(/token|private|fatal/u);
    expect(result.error.message).toMatch(/；请/u);
    messages.add(result.error.message);
  }
  // Every reason reads differently to the Agent.
  expect(messages.size).toBe(checkHeadFailureReasons.length);
  const busy = await prepareCheck(f.state, actor(), params, {
    head: async () => {
      throw new CheckHeadFailure("repository_busy");
    },
  });
  expect(!busy.ok && busy.error.message).toContain("主机仓库忙");
  // A duplicated module instance is still recognised by name and reason.
  const foreign = Object.assign(new Error("x"), {
    name: "CheckHeadFailure",
    reason: "branch_missing",
  });
  const forged = Object.assign(new Error(raw), {
    name: "CheckHeadFailure",
    reason: "not-a-reason",
  });
  const read = async (error: Error) =>
    prepareCheck(f.state, actor(), params, {
      head: async () => {
        throw error;
      },
    });
  expect(await read(foreign)).toMatchObject({
    ok: false,
    error: { details: { reason: "branch_missing", retryable: false } },
  });
  const unknown = await read(forged);
  expect(unknown).toMatchObject({
    ok: false,
    error: { details: { reason: "unknown", retryable: true } },
  });
  expect(JSON.stringify(unknown)).not.toMatch(/token|private|fatal/u);
  expect(await read(new Error(raw))).toMatchObject({
    ok: false,
    error: { details: { reason: "unknown" } },
  });
});
test("prepared identity is revalidated after async IO and concurrent preparation cannot bypass in-flight exclusion", async () => {
  const f = setup();
  const receipt = value(
    await prepareCheck(f.state, actor(), params, { head: async () => head }),
  );
  const changed = {
    ...f.state,
    assignments: f.state.assignments.map((a) => ({ ...a, branch: "other" })),
  };
  expect(requestCheck(changed, actor(), params, receipt, f.io).ok).toBe(false);
  const first = value(requestCheck(f.state, actor(), params, receipt, f.io));
  expect(
    requestCheck(apply(f.state, first), actor(), params, receipt, f.io).ok,
  ).toBe(false);
});
test("system-only results bind the complete candidate, late and forged results fail, and passing never authorizes merging", async () => {
  const f = setup();
  const queuedEffect = value(await queued(f.state, f.io));
  let s = apply(f.state, queuedEffect);
  const initial = prechecks(s.events)[0]!;
  const start = running(initial);
  expect(recordPrecheck(s, actor(), start, f.io).ok).toBe(false);
  s = apply(s, value(recordPrecheck(s, system, start, f.io)));
  const done: Precheck = {
    ...start,
    status: "passed",
    checks: [{ name: "test", status: "passed", exit_code: 0 }],
    log_ref: `${start.attempt_id}.log`,
  };
  for (const patch of [
    { head_sha: "e".repeat(40) },
    { tree_sha: "e".repeat(40) },
    { assignment_id: id("assignment", 2) },
    { log_ref: "/private/log" },
  ])
    expect(recordPrecheck(s, system, { ...done, ...patch }, f.io).ok).toBe(
      false,
    );
  s = apply(s, value(recordPrecheck(s, system, done, f.io)));
  expect(recordPrecheck(s, system, done, f.io).ok).toBe(false);
  expect(
    hasPassedMergeCheck(
      s.events,
      id("card", 1),
      id("delivery", 1),
      done.tree_sha!,
    ),
  ).toBe(false);
  expect(
    recordMergeResult(
      s,
      system,
      {
        card_id: id("card", 1),
        completion_id: id("delivery", 1),
        result: {
          kind: "merged",
          merge_sha: done.candidate_sha!,
          previous_sha: done.base_sha!,
          tree_sha: done.tree_sha!,
        },
      },
      f.io,
    ).ok,
  ).toBe(false);
  expect((await queued(s, f.io)).ok).toBe(true);
  expect(precheckView(done)).not.toHaveProperty("branch");
});
test("released owners can only settle interrupted, and GitHub success requires an immutable trusted external run", async () => {
  const f = setup();
  let s = apply(f.state, value(await queued(f.state, f.io)));
  const c = prechecks(s.events)[0]!;
  const gh = {
    ...running(c),
    executor: { name: "github", type: "github" as const },
  };
  expect(recordPrecheck(s, system, gh, f.io).ok).toBe(false);
  const external = {
    provider: "github" as const,
    run_id: 12,
    run_attempt: 1,
    html_url: "https://github.com/example/repo/actions/runs/12",
    workflow_sha: "e".repeat(40),
  };
  s = apply(
    s,
    value(recordPrecheck(s, system, { ...gh, external_run: external }, f.io)),
  );
  expect(
    recordPrecheck(
      s,
      system,
      { ...gh, external_run: { ...external, run_id: 13 }, status: "failed" },
      f.io,
    ).ok,
  ).toBe(false);
  for (const [summary, allowed] of [
    [`日志获取失败（not_found）：${external.html_url}/job/34`, true],
    [`日志获取失败（api）：${external.html_url}`, true],
    [`${external.html_url}/job/34?token=private`, false],
    [`private /unsafe ${external.html_url}/job/34`, false],
    ["https://github.com/example/repo/actions/runs/99/job/34", false],
  ] as const) {
    expect(
      recordPrecheck(
        s,
        system,
        { ...gh, external_run: external, status: "failed", summary },
        f.io,
      ).ok,
    ).toBe(allowed);
  }
  const released = {
    ...s,
    assignments: s.assignments.map((a) => ({
      ...a,
      status: "released" as const,
    })),
  };
  expect(
    recordPrecheck(
      released,
      system,
      { ...gh, external_run: external, status: "failed" },
      f.io,
    ).ok,
  ).toBe(false);
  expect(
    recordPrecheck(
      released,
      system,
      { ...gh, external_run: external, status: "interrupted" },
      f.io,
    ).ok,
  ).toBe(true);
});
test("environment failures persist once, never invent reviews or return the work item", async () => {
  const f = setup();
  let s = apply(f.state, value(await queued(f.state, f.io)));
  const c = prechecks(s.events)[0]!;
  s = apply(
    s,
    value(
      recordPrecheck(
        s,
        system,
        {
          ...c,
          status: "environment_failed",
          summary: "预检查环境故障（日志）",
        },
        f.io,
      ),
    ),
  );
  expect(s.work_items).toEqual(f.state.work_items);
  expect(s.reviews).toEqual([]);
  expect(recordPrecheck(s, system, { ...c, status: "running" }, f.io).ok).toBe(
    false,
  );
});

test.each([
  "fatal: '/' is outside repository",
  'rsync: change_dir "/" failed',
  "at /<anonymous>",
  String.raw`failed at C:\"`,
])(
  "failure summaries retain the original domain rejection for unsafe path shapes: %s",
  async (summary) => {
    const f = setup();
    let s = apply(f.state, value(await queued(f.state, f.io)));
    const initial = prechecks(s.events)[0]!;
    const rejected = recordPrecheck(
      s,
      system,
      { ...initial, status: "environment_failed", summary },
      f.io,
    );
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: "validation_failed" },
    });
    const safe = value(
      recordPrecheck(
        s,
        system,
        {
          ...initial,
          status: "environment_failed",
          summary: "预检查环境故障（诊断内容已省略）",
        },
        f.io,
      ),
    );
    s = apply(s, safe);
    expect(prechecks(s.events)[0]?.status).toBe("environment_failed");
    expect((await queued(s, f.io)).ok).toBe(true);
  },
);

test("hold arriving during HEAD preparation rejects the request in the fresh write snapshot", async () => {
  const f = setup();
  const proof = value(
    await prepareCheck(f.state, actor(), params, { head: async () => head }),
  );
  const state = apply(
    f.state,
    value(
      updateCard(
        f.state,
        human,
        {
          card_id: id("card", 1),
          hold: { reason: "wait", resume_condition: "ready" },
        },
        f.io,
      ),
    ),
  );
  expect(requestCheck(state, actor(), params, proof, f.io)).toMatchObject({
    ok: false,
    error: { code: "illegal_transition" },
  });
  expect((await queued(state, f.io)).ok).toBe(false);
  expect(prechecks(state.events)).toEqual([]);
});
async function queuedAt(s: CommandState, at: string, io = ports()) {
  const receipt = await prepareCheck(s, actor(), params, {
    head: async () => at,
  });
  if (!receipt.ok) return receipt;
  return requestCheck(s, actor(), params, receipt.value, io);
}
const inFlight = (s: CommandState) =>
  prechecks(s.events).filter((c) => ["queued", "running"].includes(c.status));
test.each(["queued", "running"] as const)(
  "C-783: a new HEAD supersedes the %s attempt in the same transaction, keeping one slot",
  async (phase) => {
    const f = setup();
    let s = apply(f.state, value(await queued(f.state, f.io)));
    const old = prechecks(s.events)[0]!;
    if (phase === "running")
      s = apply(s, value(recordPrecheck(s, system, running(old), f.io)));
    const newer = "e".repeat(40);
    const effect = value(await queuedAt(s, newer, f.io));
    expect(effect.events.map((e) => [e.type, e.actor.kind])).toEqual([
      ["precheck_finished", "system"],
      ["precheck_queued", "system"],
    ]);
    s = apply(s, effect);
    const replaced = prechecks(s.events).find(
      (c) => c.attempt_id === old.attempt_id,
    )!;
    expect(replaced).toMatchObject({
      status: "interrupted",
      head_sha: head,
      superseded_by: effect.data.attempt_id,
      summary: expect.stringContaining(newer.slice(0, 12)),
    });
    if (phase === "running")
      // The executor identity is kept so the host can cancel the bound run.
      expect(replaced).toMatchObject({ executor: { name: "ci", type: "ssh" } });
    expect(inFlight(s)).toEqual([
      expect.objectContaining({ head_sha: newer, status: "queued" }),
    ]);
    // The latest attempt for the Assignment is the new one (journal supersession).
    expect(prechecks(s.events).at(-1)?.attempt_id).toBe(effect.data.attempt_id);
    // A late host result for the replaced attempt can never be published.
    expect(
      recordPrecheck(
        s,
        system,
        {
          ...running(old),
          status: "passed",
          checks: [{ name: "test", status: "passed", exit_code: 0 }],
        },
        f.io,
      ).ok,
    ).toBe(false);
    expect(
      recordPrecheck(s, system, { ...old, status: "interrupted" }, f.io).ok,
    ).toBe(false);
    expect(JSON.stringify(effect)).not.toContain("/synthetic");
  },
);
test("C-783: the same HEAD never supersedes, re-queues or takes a second precheck slot", async () => {
  const f = setup();
  let s = apply(f.state, value(await queued(f.state, f.io)));
  const old = prechecks(s.events)[0]!;
  for (const phase of ["queued", "running"] as const) {
    if (phase === "running")
      s = apply(s, value(recordPrecheck(s, system, running(old), f.io)));
    const again = await queuedAt(s, head, f.io);
    expect(again).toMatchObject({
      ok: false,
      error: { code: "illegal_transition" },
    });
    expect(inFlight(s)).toEqual([
      expect.objectContaining({ attempt_id: old.attempt_id, status: phase }),
    ]);
  }
  // A settled attempt with the same HEAD can be checked again as before.
  s = apply(
    s,
    value(
      recordPrecheck(
        s,
        system,
        { ...running(old), status: "failed", checks: [] },
        f.io,
      ),
    ),
  );
  const retry = value(await queuedAt(s, head, f.io));
  expect(retry.events.map((e) => e.type)).toEqual(["precheck_queued"]);
});
test("C-783: supersession keeps the request's own authorization and hold guards", async () => {
  const f = setup();
  const s = apply(f.state, value(await queued(f.state, f.io)));
  const held = apply(
    s,
    value(
      updateCard(
        s,
        human,
        {
          card_id: id("card", 1),
          hold: { reason: "wait", resume_condition: "ready" },
        },
        f.io,
      ),
    ),
  );
  expect((await queuedAt(held, "e".repeat(40))).ok).toBe(false);
  expect(
    (
      await prepareCheck(s, actor(2, "reviewer"), params, {
        head: async () => "e".repeat(40),
      })
    ).ok,
  ).toBe(false);
  expect(inFlight(held)).toHaveLength(1);
});
