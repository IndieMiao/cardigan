import { expect, test } from "vitest";
import { m5Cross, TEST_PASSWORD } from "../../test-support/m5-cross.js";

test("human preferences require session and idempotency, persist audit, and isolate projects", async () => {
  const f = await m5Cross();
  try {
    const path = f.projectPath("/preferences");
    expect((await f.call(path)).status).toBe(401);
    await f.password(TEST_PASSWORD);
    await f.login();
    expect((await f.call(path)).json).toMatchObject({
      auto_merge_after_minutes: null,
      merge_gate_enabled: false,
    });
    const write = (value: unknown, key?: string, anonymous = false) =>
      f.call(path, {
        method: "POST",
        body: { auto_merge_after_minutes: value },
        anonymous,
        ...(key ? { headers: { "idempotency-key": key } } : {}),
      });
    expect((await write(10)).status).toBe(400);
    expect((await write(10, "key", true)).status).toBe(401);
    const first = await write(10, "key");
    expect(first.status).toBe(200);
    expect((await write(10, "key")).json).toEqual(first.json);
    expect((await write(20, "key")).status).toBe(409);
    for (const invalid of [0, -1, 1.5, 1441, "10", false])
      expect((await write(invalid, `invalid-${invalid}`)).status).toBe(400);
    expect((await f.call(path)).json).toMatchObject({
      auto_merge_after_minutes: 10,
    });
    expect((await write(null, "off")).status).toBe(200);
    const events = f
      .store()
      .uow.read((tx) => tx.events.listAfter(f.project.project_id, undefined, 0))
      .filter(
        (e) =>
          e.type === "project_preferences_updated" &&
          (e.payload as { preference?: string }).preference ===
            "auto_merge_after_minutes",
      );
    expect(events).toMatchObject([
      {
        actor: { kind: "human" },
        created_at: expect.any(String),
        payload: { old_value: null, new_value: 10 },
      },
      { actor: { kind: "human" }, payload: { old_value: 10, new_value: null } },
    ]);
    f.store().createProject({ id: "other" });
    expect(
      (await f.call("/api/projects/other/preferences")).json,
    ).toMatchObject({ auto_merge_after_minutes: null });
    expect((await f.call("/api/projects/missing/preferences")).status).toBe(
      404,
    );
    const token = f.token(f.primary.owner);
    expect(
      (
        await f.call(path, {
          method: "POST",
          body: { auto_merge_after_minutes: 1 },
          anonymous: true,
          headers: {
            authorization: `Bearer ${token}`,
            "idempotency-key": "agent",
          },
        })
      ).status,
    ).toBe(401);
  } finally {
    await f.close();
  }
});

test("board lane folding persists across sessions as a per-lane patch and is validated", async () => {
  const f = await m5Cross();
  try {
    const path = f.projectPath("/preferences");
    await f.password(TEST_PASSWORD);
    await f.login();
    const write = (lanes: unknown, key: string) =>
      f.call(path, {
        method: "POST",
        body: { board_collapsed_lanes: lanes },
        headers: { "idempotency-key": key },
      });
    expect((await write({ backlog: false }, "lane-1")).status).toBe(200);
    expect((await write({ in_progress: true }, "lane-2")).status).toBe(200);
    for (const [i, invalid] of [
      { archived: true },
      { done: "yes" },
      ["done"],
      null,
    ].entries())
      expect((await write(invalid, `lane-bad-${i}`)).status).toBe(400);
    // A second login stands in for another device: the server keeps the lanes.
    await f.login();
    expect((await f.call(path)).json).toMatchObject({
      auto_merge_after_minutes: null,
      board_collapsed_lanes: { backlog: false, in_progress: true },
    });
    expect((await write({ backlog: null }, "lane-3")).status).toBe(200);
    expect((await f.call(path)).json).toMatchObject({
      board_collapsed_lanes: { in_progress: true },
    });
    expect(
      (await f.call(path)).json as { board_collapsed_lanes: object },
    ).not.toHaveProperty("board_collapsed_lanes.backlog");
    const events = f
      .store()
      .uow.read((tx) => tx.events.listAfter(f.project.project_id, undefined, 0))
      .filter(
        (e) =>
          e.type === "project_preferences_updated" &&
          (e.payload as { preference?: string }).preference ===
            "board_collapsed_lanes",
      );
    // Folding is a view setting: it never feeds the activity stream.
    expect(events).toEqual([]);
  } finally {
    await f.close();
  }
});
