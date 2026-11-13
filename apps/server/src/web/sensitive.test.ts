import type {
  CardId,
  DecisionId,
  Delivery,
  DeliveryId,
  RunId,
  WorkItemId,
} from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import { afterEach, beforeEach, expect, test } from "vitest";
import { call, type WebHarness, webHarness } from "../../test-support/web.js";
import { project_id, seedWebProject } from "../../test-support/web-data.js";

// C-65: the sensitive flag and the human's direct answer to a PM-held merge.
let h: WebHarness, cookie: string;
const path = (suffix: string) => `/api/projects/${project_id}${suffix}`;
const read = (suffix: string) => call(h.port, path(suffix), { cookie });
const post = (suffix: string, body: unknown, key: string, auth = true) =>
  call(h.port, path(suffix), {
    ...(auth ? { cookie } : {}),
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      origin: h.server.url,
      "content-type": "application/json",
      "idempotency-key": key,
    },
  });
const ids = (list: unknown) =>
  (list as { id: string }[] | undefined)?.map((q) => q.id) ?? [];
const confirmation = () =>
  h.store.uow.read((tx) => tx.decisions.get(project_id, "Q-2"));

beforeEach(async () => {
  h = await webHarness({ password: "sensitive-test-password" });
  seedWebProject(h.store, h.dataDir);
  h.store.uow.run((tx) => {
    const card = tx.cards.get(project_id, "C-2");
    const item = tx.work_items.get(project_id, "W-2");
    const decision = tx.decisions.get(project_id, "D-1");
    if (!card || !item || !decision) throw new Error("Missing fixture");
    tx.cards.put(project_id, { ...card, status: "awaiting_merge" });
    tx.work_items.put(project_id, { ...item, status: "accepted" });
    for (const [id, kind] of [
      ["D-1", "code"],
      ["D-2", "card_completion"],
    ] as const) {
      const delivery: Delivery = {
        id: id as DeliveryId,
        kind,
        work_item_id: "W-2" as WorkItemId,
        run_id: "R-1" as RunId,
        summary: "Ready",
        subject: { kind: "git_head", value: "a".repeat(40) },
        status: "accepted",
        evidence: [],
        attachments: [],
        known_gaps: [],
        requested_verifiers: [],
      };
      tx.deliveries.put(project_id, delivery);
    }
    const { resolution: _resolution, ...open } = decision;
    tx.decisions.put(project_id, {
      ...open,
      id: "Q-2" as DecisionId,
      key: "Q-2",
      card_id: "C-2" as CardId,
      kind: "approve",
      target: { delivery_id: "D-2" as DeliveryId },
      trigger: "merge_confirmation",
      raised_by: "system",
      status: "open",
      category: "general",
      decider: "role:pm",
      options: [
        { key: "merge", description: "合并", impact: "合并到 main" },
        { key: "hold", description: "暂不合并", impact: "保持待合并" },
        {
          key: "request_changes",
          description: "退回修改",
          impact: "回到开发",
        },
      ],
    });
  });
  cookie = await h.login("sensitive-test-password");
});
afterEach(async () => h?.close());

test("a PM-held merge is listed separately and the human can answer it directly", async () => {
  const needs = (await read("/needs-you")).json as Record<string, unknown>;
  expect(ids(needs.pm_held_merges)).toEqual(["Q-2"]);
  expect(ids(needs.decisions)).not.toContain("Q-2");
  const answer = await post(
    "/decisions/Q-2/resolve",
    { option: "hold", raw_quote: "等待核对" },
    "take-over",
  );
  expect(answer.status).toBe(200);
  expect(confirmation()).toMatchObject({
    decider: "human",
    status: "snoozed",
    snooze: { reason: "等待核对", by: "human" },
  });
  const after = (await read("/needs-you")).json as Record<string, unknown>;
  expect(ids(after.pm_held_merges)).toEqual([]);
});

