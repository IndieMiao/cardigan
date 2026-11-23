import { expect, test } from "vitest";
import type { Delivery } from "../entities.js";
import { authorizeMacosCheck, validMacosTestFiles } from "../macos-checks.js";
import type { CommandState } from "./core.js";
import { actor, fixture, id, now, subject } from "./test-fixtures.js";

const delivery = (n: number, patch: Partial<Delivery> = {}): Delivery => ({
  id: id("delivery", n),
  work_item_id: id("work_item", 1),
  run_id: id("run", 1),
  kind: "code",
  summary: "Ship",
  subject,
  evidence: [],
  attachments: [],
  known_gaps: [],
  requested_verifiers: [],
  status: "submitted",
  ...patch,
});
const state = (deliveries: Delivery[] = [delivery(1)]): CommandState => ({
  ...fixture(),
  deliveries,
});

test("the producer and a verifier targeting it address the producer's current Git delivery", () => {
  const current = delivery(2, {
    subject: { ...subject, value: "b".repeat(40) },
  });
  const s = state([delivery(1, { status: "superseded" }), current]);
  for (const [n, role, item] of [
    [1, "coder", 1],
    [2, "reviewer", 2],
  ] as const) {
    const result = authorizeMacosCheck(s, actor(n, role));
    expect(result).toEqual({
      ok: true,
      value: {
        project_id: s.project_id,
        card_id: id("card", 1),
        requester: {
          assignment_id: id("assignment", n),
          work_item_id: id("work_item", item),
          role_id: role,
        },
        producer_work_item_id: id("work_item", 1),
        delivery_id: current.id,
        head_sha: "b".repeat(40),
      },
    });
  }
});

test("a verify item without a producer target, humans and inactive owners cannot request", () => {
  const s = state();
  expect(authorizeMacosCheck(s, actor(3, "pm")).ok).toBe(false);
  expect(
    authorizeMacosCheck(s, { kind: "human", project_id: s.project_id }).ok,
  ).toBe(false);
  const inactive = {
    ...s,
    assignments: s.assignments.map((a) =>
      a.id === id("assignment", 2) ? { ...a, status: "released" as const } : a,
    ),
  };
  expect(authorizeMacosCheck(inactive, actor(2, "reviewer")).ok).toBe(false);
});

test("a held or closed card, or a missing Git delivery, is rejected", () => {
  const held = state();
  const hold = {
    reason: "x",
    resume_condition: "y",
    set_by: "human",
    set_at: now,
  } as const;
  expect(
    authorizeMacosCheck(
      { ...held, cards: held.cards.map((c) => ({ ...c, hold })) },
      actor(),
    ).ok,
  ).toBe(false);
  expect(
    authorizeMacosCheck(
      {
        ...held,
        cards: held.cards.map((c) => ({ ...c, status: "done" as const })),
      },
      actor(),
    ).ok,
  ).toBe(false);
  expect(authorizeMacosCheck(state([]), actor()).ok).toBe(false);
  expect(
    authorizeMacosCheck(
      state([delivery(1, { subject: { kind: "doc_version", value: "v1" } })]),
      actor(),
    ).ok,
  ).toBe(false);
  expect(
    authorizeMacosCheck(
      state([delivery(1, { kind: "card_completion" })]),
      actor(),
    ).ok,
  ).toBe(false);
});

test("only bounded, unique repository test files are accepted", () => {
  expect(
    validMacosTestFiles([
      "packages/runtime-herdr/src/darwin-retirement.test.ts",
      "apps/web/src/a/b.test.tsx",
    ]),
  ).toBe(true);
  for (const bad of [
    [],
    "packages/a/src/x.test.ts",
    ["packages/a/src/x.test.ts", "packages/a/src/x.test.ts"],
    ["packages/a/src/x.ts"],
    ["packages/a/../b/x.test.ts"],
    ["/abs/x.test.ts"],
    ["--reporter=x"],
    ["packages/a/src/*.test.ts"],
    ["packages/a/src/x y.test.ts"],
    ["deploy/x.test.ts"],
    Array.from({ length: 17 }, (_, n) => `packages/a/src/x${n}.test.ts`),
  ])
    expect(validMacosTestFiles(bad)).toBe(false);
});
