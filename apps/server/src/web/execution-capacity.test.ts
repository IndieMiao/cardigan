import { effectiveRunLimit } from "@cardigan/host";
import { expect, test } from "vitest";
import { m5Cross, TEST_PASSWORD } from "../../test-support/m5-cross.js";

test("C-145 human session alone edits capacity, with validation, idempotency and global audit", async () => {
  const f = await m5Cross();
  try {
    const path = f.projectPath("/execution/capacity");
    const write = (
      body: unknown,
      key?: string,
      headers: Record<string, string> = {},
      anonymous = false,
    ) =>
      f.call(path, {
        method: "POST",
        body,
        headers: { ...headers, ...(key ? { "idempotency-key": key } : {}) },
        anonymous,
      });
    expect((await f.call(path)).status).toBe(401);
    await f.password(TEST_PASSWORD);
    await f.login();
    const input = { machine_id: "local", limit: 6 };
    expect((await write(input)).status).toBe(400);
    for (const role_id of ["coder", "pm", "host_ops"]) {
      // Credential scope does not matter: even a broadly granted Agent token is not a human session.
      const assignment_id = `A-${100 + ["coder", "pm", "host_ops"].indexOf(role_id)}`;
      const { work_item_id: _item, ...base } = f.primary.owner;
      f.store().uow.run((tx) =>
        tx.assignments.put(f.project.project_id, {
          ...base,
          id: assignment_id as never,
          role_id,
          scope: "standing",
          standing_mode: "ops",
        }),
      );
      const token = f.store().issueToken({
        project_id: f.project.project_id,
        assignment_id: assignment_id as never,
        role: {
          role_version: 1,
          allowed_tools: ["whoami", "assign", "host_ops_cancel_run"],
        },
      });
      expect(
        (
          await write(
            input,
            role_id,
            { authorization: `Bearer ${token.token}` },
            true,
          )
        ).status,
      ).toBe(401);
    }
    expect(
      (await write({ ...input, actor: { kind: "human" } }, "spoof")).status,
    ).toBe(400);
    expect(
      (await write({ ...input, max_concurrent: 6 }, "executor")).status,
    ).toBe(400);
    expect(
      (await write({ machine_id: "remote-check-only", limit: 3 }, "unknown"))
        .status,
    ).toBe(404);
    for (const limit of [0, -1, 1.5, "6", null, Number.MAX_SAFE_INTEGER + 1])
      expect(
        (await write({ machine_id: "local", limit }, `invalid-${limit}`))
          .status,
      ).toBe(400);
    const first = await write(input, "first");
    expect(first.status).toBe(200);
    expect((await write(input, "first")).json).toEqual(first.json);
    expect((await write({ ...input, limit: 7 }, "first")).status).toBe(409);
    expect((await write({ ...input, limit: 2 }, "lower")).status).toBe(200);
    expect((await f.call(path)).json).toMatchObject({
      agents: [{ machine_id: "local", limit: 2 }],
      merge_checks: [],
    });
    f.store().createProject({ id: "other" });
    expect(
      (await f.call("/api/projects/other/execution/capacity")).json,
    ).toMatchObject({ agents: [{ machine_id: "local", limit: 2 }] });
    expect(effectiveRunLimit(f.store(), "local", () => 4)).toBe(2);
    expect(effectiveRunLimit(f.store(), "local", () => 0)).toBe(0);
    expect(
      f
        .store()
        .uow.read((tx) =>
          tx.global_events
            .listAfter(0)
            .filter((event) => event.type === "run_capacity_updated"),
        ),
    ).toMatchObject([
      {
        actor: { kind: "human" },
        created_at: expect.any(String),
        payload: {
          machine_id: "local",
          member_id: "M-1",
          old_value: 4,
          new_value: 6,
        },
      },
      { actor: { kind: "human" }, payload: { old_value: 6, new_value: 2 } },
    ]);
  } finally {
    await f.close();
  }
});
