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
    for (const body of [
      { auto_merge_after_minutes: 1 },
      { merge_confirm_snooze_max_minutes: 60 },
    ])
      expect(
        (
          await f.call(path, {
            method: "POST",
            body,
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

test("C-237 human system rules and manual holds validate and audit without admitting Agent tokens", async () => {
  const f = await m5Cross();
  try {
    await f.password(TEST_PASSWORD);
    await f.login();
    const policy = {
      min_minutes: 2,
      max_minutes: 60,
      min_count: 1,
      max_count: 5,
      unassigned_ready_after_minutes: 3,
      pre_merge_check_pending_after_minutes: null,
      repeat: false,
      repeat_interval_minutes: null,
      max_reminders: 1,
    };
    const prefs = f.projectPath("/preferences");
    const write = (body: unknown, key: string) =>
      f.call(prefs, {
        method: "POST",
        body,
        headers: { "idempotency-key": key },
      });
    expect(
      (
        await write(
          {
            system_auto_assign_verifiers: true,
            system_reminders: true,
            system_reminder_policy: policy,
          },
          "system-on",
        )
      ).status,
    ).toBe(200);
    expect((await f.call(prefs)).json).toMatchObject({
      system_auto_assign_verifiers: true,
      system_reminders: true,
      system_reminder_policy: policy,
    });
    expect(
      (
        await write(
          {
            system_reminder_policy: {
              ...policy,
              unassigned_ready_after_minutes: 1,
            },
          },
          "invalid-system",
        )
      ).status,
    ).toBe(400);
    expect((await f.call(prefs)).json).toMatchObject({
      system_reminder_policy: policy,
    });
    const hold = f.projectPath(
      `/work-items/${f.primary.owner.scope === "work_item" ? f.primary.owner.work_item_id : "missing"}/manual-assign`,
    );
    expect(
      (
        await f.call(hold, {
          method: "POST",
          body: { manual_assign: true },
          headers: { "idempotency-key": "hold" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await f.call(hold, {
          method: "POST",
          body: { manual_assign: true },
          headers: { "idempotency-key": "hold" },
        })
      ).status,
    ).toBe(200);
    const token = f.token(f.primary.owner);
    for (const [path, body] of [
      [prefs, { system_auto_assign_verifiers: false }],
      [hold, { manual_assign: false }],
    ] as const)
      expect(
        (
          await f.call(path, {
            method: "POST",
            body,
            anonymous: true,
            headers: {
              authorization: `Bearer ${token}`,
              "idempotency-key": "agent-system",
            },
          })
        ).status,
      ).toBe(401);
    expect(
      (
        await f.call(hold, {
          method: "POST",
          body: { manual_assign: false },
          headers: { "idempotency-key": "unhold" },
        })
      ).status,
    ).toBe(200);
  } finally {
    await f.close();
  }
});

test("C-253: review round limits default to 5 and 3, only the human session may change them", async () => {
  const f = await m5Cross();
  try {
    const path = f.projectPath("/preferences");
    await f.password(TEST_PASSWORD);
    await f.login();
    expect((await f.call(path)).json).toMatchObject({
      review_max_rounds: 5,
      independent_review_max_rounds: 3,
      review_max_rounds_ceiling: 20,
    });
    const write = (body: unknown, key: string) =>
      f.call(path, {
        method: "POST",
        body,
        headers: { "idempotency-key": key },
      });
    for (const [i, invalid] of [0, 21, 1.5, "5", null].entries())
      for (const field of [
        "review_max_rounds",
        "independent_review_max_rounds",
      ])
        expect(
          (await write({ [field]: invalid }, `bad-${field}-${i}`)).status,
        ).toBe(400);
    expect(
      (
        await write(
          { review_max_rounds: 7, independent_review_max_rounds: 4 },
          "ok",
        )
      ).status,
    ).toBe(200);
    expect((await f.call(path)).json).toMatchObject({
      review_max_rounds: 7,
      independent_review_max_rounds: 4,
    });
    for (const [i, value] of [11, 20].entries()) {
      expect(
        (
          await write(
            { review_max_rounds: value, independent_review_max_rounds: value },
            `ok-${i}`,
          )
        ).status,
      ).toBe(200);
      expect((await f.call(path)).json).toMatchObject({
        review_max_rounds: value,
        independent_review_max_rounds: value,
      });
    }
    const token = f.token(f.primary.owner);
    for (const body of [
      { review_max_rounds: 20 },
      { independent_review_max_rounds: 20 },
    ])
      expect(
        (
          await f.call(path, {
            method: "POST",
            body,
            anonymous: true,
            headers: {
              authorization: `Bearer ${token}`,
              "idempotency-key": "agent-rounds",
            },
          })
        ).status,
      ).toBe(401);
  } finally {
    await f.close();
  }
});

test("C-265: the Workbench cannot change the tick-profile switch; only the local CLI can", async () => {
  const f = await m5Cross();
  try {
    const path = f.projectPath("/preferences");
    await f.password(TEST_PASSWORD);
    await f.login();
    for (const [i, body] of [
      { tick_profile: true },
      { tick_profile: false },
      // Bundling it with a valid field must not let it through either.
      { auto_merge_after_minutes: 10, tick_profile: true },
    ].entries())
      expect(
        (
          await f.call(path, {
            method: "POST",
            body,
            headers: { "idempotency-key": `tick-${i}` },
          })
        ).status,
      ).toBe(400);
    const stored = f
      .store()
      .uow.read((tx) =>
        tx.project_preferences.get(f.project.project_id, f.project.project_id),
      );
    expect(stored?.tick_profile).toBeUndefined();
    expect(stored?.auto_merge_after_minutes ?? null).toBeNull();
    expect(
      f
        .store()
        .uow.read((tx) =>
          tx.events.listAfter(f.project.project_id, undefined, 0),
        )
        .filter(
          (e) =>
            e.type === "project_preferences_updated" &&
            (e.payload as { preference?: string }).preference ===
              "tick_profile",
        ),
    ).toEqual([]);
  } finally {
    await f.close();
  }
});
