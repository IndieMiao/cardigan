import { expect, test } from "vitest";
import {
  type Actor,
  type Assignment,
  assign,
  autoConfirmMerge,
  autoMergeSchedule,
  createWorkItem,
  type Decision,
  type DecisionCategory,
  effectivePreMergeChecks,
  mergePlan,
  mergeRequiresHuman,
  pmMergeBlockers,
  recordDecision,
  recordMergeCheck,
  requestDecision,
  resolveDelegatedDecision,
  SCREENSHOT_CHECK_LABEL,
  screenshotCheckBlocker,
  setCardSensitive,
  setProjectPreferences,
  standingTools,
  submitReview,
  updateCard,
  withdrawReview,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import {
  assignment,
  fixture,
  human,
  now,
  ports,
  role,
} from "./test-fixtures.js";

const TEST_PLAIN_SUMMARY = {
  changed: "测试用的改动说明",
  impact: "测试用的影响说明",
  risk: "无",
};

/**
 * P2a-14 ⑧ / Q-336 (a): the reviewer-browser switch wired into UI cards'
 * merge confirmation. A card with the "截图核对" pre-merge check is a UI card;
 * with the switch on only the independent reviewer's submit_review projects
 * its conclusion and PM Ops (or a timeout) may merge only on a current pass.
 * With the switch off everything behaves as before (C-86).
 */
const { work_item_id: _work, ...base } = assignment(900, "pm");
const ops: Assignment = { ...base, scope: "standing", standing_mode: "ops" };
const opsActor: Actor = {
  kind: "assignment",
  project_id: human.project_id,
  assignment_id: ops.id,
  ...role("pm"),
  allowed_tools: standingTools(role("pm").allowed_tools, "ops"),
};
const system: Actor = { kind: "system", project_id: human.project_id };
type Shot = "passed" | "failed" | undefined;

async function prepare({
  on,
  shot,
  ui = true,
  independent = true,
  manual,
  ordinary = 0,
}: {
  on: boolean;
  /** Ordinary pre-merge checks added before the review. */
  ordinary?: number;
  shot?: Shot;
  ui?: boolean;
  independent?: boolean;
  /** A conclusion PM Office/the human wrote while the switch was off. */
  manual?: "passed" | "failed";
}) {
  const seed = fixture();
  const f = mergeFixture("confirm", 3, {
    state: {
      ...seed,
      cards: [],
      work_items: [],
      runs: [],
      assignments: [ops],
      roles: [...seed.roles, role("independent_reviewer")],
    },
    ports: ports(),
  });
  if (!f.coder.work_item_id) throw new Error("Missing producer");
  const setSwitch = (value: boolean) =>
    f.commit(
      setProjectPreferences(
        f.state,
        human,
        { enable_reviewer_browser: value },
        f.io,
      ),
    );
  const write = (status: "pending" | "passed" | "failed", state = f.state) =>
    updateCard(
      state,
      human,
      {
        card_id: f.card.id,
        pre_merge_check: { label: SCREENSHOT_CHECK_LABEL, status },
      },
      f.io,
    );
  if (ui) f.commit(write("pending"));
  const item = independent
    ? f.commit(
        createWorkItem(
          f.state,
          human,
          {
            card_id: f.card.id,
            title: "Independent review",
            kind: "verify",
            role_id: "independent_reviewer",
            required: true,
            target_work_item_id: f.coder.work_item_id,
            completion_criteria: ["Screens"],
          },
          f.io,
        ),
      )
    : undefined;
  const owner = item
    ? f.commit(
        assign(
          f.state,
          human,
          { work_item_id: item.id, role_id: item.role_id },
          f.io,
        ),
      )
    : undefined;
  const product = await f.deliver();
  if (manual) f.commit(write(manual));
  for (let i = 0; i < ordinary; i++)
    f.commit(
      updateCard(
        f.state,
        human,
        {
          card_id: f.card.id,
          pre_merge_check: { label: `核对 ${i}`, status: "pending" },
        },
        f.io,
      ),
    );
  setSwitch(on);
  f.review(product);
  if (owner) {
    f.start(owner);
    f.commit(
      submitReview(
        f.state,
        f.actor(owner),
        {
          delivery_id: product.id,
          target_sha: product.subject.value,
          kind: "code",
          issues: [],
          ...(shot ? { screenshot_check: shot } : {}),
        },
        f.io,
      ),
    );
  }
  const card = () => {
    const c = f.state.cards.find((c) => c.id === f.card.id);
    if (!c) throw new Error("Missing card");
    return c;
  };
  const shotCheck = () =>
    card().pre_merge_checks?.find((c) => c.label === SCREENSHOT_CHECK_LABEL);
  return { f, item, owner, product, card, shotCheck, write, setSwitch };
}
/** Prepared card through completion, gate check and merge confirmation. */
async function setup(options: Parameters<typeof prepare>[0]) {
  const prepared = await prepare(options);
  const { f } = prepared;
  const completion = await f.deliver("card_completion");
  f.review(completion);
  const confirmation = () => {
    const q = f.state.decisions.findLast(
      (q) => q.trigger === "merge_confirmation",
    );
    if (!q) throw new Error("Missing confirmation");
    return q;
  };
  const identity = {
    card_id: f.card.id,
    completion_id: completion.id,
    attempt_id: "attempt-passed",
    candidate_sha: "b".repeat(40),
    tree_sha: "c".repeat(40),
  };
  for (const step of ["queued", "running", "passed"] as const)
    f.commit(
      recordMergeCheck(
        { ...f.state, project_settings: { merge_gate_enabled: true } },
        system,
        step === "passed"
          ? {
              ...identity,
              status: step,
              summary: "passed",
              log_ref: "attempt-passed.log",
              checks: [
                {
                  name: "test",
                  status: "passed",
                  exit_code: 0,
                  duration_ms: 1,
                },
              ],
            }
          : { ...identity, status: step },
        f.io,
      ),
    );
  const resolve = (state = f.state) =>
    resolveDelegatedDecision(
      state,
      opsActor,
      {
        decision_id: confirmation().id,
        option: "merge",
        rationale: "验证完成",
        notice: "截图核对和检查已通过。",
      },
      f.io,
    );
  return { ...prepared, confirmation, resolve };
}
const SHOTS: readonly Shot[] = ["passed", undefined, "failed"];

test.each(SHOTS)(
  "switch off: screenshot conclusion %s changes nothing (C-86 regression)",
  async (shot) => {
    const plain = await setup({ on: false, ui: false });
    const s = await setup({ on: false, shot });
    // The conclusion stays on the Review; the check keeps its C-86 owners.
    expect(s.shotCheck()?.status).toBe("pending");
    const reviewed = s.f.state.reviews.find(
      (r) => r.work_item_id === s.item?.id,
    );
    expect(reviewed?.screenshot_check).toBe(shot);
    expect(screenshotCheckBlocker(s.f.state, s.card())).toBeUndefined();
    expect(s.confirmation().decider).toBe("role:pm");
    expect(s.confirmation().decider).toBe(plain.confirmation().decider);
    expect(pmMergeBlockers(s.f.state, s.confirmation())).toEqual(
      pmMergeBlockers(plain.f.state, plain.confirmation()),
    );
    expect(pmMergeBlockers(s.f.state, s.confirmation())).toEqual([]);
    // PM Office or the human still record the screenshot result directly.
    s.f.commit(s.write("passed"));
    expect(s.shotCheck()?.status).toBe("passed");
    s.f.commit(s.resolve());
    expect(mergePlan(s.f.state, s.f.card.id).ok).toBe(true);
  },
);

test("switch on: an independent reviewer's current pass lets PM Ops merge", async () => {
  const { f, confirmation, resolve, shotCheck } = await setup({
    on: true,
    shot: "passed",
  });
  expect(shotCheck()).toMatchObject({ status: "passed" });
  expect(shotCheck()?.note).toMatch(/^审核 /u);
  expect(confirmation().decider).toBe("role:pm");
  expect(pmMergeBlockers(f.state, confirmation())).toEqual([]);
  f.commit(resolve());
  expect(mergePlan(f.state, f.card.id).ok).toBe(true);
});

test.each([
  [undefined, "须由独立复核员"],
  ["failed", "未通过"],
] as const)(
  "switch on: screenshot %s blocks PM Ops and timeout merge",
  async (shot, message) => {
    const { f, confirmation, resolve, shotCheck } = await setup({
      on: true,
      shot,
    });
    expect(shotCheck()?.status).toBe(shot ?? "pending");
    const blockers = pmMergeBlockers(f.state, confirmation());
    expect(blockers.some((b) => b.includes(message))).toBe(true);
    expect(resolve().ok).toBe(false);
    // Not a forced-human card: the human may still confirm it.
    expect(mergeRequiresHuman(f.state, confirmation())).toBe(false);
    const timeout = {
      ...f.state,
      project_preferences: (f.state.project_preferences ?? []).map((p) => ({
        ...p,
        auto_merge_after_minutes: 1,
      })),
      decisions: f.state.decisions.map((q) =>
        q.id === confirmation().id ? { ...q, decider: "human" as const } : q,
      ),
    };
    expect(autoMergeSchedule(timeout, confirmation().id).ok).toBe(false);
    // Control: the same timeout is eligible once the switch is off again.
    const offTimeout = {
      ...timeout,
      project_preferences: timeout.project_preferences.map((p) => ({
        ...p,
        enable_reviewer_browser: false,
      })),
    };
    expect(autoMergeSchedule(offTimeout, confirmation().id).ok).toBe(true);
    expect(
      autoConfirmMerge(
        timeout,
        system,
        { decision_id: confirmation().id },
        {
          ...f.io,
          clock: {
            now: () => new Date(Date.parse(now) + 3_600_000).toISOString(),
          },
        },
      ).ok,
    ).toBe(false);
  },
);

test.each(SHOTS)(
  "switch on: cards without the screenshot check are not UI cards (%s)",
  async (shot) => {
    const { f, confirmation, resolve, shotCheck } = await setup({
      on: true,
      shot,
      ui: false,
    });
    // A conclusion on a non-UI card creates the check: the reviewer saw UI.
    expect(shotCheck()?.status).toBe(shot);
    if (shot === "failed") expect(resolve().ok).toBe(false);
    else {
      expect(pmMergeBlockers(f.state, confirmation())).toEqual([]);
      f.commit(resolve());
    }
  },
);

test.each([true, false])(
  "switch on: direct passed/failed writes are rejected, pending stays allowed (human=%s)",
  async (isHuman) => {
    const { f, write } = await setup({ on: true, shot: "passed" });
    for (const value of ["passed", "failed"] as const) {
      const r = isHuman
        ? write(value)
        : updateCard(
            f.state,
            opsActor,
            {
              card_id: f.card.id,
              pre_merge_check: { label: SCREENSHOT_CHECK_LABEL, status: value },
            },
            f.io,
          );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("forbidden_tool");
    }
    f.commit(write("pending"));
  },
);

test.each(["passed", "failed"] as const)(
  "a %s conclusion PM Office/human wrote before the switch was on does not count",
  async (manual) => {
    const { f, confirmation, resolve, shotCheck } = await setup({
      on: true,
      manual,
    });
    expect(shotCheck()?.status).toBe(manual);
    expect(
      pmMergeBlockers(f.state, confirmation()).some((b) =>
        b.includes("须由独立复核员"),
      ),
    ).toBe(true);
    expect(resolve().ok).toBe(false);
  },
);

test.each([true, false])(
  "same-SHA redelivery: screenshot view follows merge authority when on, C-160 when off (on=%s)",
  async (on) => {
    const { f, product, card } = await prepare({
      on: true,
      shot: "passed",
    });
    const again = await f.deliver();
    expect(again.subject.value).toBe(product.subject.value);
    expect(again.id).not.toBe(product.id);
    const view = effectivePreMergeChecks(
      card(),
      f.state.work_items,
      f.state.deliveries,
      on,
    ).find((c) => c.label === SCREENSHOT_CHECK_LABEL);
    // On: bound to the delivery like 独立复核, so the old pass reads stale,
    // matching screenshotCheckBlocker. Off: ordinary C-160 SHA comparison.
    expect(view).toMatchObject(
      on
        ? { status: "pending", stale: true }
        : { status: "passed", stale: false },
    );
    expect(screenshotCheckBlocker(f.state, card())).toContain("须由独立复核员");
  },
);

const humanAnswer = (
  f: Awaited<ReturnType<typeof setup>>["f"],
  decision_id: Decision["id"],
  option: "merge" | "request_changes",
) =>
  recordDecision(
    f.state,
    human,
    {
      decision_id,
      option,
      rationale: "人亲自处理",
      raw_quote: option === "merge" ? "合并" : "退回",
    },
    f.io,
  );

test.each(["merge", "request_changes"] as const)(
  "a reset pass voids the unpublished PM confirmation and hands a new one to the human (%s)",
  async (option) => {
    const { f, resolve, write, confirmation } = await setup({
      on: true,
      shot: "passed",
    });
    f.commit(resolve());
    const old = confirmation();
    expect(mergePlan(f.state, f.card.id).ok).toBe(true);
    f.commit(write("pending"));
    const next = confirmation();
    expect(next.id).not.toBe(old.id);
    expect(next).toMatchObject({ status: "open", decider: "human" });
    expect(next.human_required_reason).toContain(SCREENSHOT_CHECK_LABEL);
    // The old authorization stays as history and is not resurrected.
    const history = f.state.decisions.find((q) => q.id === old.id);
    expect(history?.resolution?.option).toBe("merge");
    expect(history?.status).toBe("superseded");
    expect(
      f.state.events.some(
        (e) =>
          e.type === "decision_superseded" &&
          (e.payload as { decision_id?: string }).decision_id === old.id,
      ),
    ).toBe(true);
    expect(mergePlan(f.state, f.card.id).ok).toBe(false);
    // PM cannot answer it; the human can merge or return it.
    expect(resolve().ok).toBe(false);
    f.commit(humanAnswer(f, next.id, option));
    if (option === "merge") expect(mergePlan(f.state, f.card.id).ok).toBe(true);
    else
      expect(f.state.cards.find((c) => c.id === f.card.id)?.status).not.toBe(
        "awaiting_merge",
      );
  },
);

test("turning the switch on voids a delegated merge made on a manual pass", async () => {
  const { f, resolve, confirmation, setSwitch } = await setup({
    on: false,
    manual: "passed",
  });
  f.commit(resolve());
  const old = confirmation();
  expect(mergePlan(f.state, f.card.id).ok).toBe(true);
  setSwitch(true);
  const next = confirmation();
  expect(next.id).not.toBe(old.id);
  expect(next).toMatchObject({ status: "open", decider: "human" });
  expect(mergePlan(f.state, f.card.id).ok).toBe(false);
  f.commit(humanAnswer(f, next.id, "merge"));
  expect(mergePlan(f.state, f.card.id).ok).toBe(true);
});

test("a human's own merge confirmation survives a later reset", async () => {
  const { f, write, confirmation } = await setup({
    on: true,
    shot: "passed",
  });
  f.commit(
    resolveDelegatedDecision(
      f.state,
      opsActor,
      {
        decision_id: confirmation().id,
        option: "merge",
        rationale: "交人",
        escalate: true,
      },
      f.io,
    ),
  );
  f.commit(humanAnswer(f, confirmation().id, "merge"));
  const confirmed = confirmation();
  f.commit(write("pending"));
  expect(confirmation().id).toBe(confirmed.id);
  expect(mergePlan(f.state, f.card.id).ok).toBe(true);
});

test.each([true, false])(
  "withdrawing the review resets only its own screenshot projection (switch on=%s)",
  async (on) => {
    const { f, owner, item, shotCheck } = await prepare({
      on,
      shot: "passed",
    });
    if (!owner || !item) throw new Error("Missing reviewer");
    expect(shotCheck()?.status).toBe(on ? "passed" : "pending");
    f.commit(
      withdrawReview(
        f.state,
        f.actor(owner),
        { work_item_id: item.id, rationale: "截图漏看了暗色" },
        f.io,
      ),
    );
    expect(shotCheck()?.status).toBe("pending");
    if (on) expect(shotCheck()?.note).toMatch(/已撤回$/u);
    // Off: the check was never projected, so withdrawal leaves it untouched.
    else expect(shotCheck()?.updated_by).toBe("human");
  },
);

test("only the independent reviewer may give a screenshot conclusion", async () => {
  const seed = fixture();
  const f = mergeFixture("confirm", 3, {
    state: { ...seed, cards: [], work_items: [], runs: [], assignments: [ops] },
    ports: ports(),
  });
  const product = await f.deliver();
  const reviewer = f.state.assignments.find(
    (a) => a.role_id === "reviewer" && a.status === "active",
  );
  if (!reviewer?.work_item_id) throw new Error("Missing reviewer");
  f.start(reviewer);
  const r = submitReview(
    f.state,
    f.actor(reviewer),
    {
      delivery_id: product.id,
      target_sha: product.subject.value,
      kind: "code",
      issues: [],
      screenshot_check: "passed",
    },
    f.io,
  );
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error.code).toBe("forbidden_tool");
});

