import { expect, test } from "vitest";
import {
  assignment,
  card,
  event,
  project_id,
  withTempStore,
} from "./test-support.js";

test("the first call runs the operation and stores the response", () => {
  withTempStore((store) => {
    let calls = 0;
    const result = store.runIdempotent(
      {
        project_id,
        assignment_id: assignment().id,
        key: "fictional-key-1",
        request: { message: "hello" },
      },
      () => {
        calls += 1;
        return { accepted: true, note: "fictional" };
      },
    );

    expect(result).toEqual({
      ok: true,
      value: { value: { accepted: true, note: "fictional" }, replayed: false },
    });
    expect(calls).toBe(1);
    const rows = store.database
      .prepare("SELECT COUNT(*) AS n FROM idempotency")
      .get();
    expect(Number(rows?.n)).toBe(1);
  });
});

test("the same key with the same request replays the stored response", () => {
  withTempStore((store) => {
    let calls = 0;
    const run = (request: unknown) =>
      store.runIdempotent(
        {
          project_id,
          assignment_id: assignment().id,
          key: "fictional-key-1",
          request,
        },
        () => {
          calls += 1;
          return { delivery_id: "D-1" };
        },
      );

    const first = run({ message: "hello", tags: ["a", "b"] });
    // Same content, different key order: still the same request.
    const second = run({ tags: ["a", "b"], message: "hello" });

    expect(first).toMatchObject({ ok: true, value: { replayed: false } });
    expect(second).toMatchObject({
      ok: true,
      value: { value: { delivery_id: "D-1" }, replayed: true },
    });
    expect(calls).toBe(1);
  });
});

test("a replay does not write a second event or entity", () => {
  withTempStore((store) => {
    store.uow.run((tx) => tx.cards.put(project_id, card()));

    const submit = () =>
      store.runIdempotent(
        {
          project_id,
          assignment_id: assignment().id,
          key: "fictional-delivery",
          request: { work_item_id: "W-1", sha: "abc" },
        },
        (tx) => {
          const seq = tx.ids.nextEventSequence(project_id, card().id);
          tx.events.append(
            project_id,
            event({ id: tx.ids.nextEventId(), seq }),
          );
          return { seq };
        },
      );

    expect(submit()).toMatchObject({ ok: true, value: { replayed: false } });
    expect(submit()).toMatchObject({ ok: true, value: { replayed: true } });
    expect(
      store.getUpdates({ project_id, card_id: card().id }).events,
    ).toHaveLength(1);
  });
});

test("the same key with a different request is an idempotency_conflict", () => {
  withTempStore((store) => {
    const params = {
      project_id,
      assignment_id: assignment().id,
      key: "fictional-key-1",
    };
    const first = store.runIdempotent(
      { ...params, request: { sha: "aaa" } },
      () => "first",
    );
    expect(first.ok).toBe(true);

    let calls = 0;
    const conflict = store.runIdempotent(
      { ...params, request: { sha: "bbb" } },
      () => {
        calls += 1;
        return "second";
      },
    );

    expect(conflict.ok).toBe(false);
    expect(conflict.ok === false && conflict.error.code).toBe(
      "idempotency_conflict",
    );
    expect(calls).toBe(0);
    const rows = store.database
      .prepare("SELECT response FROM idempotency")
      .all();
    expect(rows.map((row) => String(row.response))).toEqual([
      JSON.stringify("first"),
    ]);
  });
});

test("keys are scoped per assignment and per project", () => {
  withTempStore((store) => {
    const run = (assignmentId: string, projectId: string, payload: string) =>
      store.runIdempotent(
        {
          project_id: projectId,
          assignment_id: assignmentId,
          key: "shared-key",
          request: { payload },
        },
        () => payload,
      );

    expect(run("A-1", project_id, "one")).toMatchObject({
      ok: true,
      value: { replayed: false },
    });
    expect(run("A-2", project_id, "two")).toMatchObject({
      ok: true,
      value: { replayed: false },
    });
    expect(run("A-1", "p-other", "three")).toMatchObject({
      ok: true,
      value: { replayed: false },
    });
  });
});

test("a rolled-back operation stores no idempotency row", () => {
  withTempStore((store) => {
    expect(() =>
      store.runIdempotent(
        {
          project_id,
          assignment_id: assignment().id,
          key: "fictional-key-1",
          request: { payload: 1 },
        },
        () => {
          throw new Error("fictional failure inside the operation");
        },
      ),
    ).toThrow(/fictional failure/);

    const rows = store.database
      .prepare("SELECT COUNT(*) AS n FROM idempotency")
      .get();
    expect(Number(rows?.n)).toBe(0);

    // The key is still free, so a retry runs for real.
    expect(
      store.runIdempotent(
        {
          project_id,
          assignment_id: assignment().id,
          key: "fictional-key-1",
          request: { payload: 1 },
        },
        () => "retried",
      ),
    ).toMatchObject({ ok: true, value: { value: "retried", replayed: false } });
  });
});
