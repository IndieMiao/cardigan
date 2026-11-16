import { expect, test } from "vitest";
import { mergeFixture } from "./commands/merge/test-fixtures.js";
import { human } from "./commands/test-fixtures.js";
import {
  type CommandState,
  deriveCardFields,
  submitReview,
  verificationActivity,
  verificationTarget,
} from "./index.js";

const missing = (): never => {
  throw new Error("Missing fixture");
};

test("review activity follows a submitted target and an unfinished Run, never ownership alone", async () => {
  const f = mergeFixture();
  const delivery = await f.deliver();
  const item =
    f.state.work_items.find((w) => w.id === f.reviewer.work_item_id) ??
    missing();
  if (item.kind !== "verify") throw new Error("Expected verifier");
  const activity = (state: CommandState, manual = false) =>
    verificationActivity({ ...item, manual_assign: manual }, state);
  expect(activity(f.state)?.label).toBe("待审核");
  expect(activity(f.state, true)?.label).toBe("待审核 · 手动派活");
  f.start(f.reviewer);
  expect(activity(f.state)?.label).toBe("正在审核");
  for (const [status, label] of [
    ["queued", "审核排队中"],
    ["dispatched", "审核启动中"],
    ["unknown", "审核执行状态待确认"],
    ["completed", "待审核"],
  ] as const) {
    const state = {
      ...f.state,
      runs: f.state.runs.map((r) =>
        r.assignment_id === f.reviewer.id ? { ...r, status } : r,
      ),
    };
    expect(activity(state)?.label).toBe(label);
  }
  for (const status of ["accepted", "superseded"] as const) {
    const state = {
      ...f.state,
      deliveries: f.state.deliveries.map((v) => ({ ...v, status })),
    };
    expect(activity(state)?.label).toBe("等待新交付");
  }
  expect(activity({ ...f.state, deliveries: [] })?.label).toBe("等待新交付");
  expect(
    verificationActivity({ ...item, status: "todo" }, f.state),
  ).toBeUndefined();
  expect(
    verificationActivity({ ...item, status: "blocked" }, f.state),
  ).toBeUndefined();
  expect(
    verificationActivity({ ...item, status: "passed" }, f.state),
  ).toBeUndefined();
  const oldRunState = {
    ...f.state,
    events: [
      ...f.state.events,
      {
        ...(f.state.events.at(-1) ?? missing()),
        seq: 9999,
        type: "delivery_submitted",
        actor: human,
        payload: { delivery_id: delivery.id },
      },
    ].filter((e) => e.type !== "delivery_submitted" || e.seq === 9999),
  };
  expect(activity(oldRunState)?.label).toBe("待审核");
});

test("conditional same-version rechecks retain their target, owner and running activity", async () => {
  const f = mergeFixture();
  const delivery = await f.deliver();
  f.start(f.reviewer);
  const conditional = f.commit(
    submitReview(
      f.state,
      f.actor(f.reviewer),
      {
        delivery_id: delivery.id,
        target_sha: delivery.subject.value,
        kind: "code",
        issues: [],
        recheck_required: true,
      },
      f.io,
    ),
  );
  expect(conditional.verdict).toBe("conditional");
  f.start(f.reviewer);
  const item =
    f.state.work_items.find((w) => w.id === f.reviewer.work_item_id) ??
    missing();
  expect(verificationTarget(item, f.state)?.id).toBe(delivery.id);
  expect(verificationActivity(item, f.state)?.label).toBe("正在审核");
  const card = f.state.cards[0] ?? missing();
  expect(deriveCardFields({ ...f.state, card }).next_owners).toContainEqual({
    kind: "assignment",
    ref: f.reviewer.id,
  });
  const pass = f.commit(
    submitReview(
      f.state,
      f.actor(f.reviewer),
      {
        delivery_id: delivery.id,
        target_sha: delivery.subject.value,
        kind: "code",
        issues: [],
      },
      f.io,
    ),
  );
  expect(pass.verdict).toBe("pass");
});