test.each<DecisionCategory | "sensitive">([
  "spending",
  "account",
  "permission",
  "data_deletion",
  "scope_change",
  "sensitive",
])(
  "switch on + screenshot passed never lifts a forced-human card (%s)",
  async (kind) => {
    const { f, confirmation, resolve } = await setup({
      on: true,
      shot: "passed",
    });
    if (kind === "sensitive")
      f.commit(
        setCardSensitive(
          f.state,
          human,
          { card_id: f.card.id, sensitive: true },
          f.io,
        ),
      );
    else
      f.commit(
        requestDecision(
          f.state,
          human,
          {
            card_id: f.card.id,
            category: kind,
            kind: "choose",
            question: "Business authorization?",
            context: "Forced human",
            options: [{ key: "yes", description: "Yes", impact: "Change" }],
            recommended: "yes",
            affected_cards: [],
            affected_work_items: [],
            blocking: false,
            decider: "human",
            plain_summary: TEST_PLAIN_SUMMARY,
          },
          f.io,
        ),
      );
    expect(confirmation().decider).toBe("human");
    expect(mergeRequiresHuman(f.state, confirmation())).toBe(true);
    expect(resolve().ok).toBe(false);
  },
);

test("switch on + screenshot passed never lifts a human_required_reason handoff", async () => {
  const { f, confirmation, resolve } = await setup({
    on: true,
    shot: "passed",
  });
  f.commit(
    resolveDelegatedDecision(
      f.state,
      opsActor,
      {
        decision_id: confirmation().id,
        option: "merge",
        rationale: "对外发布须交人",
        escalate: true,
      },
      f.io,
    ),
  );
  expect(confirmation().human_required_reason).toContain("对外发布");
  expect(mergeRequiresHuman(f.state, confirmation())).toBe(true);
  expect(resolve().ok).toBe(false);
});