test("the human marks and unmarks a card sensitive; a PM-held merge moves to the human", async () => {
  expect(
    (await post("/cards/C-2/sensitive", { sensitive: true }, "anon", false))
      .status,
  ).toBe(401);
  expect(
    (await post("/cards/C-2/sensitive", { sensitive: "yes" }, "bad")).status,
  ).toBe(400);
  const marked = await post("/cards/C-2/sensitive", { sensitive: true }, "on");
  expect(marked.status).toBe(200);
  expect((await read("/cards/C-2")).json).toMatchObject({
    card: { id: "C-2", sensitive: true },
    timeline: expect.arrayContaining([
      expect.objectContaining({
        event_type: "card_sensitivity_changed",
        author: "human",
      }),
    ]),
  });
  expect(confirmation()).toMatchObject({ decider: "human", status: "open" });
  const needs = (await read("/needs-you")).json as Record<string, unknown>;
  expect(ids(needs.decisions)).toContain("Q-2");
  expect(ids(needs.pm_held_merges)).toEqual([]);
  expect(
    (await post("/cards/C-2/sensitive", { sensitive: false }, "off")).status,
  ).toBe(200);
  const card = h.store.uow.read(
    (tx) =>
      loadCommandState(tx, project_id).cards.find((c) => c.id === "C-2")
        ?.sensitive,
  );
  expect(card).toBeUndefined();
});

test("C-72: the sensitive route says whether the flag actually changed", async () => {
  const on = await post("/cards/C-2/sensitive", { sensitive: true }, "on");
  expect(on.json).toMatchObject({
    card: { id: "C-2", sensitive: true },
    changed: true,
  });
  const off = await post("/cards/C-2/sensitive", { sensitive: false }, "off");
  expect(off.json).toMatchObject({ changed: true, auto_merge_due_at: null });
  const again = await post(
    "/cards/C-2/sensitive",
    { sensitive: false },
    "off-again",
  );
  expect(again.status).toBe(200);
  // Auto-merge is off in this fixture, so there is no due time to report.
  expect(again.json).toMatchObject({ changed: false, auto_merge_due_at: null });
});

test("C-180: HTTP hold rejects missing reasons, reads the audited default and exposes the snooze in both views", async () => {
  expect((await read("/preferences")).json).toMatchObject({
    merge_confirm_snooze_default_minutes: 240,
  });
  expect(
    (await post("/decisions/Q-2/resolve", { option: "hold" }, "missing-reason"))
      .status,
  ).toBe(400);
  expect(confirmation()?.status).toBe("open");
  expect(
    (
      await post(
        "/preferences",
        { merge_confirm_snooze_default_minutes: 30 },
        "snooze-pref",
      )
    ).status,
  ).toBe(200);
  expect((await read("/preferences")).json).toMatchObject({
    merge_confirm_snooze_default_minutes: 30,
  });
  expect(
    (
      await post(
        "/decisions/Q-2/resolve",
        { option: "hold", rationale: "等待核对" },
        "hold-default",
      )
    ).status,
  ).toBe(200);
  const q = confirmation();
  expect(q?.snooze?.reason).toBe("等待核对");
  if (!q?.snooze) throw new Error("Missing snooze");
  expect(Date.parse(q.snooze.until) - Date.parse(q.snooze.at)).toBe(
    30 * 60_000,
  );
  const detail = (await read("/cards/C-2")).json as {
    merge_confirmations: unknown[];
  };
  expect(detail.merge_confirmations).toEqual([
    expect.objectContaining({ status: "snoozed", snooze: q.snooze }),
  ]);
  const needs = (await read("/needs-you")).json as { decisions: unknown[] };
  expect(needs.decisions).toContainEqual(
    expect.objectContaining({ id: "Q-2", status: "snoozed", snooze: q.snooze }),
  );
  expect(
    h.store.uow.read((tx) => tx.events.listAfter(project_id, undefined, 0)),
  ).toContainEqual(
    expect.objectContaining({
      type: "project_preferences_updated",
      actor: { kind: "human", project_id },
      payload: {
        preference: "merge_confirm_snooze_default_minutes",
        old_value: 240,
        new_value: 30,
      },
    }),
  );
  const until = "2035-01-01T04:30:00.000Z";
  expect(
    (
      await post(
        "/decisions/Q-2/resolve",
        { option: "hold", raw_quote: "延后核对", snooze_until: until },
        "hold-until",
      )
    ).status,
  ).toBe(200);
  expect(confirmation()?.snooze?.until).toBe(until);
});
