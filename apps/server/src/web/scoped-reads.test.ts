import type { ContextObservation, Event } from "@cardigan/domain";
import { expect, test, vi } from "vitest";
import { call, webHarness } from "../../test-support/web.js";
import {
  NOW,
  project_id,
  seedWebProject,
} from "../../test-support/web-data.js";
import { readCardDetail } from "./card-state.js";
import { readExecution } from "./execution-state.js";
import { executionView, projectState } from "./read.js";
import { scopedCardState } from "./sql-state.js";
import { readPagedCard } from "./timeline-state.js";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing fixture or query");
  return value;
}

const password = "scoped-read-test-password";

test("legacy attachment ownership is independent of timeline pages, filters and anchors", async () => {
  const f = await webHarness({ password });
  try {
    seedWebProject(f.store, f.dataDir);
    f.store.uow.run((tx) => {
      const attachment = tx.attachments.get(project_id, "F-1" as never);
      if (!attachment) throw new Error("missing fixture");
      const { card_id: _card, ...legacy } = attachment;
      tx.attachments.put(project_id, legacy);
    });
    const expected = required(
      readCardDetail(f.store, project_id, "C-1" as never, {
        timelineLimit: 1,
      }),
    ).attachments;
    expect(expected.map((a) => a.id)).toContain("F-1");
    const read = (query: string) =>
      required(
        readPagedCard(
          f.store,
          project_id,
          "C-1" as never,
          new URL(`http://localhost/cards/C-1?limit=1&${query}`),
          {},
        ),
      );
    const first = read("");
    for (const page of [
      first,
      read(`before=${first.timeline_next_cursor}`),
      read("type=review"),
      read("author=human"),
      read("at=entry-C-1%231"),
    ]) {
      expect(page.attachments).toEqual(expected);
      expect(page.timeline.length).toBeLessThanOrEqual(1);
    }
  } finally {
    await f.close();
  }
});

test.each([
  "session_replaced",
  "standing_session_restarted",
  "assignment_resumed",
  "host_ops_action_finished",
] as const)(
  "execution uses the latest %s generation and keeps current samples",
  async (type) => {
    const f = await webHarness({ password });
    try {
      seedWebProject(f.store, f.dataDir);
      const usage: ContextObservation = {
        agent: "codex",
        session_id: "s-1",
        transcript_path: null,
        cwd: "/fixture",
        model: "fixture-model",
        context_tokens: 128000,
        context_window_size: 400000,
        used_percentage: 32,
        updated_at: NOW,
        assignment_id: "A-1" as never,
        runtime_key: "null",
        source: "codex_rollout:last_token_usage",
      };
      const contexts = new Map([["A-1", usage]]);
      const read = () =>
        readExecution(
          f.store,
          project_id,
          new URL("http://localhost/execution"),
          NOW,
          30,
          contexts,
        );
      expect(read().assignments[0]?.run).toHaveProperty(
        "context_usage.used_ratio",
        0.32,
      );
      f.store.uow.run((tx) => {
        // The newest generation need not be the last inserted event or a Run trigger.
        for (const [i, created_at, assignment_id] of [
          [0, "2026-01-03T00:00:00.000Z", "A-1"],
          [1, "2026-01-02T00:00:00.000Z", "A-1"],
          [2, "2099-01-01T00:00:00.000Z", "A-other"],
        ] as const)
          tx.events.append(project_id, {
            id: `generation-${i}` as never,
            seq: 200 + i,
            card_id: "C-2" as never,
            type,
            actor: { kind: "system", project_id },
            payload: { assignment_id },
            created_at,
          });
      });
      const prepare = f.store.database.prepare.bind(f.store.database);
      const captured = vi.spyOn(f.store.database, "prepare");
      expect(read().assignments[0]?.run).not.toHaveProperty("context_usage");
      const query = required(
        captured.mock.calls
          .map(([sql]) => sql)
          .find((sql) => sql.includes("standing_session_restarted")),
      );
      captured.mockRestore();
      const plan = prepare(`EXPLAIN QUERY PLAN ${query}`)
        .all(project_id, "A-1")
        .map((r) => r.detail)
        .join(" ");
      expect(plan).toContain(
        "events_by_context_generation (project_id=? AND <expr>=?)",
      );
      expect(plan).not.toContain("TEMP B-TREE");
      contexts.set("A-1", { ...usage, updated_at: "2026-01-02T12:00:00.000Z" });
      expect(read().assignments[0]?.run).not.toHaveProperty("context_usage");
      contexts.set("A-1", { ...usage, updated_at: "2026-01-03T00:00:00.000Z" });
      expect(read().assignments[0]?.run).toEqual(
        executionView(
          projectState(f.store, project_id),
          NOW,
          [],
          [],
          30,
          contexts,
        ).assignments[0]?.run,
      );
      expect(read().assignments[0]?.run).toHaveProperty(
        "context_usage.used_ratio",
        0.32,
      );
    } finally {
      vi.restoreAllMocks();
      await f.close();
    }
  },
);

