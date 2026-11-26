import { expect, test } from "vitest";
import {
  type CommandState,
  type Decision,
  latestMergeCheck,
  listNeedsYou,
  mergeAwaitsNoCheck,
  mergePlan,
  pmMergeBlockers,
  recordDecision,
  recordMergePreparation,
  recordMergeResult,
  SYSTEM_MERGE_STALLED_MS,
  setProjectPreferences,
  stalledSystemMerges,
  systemConfirmMerge,
  systemMergeBlockers,
} from "../index.js";
import { system, systemMergeFixture } from "./system-merge/test-fixtures.js";
import { human, value } from "./test-fixtures.js";

const head = "a".repeat(40);

/** C-777: a C-557-like no-change completion under auto_merge. */
async function setup() {
  const fixture = await systemMergeFixture();
  const { f } = fixture;
  f.commit({
    ok: true,
    value: {
      data: null,
      changes: f.state.cards.map((c) => ({
        collection: "cards" as const,
        entity: { ...c, flow_version: 5 },
      })),
      events: [],
      timeline: [],
      token_requests: [],
    },
  });
  f.commit(setProjectPreferences(f.state, human, { auto_merge: "on" }, f.io));
  const gated = (): CommandState => ({
    ...f.state,
    project_settings: { merge_gate_enabled: true },
  });
  const q = gated().decisions.findLast(
    (q) => q.trigger === "merge_confirmation" && q.status === "open",
  ) as Decision;
  expect(q).toMatchObject({ decider: "system", status: "open" });
  const prepare = (noop: boolean, base_sha = head) =>
    f.commit(
      recordMergePreparation(
        gated(),
        system,
        {
          card_id: f.card.id,
          completion_id: fixture.completion.id,
          base_sha,
          noop,
        },
        f.io,
      ),
    );
  return { ...fixture, q, gated, prepare };
}

test("C-777: system confirms and merges a host-verified noop completion without a forged check pass", async () => {
  const { f, q, gated, prepare, completion } = await setup();
  expect(systemMergeBlockers(gated(), q)).toContain(
    "合并闸门检查尚未排队或尚无结果",
  );
  prepare(true);
  expect(systemMergeBlockers(gated(), q)).toEqual([]);
  f.commit(systemConfirmMerge(gated(), system, { decision_id: q.id }, f.io));
  expect(
    gated().decisions.find((v) => v.id === q.id)?.resolution,
  ).toMatchObject({ option: "merge", resolved_by: "system" });
  expect(mergePlan(gated(), f.card.id).ok).toBe(true);
  f.commit(
    recordMergeResult(
      gated(),
      system,
      {
        card_id: f.card.id,
        completion_id: completion.id,
        result: {
          kind: "merged",
          merge_sha: head,
          previous_sha: head,
          noop: true,
        },
      },
      f.io,
    ),
  );
  expect(f.state.cards[0]?.status).toBe("done");
  expect(
    latestMergeCheck(f.state.events, f.card.id, completion.id),
  ).toBeUndefined();
  expect(f.state.events.some((e) => e.type.startsWith("merge_check_"))).toBe(
    false,
  );
});

test("C-777: without a current verified noop the system still needs a passed check", async () => {
  const { f, q, gated, prepare } = await setup();
  prepare(true);
  // The host revokes the noop when the candidate changes.
  prepare(false, "d".repeat(40));
  expect(systemMergeBlockers(gated(), q)).toContain(
    "合并闸门检查尚未排队或尚无结果",
  );
  expect(
    systemConfirmMerge(gated(), system, { decision_id: q.id }, f.io).ok,
  ).toBe(false);
  // A noop recorded with the gate off is no exception either.
  prepare(true);
  expect(
    systemMergeBlockers(
      { ...gated(), project_settings: { merge_gate_enabled: false } },
      q,
    ).length,
  ).toBeGreaterThan(0);
});

test("C-777: PM Ops delegation still requires the merge check for a verified noop", async () => {
  const { q, gated, prepare } = await setup();
  prepare(true);
  expect(pmMergeBlockers(gated(), q)).toContain(
    "合并闸门检查尚未排队或尚无结果",
  );
});

test("C-777: only a verified noop or a merge failure after the last check stops merge work from asking for a slot", async () => {
  const { f, prepare, completion, gated } = await setup();
  const idle = () =>
    mergeAwaitsNoCheck(f.state.events, f.card.id, completion.id);
  expect(idle()).toBe(false);
  prepare(true);
  expect(idle()).toBe(true);
  prepare(false, "d".repeat(40));
  expect(idle()).toBe(false);
  f.commit(
    recordMergeResult(
      gated(),
      system,
      {
        card_id: f.card.id,
        completion_id: completion.id,
        result: { kind: "failed", reason: "候选准备失败" },
      },
      f.io,
    ),
  );
  expect(f.state.events.at(-1)?.type).toBe("merge_failed");
  expect(idle()).toBe(true);
  // Another completion is never idle on this one's history.
  expect(mergeAwaitsNoCheck(f.state.events, f.card.id, "D-999" as never)).toBe(
    false,
  );
});

test("C-777: a system merge confirmation open past the threshold is listed for the human to take over", async () => {
  const { f, q, gated } = await setup();
  const opened =
    gated().events.find(
      (e) =>
        e.type === "decision_requested" &&
        (e.payload as { decision_id?: string }).decision_id === q.id,
    )?.created_at ??
    gated().timeline.find((t) => t.decision_id === q.id)?.created_at;
  if (!opened) throw new Error("Missing decision request");
  const at = (ms: number) => ({
    now: () => new Date(Date.parse(opened) + ms).toISOString(),
  });
  const listed = (ms: number) =>
    value(listNeedsYou(gated(), human, at(ms))).data.stalled_system_merges.map(
      (d) => d.id,
    );
  expect(listed(SYSTEM_MERGE_STALLED_MS - 1)).toEqual([]);
  expect(listed(SYSTEM_MERGE_STALLED_MS)).toEqual([q.id]);
  expect(
    stalledSystemMerges(gated(), at(SYSTEM_MERGE_STALLED_MS).now()),
  ).toHaveLength(1);
  // It is a takeover offer, not a decision waiting on the human.
  expect(
    value(
      listNeedsYou(gated(), human, at(SYSTEM_MERGE_STALLED_MS)),
    ).data.decisions.map((d) => d.id),
  ).not.toContain(q.id);
  // The human's existing answer settles it; nothing else is granted.
  f.commit(
    recordDecision(
      gated(),
      human,
      {
        decision_id: q.id,
        option: "merge",
        rationale: "接手系统合并确认",
        raw_quote: "确认合并",
        merge_override_reason: "测试：系统确认卡住，人接手",
      },
      f.io,
    ),
  );
  expect(listed(SYSTEM_MERGE_STALLED_MS)).toEqual([]);
});
