import { expect, test } from "vitest";
import type { Actor, CommandState, Decision } from "../index.js";
import {
  completeHumanAction,
  mergeCheckBlockers,
  prepareMergePlan,
  projectSnapshot,
  recordMergeCheckBlockers,
  requestHumanAction,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { human, id, value } from "./test-fixtures.js";

const system: Actor = { kind: "system", project_id: human.project_id };
const start = "2026-01-01T08:25:00.000Z";
async function fixture() {
  const f = mergeFixture();
  await f.accept();
  let now = start;
  const ports = { ...f.io, clock: { now: () => now } };
  const scan = () =>
    f.commit(recordMergeCheckBlockers(f.state, system, {}, ports));
  const ask = (blocks_merge = true) =>
    f.commit(
      requestHumanAction(
        f.state,
        human,
        {
          card_id: f.card.id,
          instructions: "轮换凭据",
          why_human: "需要人在主机执行",
          expected_return: "完成",
          blocked_work_items: [],
          blocks_merge,
        },
        f.io,
      ),
    );
  const finish = (human_action_id: ReturnType<typeof ask>["id"]) =>
    f.commit(
      completeHumanAction(
        f.state,
        human,
        { human_action_id, text: "Done" },
        f.io,
      ),
    );
  return {
    f,
    ports,
    scan,
    ask,
    finish,
    advance: () => {
      now = "2026-01-01T10:25:00.000Z";
    },
  };
}

test("C-178: first observation and release are atomic, deduplicated and restart-safe", async () => {
  const { f, scan, ask, finish, advance } = await fixture();
  ask(false);
  scan();
  expect(
    f.state.events.filter((e) => e.type.startsWith("merge_check_block")),
  ).toEqual([]);
  const h = ask();
  scan();
  advance();
  scan();
  const blocked = f.state.events.filter(
    (e) => e.type === "merge_check_blocked",
  );
  expect(blocked).toHaveLength(1);
  expect(blocked[0]?.payload).toMatchObject({
    label: h.id,
    detail: "轮换凭据",
    started_at: start,
  });
  expect(
    f.state.timeline.find((t) => t.event_seq === blocked[0]?.seq),
  ).toMatchObject({
    type: "system",
    author: "system",
    body: expect.stringContaining(h.id),
    refs: [{ kind: "human_action", id: h.id }],
  });
  // No in-memory de-duplication: a reloaded snapshot retains the original timestamp.
  const reloaded = JSON.parse(JSON.stringify(f.state)) as CommandState;
  const before = JSON.stringify(reloaded);
  const result = value(recordMergeCheckBlockers(reloaded, system, {}, f.io));
  expect(result.events).toEqual([]);
  expect(result.changes).toEqual([]);
  expect(JSON.stringify(reloaded)).toEqual(before);
  expect(
    value(projectSnapshot(reloaded, human)).data.cards[0]?.merge_check_blockers,
  ).toEqual([
    { key: h.id, label: h.id, detail: "轮换凭据", started_at: start },
  ]);
  finish(h.id);
  // Reads immediately stop presenting resolved blockers, even before the next scan.
  expect(mergeCheckBlockers(f.state, f.card.id)).toEqual([]);
  scan();
  scan();
  const cleared = f.state.events.filter(
    (e) => e.type === "merge_check_unblocked",
  );
  expect(cleared).toHaveLength(1);
  expect(
    f.state.timeline.find((t) => t.event_seq === cleared[0]?.seq)?.body,
  ).toBe(`合并检查已解除阻挡：${h.id}`);
  expect(prepareMergePlan(f.state, f.card.id).ok).toBe(true);
});

test("C-178: concurrent blockers retain independent start times and releases", async () => {
  const { f, scan, ask, finish, advance } = await fixture();
  const first = ask();
  scan();
  advance();
  const second = ask();
  scan();
  finish(first.id);
  scan();
  expect(mergeCheckBlockers(f.state, f.card.id)).toMatchObject([
    { key: second.id, started_at: "2026-01-01T10:25:00.000Z" },
  ]);
  expect(
    f.state.events.filter((e) => e.type === "merge_check_blocked"),
  ).toHaveLength(2);
  expect(
    f.state.events.filter((e) => e.type === "merge_check_unblocked"),
  ).toHaveLength(1);
});

test("C-178: other preparation failures are observed, while the current merge confirmation is excluded", async () => {
  const { f, scan, ports } = await fixture();
  scan();
  expect(mergeCheckBlockers(f.state, f.card.id)).toEqual([]);
  const q = f.state.decisions[0] as Decision;
  const { trigger: _trigger, ...plain } = q;
  const blocking: Decision = {
    ...plain,
    id: id("decision", 77),
    key: id("decision", 77),
  };
  const withDecision = {
    ...f.state,
    decisions: [...f.state.decisions, blocking],
  };
  const result = value(
    recordMergeCheckBlockers(withDecision, system, {}, ports),
  );
  expect(result.events).toMatchObject([
    {
      type: "merge_check_blocked",
      payload: { label: blocking.id, detail: blocking.question },
    },
  ]);
  const broken = {
    ...f.state,
    cards: f.state.cards.map((c) => ({ ...c, base_branch: "" })),
  };
  expect(
    value(recordMergeCheckBlockers(broken, system, {}, ports)).events,
  ).toMatchObject([
    {
      type: "merge_check_blocked",
      payload: { detail: "Git 合并需要仓库、基线和合并策略" },
    },
  ]);
  expect(
    value(
      recordMergeCheckBlockers(
        f.state,
        system,
        { unavailable: "configuration" },
        ports,
      ),
    ).events,
  ).toMatchObject([
    { type: "merge_check_blocked", payload: { key: "host:configuration" } },
  ]);
});

test("C-178: leaving awaiting_merge releases observations; recurrence starts a new interval", async () => {
  const { f, ask, scan, ports } = await fixture();
  ask();
  scan();
  const cancelled = {
    ...f.state,
    cards: f.state.cards.map((c) => ({ ...c, status: "cancelled" as const })),
  };
  const released = value(
    recordMergeCheckBlockers(cancelled, system, {}, ports),
  );
  expect(released.events).toMatchObject([{ type: "merge_check_unblocked" }]);
  const again = { ...f.state, events: [...f.state.events, ...released.events] };
  expect(
    value(recordMergeCheckBlockers(again, system, {}, ports)).events,
  ).toMatchObject([{ type: "merge_check_blocked" }]);
});

test("C-178: only the same project's system can write observations", async () => {
  const { f, ask, ports } = await fixture();
  ask();
  for (const actor of [
    human,
    f.actor(f.coder),
    { kind: "system", project_id: "other" } as const,
  ]) {
    expect(recordMergeCheckBlockers(f.state, actor, {}, ports).ok).toBe(false);
  }
});
