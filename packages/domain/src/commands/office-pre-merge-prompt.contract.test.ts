import { describe, expect, test } from "vitest";
import {
  type Assignment,
  type CommandState,
  type Event,
  PRE_MERGE_CHECK_OFFICE_PROMPTED,
  recordAutomaticMergeWaits,
  recordMergeResult,
  updateCard,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { system, systemMergeFixture } from "./system-merge/test-fixtures.js";
import { apply, human, now, value } from "./test-fixtures.js";

/**
 * C-744: the PM Office on duty is prompted to record the pre-merge checks it
 * owns at two moments: when reviews and acceptance pass, and when the merge
 * check passed and only those checks hold the automatic merge.
 */
const office: Assignment = {
  id: "A-90",
  scope: "standing",
  role_id: "pm",
  role_version: 1,
  standing_mode: "office",
  status: "active",
  created_at: now,
} as unknown as Assignment;

type Fixture = ReturnType<typeof mergeFixture>;

function seat(f: Fixture, staff: Assignment = office) {
  f.commit({
    ok: true,
    value: {
      data: null,
      changes: [{ collection: "assignments", entity: staff }],
      events: [],
      timeline: [],
      token_requests: [],
    },
  });
}

function setCheck(
  f: Fixture,
  label: string,
  status: "pending" | "passed" | "failed",
  actor = human,
) {
  f.commit(
    updateCard(
      f.state,
      actor,
      { card_id: f.card.id, pre_merge_check: { label, status } },
      f.io,
    ),
  );
}

const prompts = (events: readonly Event[], moment?: string) =>
  events.filter(
    (e) =>
      e.type === PRE_MERGE_CHECK_OFFICE_PROMPTED &&
      (moment === undefined ||
        (e.payload as { moment?: string }).moment === moment),
  );

const at = (minutes: number) => ({
  now: () => new Date(Date.UTC(2026, 0, 2, 0, minutes)).toISOString(),
});

function scan(f: Fixture, minutes = 0, state: CommandState = f.state) {
  return value(
    recordAutomaticMergeWaits(
      state,
      system,
      {},
      { ...f.io, clock: at(minutes) },
    ),
  );
}

describe("moment 1: reviews and PM acceptance passed", () => {
  test("the Office is prompted once with card, delivery, SHA and pending label", async () => {
    const f = mergeFixture();
    seat(f);
    setCheck(f, "合并边界确认", "pending");
    setCheck(f, "已核项", "pending");
    const product = await f.deliver();
    f.review(product);
    setCheck(f, "已核项", "passed", { ...human });
    expect(prompts(f.state.events)).toEqual([]);
    const completion = await f.deliver("card_completion");
    f.review(completion);
    expect(f.state.cards[0]?.status).toBe("awaiting_merge");
    const [prompt, ...more] = prompts(f.state.events);
    expect(more).toEqual([]);
    expect(prompt).toMatchObject({
      card_id: f.card.id,
      actor: { kind: "system" },
      payload: {
        moment: "accepted",
        completion_id: completion.id,
        checks: ["合并边界确认"],
        versions: [
          {
            work_item_id: product.work_item_id,
            delivery_id: product.id,
            subject: product.subject.value,
          },
        ],
      },
    });
    const text = (prompt?.payload as { text?: string } | undefined)?.text;
    for (const part of [
      f.card.id,
      product.id,
      product.subject.value,
      "「合并边界确认」",
    ])
      expect(text).toContain(part);
    expect(text).not.toContain("已核项");
    const entry = f.state.timeline.find((t) => t.event_seq === prompt?.seq);
    expect(entry).toMatchObject({ type: "system", author: "system" });
    // The check itself is untouched: still pending, nothing passed for it.
    expect(
      f.state.cards[0]?.pre_merge_checks?.find(
        (c) => c.label === "合并边界确认",
      )?.status,
    ).toBe("pending");
  });

  test("a check PM Ops leaves after acceptance prompts at once, once per label", async () => {
    const f = mergeFixture();
    seat(f);
    await f.accept();
    expect(prompts(f.state.events)).toEqual([]);
    setCheck(f, "合并边界确认", "pending");
    setCheck(f, "合并边界确认", "pending");
    expect(
      prompts(f.state.events).map((e) => (e.payload as { checks: [] }).checks),
    ).toEqual([["合并边界确认"]]);
    setCheck(f, "发布说明", "pending");
    expect(
      prompts(f.state.events).map((e) => (e.payload as { checks: [] }).checks),
    ).toEqual([["合并边界确认"], ["发布说明"]]);
  });

  test("no pending check, a failed one, or a check the Office does not own: no prompt", async () => {
    const f = mergeFixture();
    seat(f);
    setCheck(f, "独立复核", "pending");
    await f.accept();
    expect(prompts(f.state.events)).toEqual([]);
    setCheck(f, "合并边界确认", "failed");
    expect(prompts(f.state.events)).toEqual([]);
    expect(scan(f).events.filter((e) => e.type !== "merge_blocked")).toEqual(
      [],
    );
  });

  test("no Office on duty: nothing is written and no other role is told", async () => {
    for (const staff of [
      undefined,
      { ...office, status: "suspended" } as Assignment,
      { ...office, standing_mode: "ops" } as Assignment,
    ]) {
      const f = mergeFixture();
      if (staff) seat(f, staff);
      setCheck(f, "合并边界确认", "pending");
      const before = f.state.events.length;
      await f.accept();
      expect(prompts(f.state.events)).toEqual([]);
      expect(f.state.events.length).toBeGreaterThan(before);
    }
  });

  test("a resubmission after a merge conflict prompts again for the new delivery", async () => {
    const f = mergeFixture("auto");
    seat(f);
    setCheck(f, "合并边界确认", "pending");
    const { product, completion } = await f.accept();
    expect(prompts(f.state.events, "accepted")).toHaveLength(1);
    f.commit(
      recordMergeResult(
        f.state,
        system,
        {
          card_id: f.card.id,
          completion_id: completion.id,
          result: {
            kind: "conflicted",
            delivery_id: product.id,
            files: ["file.ts"],
          },
        },
        f.io,
      ),
    );
    const conflict = f.state.events.find((e) => e.type === "merge_conflicted");
    const repair = await f.deliver("code", "b".repeat(40), true, [], conflict);
    f.review(repair);
    const next = await f.deliver("card_completion", repair.subject.value);
    f.review(next);
    const all = prompts(f.state.events, "accepted");
    expect(all).toHaveLength(2);
    expect(all[1]?.payload).toMatchObject({
      completion_id: next.id,
      checks: ["合并边界确认"],
      versions: [{ delivery_id: repair.id, subject: "b".repeat(40) }],
    });
    expect((all[1]?.payload as { text?: string } | undefined)?.text).toContain(
      repair.id,
    );
  });
});

describe("moment 2: the merge check passed and only Office checks remain", () => {
  async function blocked(withOffice = true) {
    const { f, check } = await systemMergeFixture();
    if (withOffice) seat(f);
    setCheck(f, "合并边界确认", "pending");
    return { f, check };
  }

  test("rings at once on the first scan, dedups, and the 30-minute reminder stays", async () => {
    const { f, check } = await blocked();
    // Before the merge check passed other reasons remain: no fallback prompt.
    const early = scan(f);
    expect(prompts(early.events)).toEqual([]);
    f.commit({ ok: true, value: early });
    check();
    const first = scan(f, 1);
    expect(first.events.map((e) => e.type)).toEqual([
      "merge_blocked",
      PRE_MERGE_CHECK_OFFICE_PROMPTED,
    ]);
    expect(first.events[0]?.payload).toMatchObject({
      reasons: ["合并边界确认：待核"],
    });
    expect(first.events[1]?.payload).toMatchObject({
      moment: "merge_check_passed",
      checks: ["合并边界确认"],
    });
    expect(first.changes).toEqual([]);
    f.commit({ ok: true, value: first });
    expect(scan(f, 2).events).toEqual([]);
    expect(scan(f, 30).events).toEqual([]);
    const reminder = scan(f, 31);
    expect(reminder.events.map((e) => e.type)).toEqual([
      "merge_blocked_reminded",
    ]);
    f.commit({ ok: true, value: reminder });
    // A blocker episode that flips and returns on the same delivery is the
    // same moment: no second prompt.
    setCheck(f, "合并边界确认", "passed");
    f.commit({ ok: true, value: scan(f, 32) });
    setCheck(f, "合并边界确认", "pending");
    const again = scan(f, 33);
    expect(again.events.map((e) => e.type)).toEqual(["merge_blocked"]);
  });

  test("other remaining reasons, reserved or failed checks: no fallback prompt", async () => {
    const { f, check } = await blocked();
    check();
    const paused = {
      ...f.state,
      project_preferences: (f.state.project_preferences ?? []).map((p) => ({
        ...p,
        auto_merge_paused: true,
      })),
    };
    expect(prompts(scan(f, 0, paused).events)).toEqual([]);
    setCheck(f, "合并边界确认", "passed");
    setCheck(f, "独立复核", "pending");
    expect(scan(f).events[0]?.payload).toMatchObject({
      reasons: ["独立复核：待核"],
    });
    expect(prompts(scan(f).events)).toEqual([]);
    setCheck(f, "合并边界确认", "failed");
    const failed = scan(f);
    expect(failed.events[0]?.payload).toMatchObject({
      reasons: ["合并边界确认：未通过", "独立复核：待核"],
    });
    expect(prompts(failed.events)).toEqual([]);
  });

  test("no Office on duty: no prompt until one is, then exactly one", async () => {
    const { f, check } = await blocked(false);
    check();
    const quiet = scan(f);
    expect(quiet.events.map((e) => e.type)).toEqual(["merge_blocked"]);
    f.commit({ ok: true, value: quiet });
    const seated = apply(f.state, {
      data: null,
      changes: [{ collection: "assignments", entity: office }],
      events: [],
      timeline: [],
      token_requests: [],
    });
    const later = scan(f, 5, seated);
    expect(later.events.map((e) => e.type)).toEqual([
      PRE_MERGE_CHECK_OFFICE_PROMPTED,
    ]);
    expect(scan(f, 6, apply(seated, later)).events).toEqual([]);
  });
});
