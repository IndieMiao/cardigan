import { expect, test } from "vitest";
import { cancelHumanAction, completeHumanAction } from "../index.js";
import { listNeedsYou } from "./queries.js";
import {
  reconcileStorageCorsAction,
  type StorageCorsCheck,
} from "./storage-cors.js";
import { actor, apply, fixture, human, ports, value } from "./test-fixtures.js";

const origins = ["https://gs66.example.ts.net", "https://cardigan.example"];
const refused: StorageCorsCheck = {
  bucket: "cardigan-private",
  region: "us-west-1",
  origins,
  refused: origins.map((origin) => ({ origin, reason: "not_enabled" })),
};
const allowed: StorageCorsCheck = { ...refused, refused: [] };

test("C-807: a refused preflight opens one owner action that a passing recheck closes", () => {
  const io = ports();
  let state = fixture();
  const system = { kind: "system" as const, project_id: state.project_id };
  const opened = value(reconcileStorageCorsAction(state, system, refused, io));
  expect(opened.events.map((e) => e.type)).toEqual(["human_action_requested"]);
  state = apply(state, opened);
  const [action] = state.human_actions;
  expect(action).toMatchObject({
    requested_by: "system",
    status: "open",
    category: "account",
    triage: "human",
    blocked_work_items: [],
  });
  expect(action?.card_id).toBeUndefined();
  expect(action?.instructions).toContain("跨域设置");
  expect(action?.instructions).toContain(origins.join("、"));
  expect(action?.instructions).toContain("PUT、GET、HEAD");
  expect(action?.instructions).toContain(
    "content-type、x-oss-forbid-overwrite",
  );
  expect(action?.instructions).not.toMatch(/x-oss-signature|access_key/u);
  expect(
    value(listNeedsYou(state, human)).data.human_actions.map((h) => h.id),
  ).toContain(action?.id);

  // Still refused: nothing new, the same action stays.
  expect(
    value(reconcileStorageCorsAction(state, system, refused, io)).events,
  ).toEqual([]);

  // A different refusal refreshes the steps of the open action in place.
  const narrowed = value(
    reconcileStorageCorsAction(
      state,
      system,
      {
        ...refused,
        refused: [{ origin: origins[1] as string, reason: "not_allowed" }],
      },
      io,
    ),
  );
  expect(narrowed.events.map((e) => e.type)).toEqual([
    "storage_cors_action_updated",
  ]);
  state = apply(state, narrowed);
  expect(state.human_actions).toHaveLength(1);
  expect(state.human_actions[0]?.instructions).toContain(
    `不允许 ${origins[1]} 上传`,
  );

  // The rule is in place: the system recheck closes it.
  const closed = value(reconcileStorageCorsAction(state, system, allowed, io));
  expect(closed.events.map((e) => [e.type, e.payload])).toEqual([
    [
      "human_action_cancelled",
      expect.objectContaining({
        human_action_id: action?.id,
        source: "storage_rechecked",
      }),
    ],
  ]);
  state = apply(state, closed);
  expect(state.human_actions[0]).toMatchObject({
    status: "cancelled",
    cancellation: { source: "storage_rechecked", by: "system" },
  });
  // Nothing open: allowed again is a no-op.
  expect(
    value(reconcileStorageCorsAction(state, system, allowed, io)).events,
  ).toEqual([]);

  // Refused again after a recovery: a new action.
  state = apply(
    state,
    value(reconcileStorageCorsAction(state, system, refused, io)),
  );
  expect(state.human_actions.map((h) => h.status)).toEqual([
    "cancelled",
    "open",
  ]);
});

test("C-807: an action the owner closed while still refused is not reopened until a recheck passes", () => {
  const io = ports();
  let state = fixture();
  const system = { kind: "system" as const, project_id: state.project_id };
  state = apply(
    state,
    value(reconcileStorageCorsAction(state, system, refused, io)),
  );
  const id = state.human_actions[0]?.id;
  if (!id) throw new Error("missing action");
  // Account category: the system can never mark it done for the owner.
  expect(
    completeHumanAction(
      state,
      system,
      { human_action_id: id, text: "已完成" },
      io,
    ).ok,
  ).toBe(false);
  state = apply(
    state,
    value(
      cancelHumanAction(
        state,
        human,
        { human_action_id: id, reason: "暂不处理" },
        io,
      ),
    ),
  );
  expect(
    value(reconcileStorageCorsAction(state, system, refused, io)).events,
  ).toEqual([]);
  state = apply(
    state,
    value(reconcileStorageCorsAction(state, system, allowed, io)),
  );
  expect(
    value(reconcileStorageCorsAction(state, system, refused, io)).events.map(
      (e) => e.type,
    ),
  ).toEqual(["human_action_requested"]);
});

test("C-807: only the host system of this project records the check, with valid input", () => {
  const io = ports();
  const state = fixture();
  const system = { kind: "system" as const, project_id: state.project_id };
  for (const caller of [
    human,
    actor(1, "coder"),
    actor(4, "pm"),
    actor(5, "host_ops"),
    { ...system, project_id: "other" },
  ])
    expect(reconcileStorageCorsAction(state, caller, refused, io).ok).toBe(
      false,
    );
  for (const bad of [
    { ...refused, origins: [] },
    { ...refused, bucket: "Bad_Bucket" },
    { ...refused, origins: ["https://a.example/path?x-oss-signature=1"] },
    {
      ...refused,
      refused: [{ origin: "https://elsewhere.example", reason: "not_enabled" }],
    },
  ] as StorageCorsCheck[])
    expect(reconcileStorageCorsAction(state, system, bad, io).ok).toBe(false);
});