test("switch on: projection does not fail on the ordinary-check limit", async () => {
  const { shotCheck, card } = await prepare({
    on: true,
    shot: "passed",
    ui: false,
    ordinary: 8,
  });
  expect(
    card().pre_merge_checks?.filter((c) => c.label.startsWith("核对 ")),
  ).toHaveLength(8);
  expect(shotCheck()?.status).toBe("passed");
});

const addOrdinary = (
  f: Awaited<ReturnType<typeof prepare>>["f"],
  label: string,
) =>
  updateCard(
    f.state,
    human,
    { card_id: f.card.id, pre_merge_check: { label, status: "pending" } },
    f.io,
  );

test("switch on: the screenshot check takes no ordinary slot in either order", async () => {
  // Projection first, then 8 ordinary checks.
  const first = await prepare({ on: true, shot: "passed" });
  for (let i = 0; i < 8; i++) first.f.commit(addOrdinary(first.f, `核对 ${i}`));
  expect(addOrdinary(first.f, "核对 8").ok).toBe(false);
  // 8 ordinary checks first, then the PM's pending marker.
  const second = await prepare({ on: true, ui: false, ordinary: 8 });
  second.f.commit(second.write("pending"));
  expect(second.shotCheck()?.status).toBe("pending");
});

test("switch off: the screenshot check keeps using an ordinary slot (C-160)", async () => {
  const { write } = await prepare({ on: false, ui: false, ordinary: 8 });
  const r = write("pending");
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error.code).toBe("validation_failed");
  const marked = await prepare({ on: false, ordinary: 7 });
  expect(addOrdinary(marked.f, "核对 7").ok).toBe(false);
});