test("actual scoped event queries seek object keys, deduplicate and isolate projects", async () => {
  const f = await webHarness({ password });
  try {
    seedWebProject(f.store, f.dataDir);
    f.store.createProject({ id: "other" as never });
    const event = (
      id: string,
      payload: Event["payload"],
      card_id?: Event["card_id"],
    ): Event => ({
      id: id as never,
      seq: 1000,
      ...(card_id ? { card_id } : {}),
      type: "attachment_uploaded",
      actor: { kind: "system", project_id },
      payload,
      created_at: NOW,
    });
    f.store.uow.run((tx) => {
      tx.events.append(
        project_id,
        event(
          "selected",
          { decision_id: "D-1", attachment_id: "F-1" },
          "C-1" as never,
        ),
      );
      tx.events.append(project_id, {
        ...event("decision-only", { decision_id: "D-1" }),
        seq: 1001,
      });
      tx.events.append(project_id, {
        ...event("attachment-only", { attachment_id: "F-1" }),
        seq: 1002,
      });
      tx.events.append(project_id, event("unrelated", {}, "C-3" as never));
      const source = tx.cards.get(project_id, "C-1" as never);
      if (!source) throw new Error("missing fixture");
      tx.cards.put("other" as never, source);
      tx.events.append(
        "other" as never,
        event(
          "other-project",
          { decision_id: "D-1", attachment_id: "F-1" },
          "C-1" as never,
        ),
      );
    });
    const prepare = f.store.database.prepare.bind(f.store.database);
    const captured = vi.spyOn(f.store.database, "prepare");
    const state = f.store.uow.read((tx) =>
      scopedCardState(f.store, tx, project_id, ["C-1"]),
    );
    const queries = captured.mock.calls
      .map(([sql]) => sql)
      .filter((sql) => sql.includes("FROM events"));
    captured.mockRestore();
    expect(queries).toHaveLength(3);
    for (const [i, key] of [
      "card_id",
      "decision_id",
      "attachment_id",
    ].entries()) {
      const sql = required(queries[i]);
      expect(sql).toContain(key);
      const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(project_id, JSON.stringify(["C-1", "D-1", "F-1"]))
        .map((r) => r.detail)
        .join(" ");
      expect(plan).toContain(
        i === 0 ? "project_id=? AND card_id=?" : "project_id=? AND <expr>=?",
      );
      expect(plan).not.toMatch(/SCAN events/);
    }
    const ids = state.events.map((e) => e.id);
    expect(ids.filter((id) => id === "selected")).toHaveLength(1);
    expect(ids).toEqual(
      expect.arrayContaining(["decision-only", "attachment-only"]),
    );
    expect(ids).not.toContain("unrelated");
    expect(ids).not.toContain("other-project");
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
});

test("malformed assignment path encoding remains a not-found response", async () => {
  const f = await webHarness({ password });
  try {
    seedWebProject(f.store, f.dataDir);
    const cookie = await f.login(password);
    expect(
      (
        await call(
          f.port,
          `/api/projects/${project_id}/execution/assignments/%XX/runs`,
          { cookie },
        )
      ).status,
    ).toBe(404);
  } finally {
    await f.close();
  }
});
