import { type Decision, requestDecision } from "@cardigan/domain";
import { expect, test } from "vitest";
import { m5Cross, TEST_PASSWORD } from "../../test-support/m5-cross.js";
import {
  decodeDecisionHistoryCursor,
  encodeDecisionHistoryCursor,
  pageDecisionHistory,
} from "./decision-history.js";

const TEST_PLAIN_SUMMARY = {
  changed: "测试用的改动说明",
  impact: "测试用的影响说明",
  risk: "无",
};

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `Q-${String(i + 1).padStart(3, "0")}`,
    resolution: {
      at: `2026-11-${String(1 + Math.floor(i / 2)).padStart(2, "0")}T00:00:00.000Z`,
    },
  }));

test("pages newest first and stops exactly at the last record", () => {
  const all = rows(23);
  const first = pageDecisionHistory(all, { limit: 10 });
  expect(first.decisions.map((q) => q.id)).toEqual(
    [...all]
      .reverse()
      .slice(0, 10)
      .map((q) => q.id),
  );
  const seen = [...first.decisions];
  let cursor = first.next_cursor;
  while (cursor) {
    const page = pageDecisionHistory(all, {
      limit: 10,
      after: decodeDecisionHistoryCursor(cursor),
    });
    seen.push(...page.decisions);
    cursor = page.next_cursor;
  }
  expect(seen.map((q) => q.id)).toEqual([...all].reverse().map((q) => q.id));
});

test("exactly 10, fewer than 10 and empty inputs report no next page", () => {
  const ten = pageDecisionHistory(rows(10), { limit: 10 });
  expect(ten.decisions).toHaveLength(10);
  expect(ten.next_cursor).toBeNull();
  const three = pageDecisionHistory(rows(3), { limit: 10 });
  expect(three.decisions).toHaveLength(3);
  expect(three.next_cursor).toBeNull();
  expect(pageDecisionHistory([], { limit: 10 })).toEqual({
    decisions: [],
    next_cursor: null,
  });
  const eleven = pageDecisionHistory(rows(11), { limit: 10 });
  expect(eleven.next_cursor).not.toBeNull();
  const rest = pageDecisionHistory(rows(11), {
    limit: 10,
    after: decodeDecisionHistoryCursor(eleven.next_cursor ?? ""),
  });
  expect(rest.decisions.map((q) => q.id)).toEqual(["Q-001"]);
  expect(rest.next_cursor).toBeNull();
});

test("a record resolved after the first page neither shifts nor repeats rows", () => {
  const all = rows(15);
  const first = pageDecisionHistory(all, { limit: 10 });
  const newer = {
    id: "Q-999",
    resolution: { at: "2026-12-31T00:00:00.000Z" },
  };
  const second = pageDecisionHistory([...all, newer], {
    limit: 10,
    after: decodeDecisionHistoryCursor(first.next_cursor ?? ""),
  });
  expect(second.decisions.map((q) => q.id)).toEqual(
    [...all]
      .reverse()
      .slice(10)
      .map((q) => q.id),
  );
});

test("cursor round-trips and foreign cursors are rejected", () => {
  const row = { id: "Q-7", resolution: { at: "2026-11-01T00:00:00.000Z" } };
  expect(decodeDecisionHistoryCursor(encodeDecisionHistoryCursor(row))).toEqual(
    { at: row.resolution.at, id: row.id },
  );
  for (const bad of [
    "",
    "abc",
    "!!!",
    Buffer.from("[1,2]").toString("base64url"),
  ])
    expect(decodeDecisionHistoryCursor(bad)).toBeUndefined();
});

test("GET /decision-history pages with limit and cursor and filters the whole history", async () => {
  const f = await m5Cross();
  try {
    await f.password(TEST_PASSWORD);
    await f.login();
    const make = (category: "scope_change" | "spending") =>
      f.command((s, a, p) =>
        requestDecision(
          s,
          a,
          {
            card_id: f.card.id,
            category,
            kind: "choose",
            question: "如何继续",
            context: "已明确选项",
            options: [{ key: "go", description: "继续", impact: "推进当前卡" }],
            recommended: "go",
            decider: "human",
            plain_summary: TEST_PLAIN_SUMMARY,
            affected_cards: [f.card.id],
            affected_work_items: [],
            blocking: false,
          },
          p,
        ),
      );
    const resolve = async (q: Decision) =>
      expect(
        (
          await f.call(
            f.projectPath(`/decisions/${encodeURIComponent(q.id)}/resolve`),
            {
              method: "POST",
              headers: { "idempotency-key": `resolve-${q.id}` },
              body: { option: "go" },
            },
          )
        ).status,
      ).toBe(200);
    type Page = { decisions: Decision[]; next_cursor: string | null };
    const history = async (query: string) => {
      const r = await f.call(f.projectPath(`/decision-history?${query}`));
      expect(r.status).toBe(200);
      return r.json as Page;
    };
    // Ten scope_change and two spending decisions: 12 in all.
    const general: Decision[] = [];
    for (let i = 0; i < 10; i++) general.push(make("scope_change"));
    const scope = [make("spending"), make("spending")];
    for (const q of [...general, ...scope]) await resolve(q);

    const first = await history("");
    expect(first.decisions).toHaveLength(10);
    expect(first.next_cursor).toEqual(expect.any(String));
    const second = await history(
      `cursor=${encodeURIComponent(first.next_cursor ?? "")}`,
    );
    expect(second.decisions).toHaveLength(2);
    expect(second.next_cursor).toBeNull();
    const ids = [...first.decisions, ...second.decisions].map((q) => q.id);
    expect(new Set(ids).size).toBe(12);
    expect(ids.sort()).toEqual([...general, ...scope].map((q) => q.id).sort());

    // Exactly 10 matching records: one full page, no next page.
    const exact = await history("category=scope_change");
    expect(exact.decisions.map((q) => q.id).sort()).toEqual(
      general.map((q) => q.id).sort(),
    );
    expect(exact.next_cursor).toBeNull();
    // Fewer than 10 matching records.
    const few = await history("category=spending");
    expect(few.decisions.map((q) => q.id).sort()).toEqual(
      scope.map((q) => q.id).sort(),
    );
    expect(few.next_cursor).toBeNull();
    // Filtered to nothing.
    expect(await history("card_id=C-999")).toEqual({
      decisions: [],
      next_cursor: null,
    });
    // Explicit limit.
    const small = await history("limit=5&category=scope_change");
    expect(small.decisions).toHaveLength(5);
    expect(small.next_cursor).toEqual(expect.any(String));

    for (const query of [
      "limit=0",
      "limit=abc",
      "limit=101",
      "cursor=not-a-cursor",
    ])
      expect(
        (await f.call(f.projectPath(`/decision-history?${query}`))).status,
      ).toBe(400);
  } finally {
    await f.close();
  }
});
