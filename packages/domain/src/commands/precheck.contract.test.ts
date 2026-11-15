import { expect, test } from "vitest";
import {
  type Actor,
  type CommandState,
  hasPassedMergeCheck,
  type Precheck,
  prechecks,
  precheckView,
  prepareCheck,
  recordMergeResult,
  recordPrecheck,
  requestCheck,
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
