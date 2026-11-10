import { expect, test } from "vitest";
import { m5Cross, TEST_PASSWORD } from "../../test-support/m5-cross.js";

type Json = Record<string, unknown>;

test("V9b role routes list, show, version history and run every write as the logged-in human", async () => {
  const f = await m5Cross();
  try {
    const roles = f.projectPath("/roles");
    expect((await f.call(roles)).status).toBe(401);
    await f.password(TEST_PASSWORD);
    await f.login();
    let keyCount = 0;
    const write = (
      suffix: string,
      body: unknown,
      options: { key?: string | null; headers?: Record<string, string> } = {},
    ) =>
      f.call(f.projectPath(`/roles${suffix}`), {
        method: "POST",
        body,
        headers: {
          ...(options.key === null
            ? {}
            : { "idempotency-key": options.key ?? `role-${++keyCount}` }),
          ...options.headers,
        },
      });

    // List: id, display name, kind, status and current version for every role.
    const list = (await f.call(roles)).json as Json;
    expect(list.roles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role_id: "coder",
          display_name: "coder",
          kind: "produce",
          status: "active",
          version: 1,
        }),
        expect.objectContaining({ role_id: "reviewer", kind: "verify" }),
        expect.objectContaining({ role_id: "pm", kind: "standing" }),
      ]),
    );
    expect(list.default_roles).toEqual(expect.arrayContaining(["coder"]));
    expect((list.allowlists as Record<string, string[]>).produce).not.toContain(
      "submit_review",
    );

    // Detail: full definition plus the V9a legacy conversion proposal.
    const detail = (await f.call(f.projectPath("/roles/coder"))).json as Json;
    expect(detail.role).toMatchObject({
      role_id: "coder",
      kind: "produce",
      worktree: "write",
      capabilities: [],
      abilities: [],
      required_machine_tags: [],
      allowed_tools: expect.arrayContaining(["submit_delivery"]),
    });
    expect(detail.previous).toBeNull();
    expect(detail.legacy_conversion).toMatchObject({
      instructions: expect.any(String),
    });
    expect(detail.allowlist).not.toContain("submit_review");
    expect((await f.call(f.projectPath("/roles/missing"))).status).toBe(404);
    expect((await f.call(f.projectPath("/roles/missing/history"))).status).toBe(
      404,
    );

    // Copy from the default role pack and from an existing project role.
    const fromDefault = await write("/copy", {
      role_id: "designer-x",
      display_name: "设计师",
      source: {
        kind: "default",
        role_id: "designer",
        harness: "codex",
        launch_profile_ref: "codex-agent",
      },
    });
    expect(fromDefault.status).toBe(200);
    expect(fromDefault.json).toMatchObject({
      role_id: "designer-x",
      display_name: "设计师",
      kind: "verify",
      version: 1,
      status: "active",
      instructions: expect.any(String),
    });
    const fromRole = await write("/copy", {
      role_id: "coder-b",
      source: { kind: "project", role_id: "coder", version: 1 },
    });
    expect(fromRole.json).toMatchObject({ role_id: "coder-b", version: 1 });
    expect(
      (
        await write("/copy", {
          role_id: "coder-c",
          source: { kind: "project", project_id: "nowhere", role_id: "coder" },
        })
      ).status,
    ).toBe(404);
    const duplicate = await write("/copy", {
      role_id: "coder-b",
      source: { kind: "project", role_id: "coder" },
    });
    expect(duplicate.status).toBe(400);
    expect(JSON.stringify(duplicate.json)).toContain("已存在");

    // Create from a full definition.
    const created = await write("", {
      role_id: "writer",
      display_name: "写手",
      kind: "produce",
      instructions: "负责写文档。",
      harness: "pi",
      launch_profile_ref: "fixture",
      allowed_tools: ["whoami", "get_card", "submit_delivery"],
      capabilities: ["produce"],
      abilities: ["docs"],
      worktree: "write",
      required_machine_tags: [],
    });
    expect(created.status).toBe(200);
    expect(created.json).toMatchObject({ role_id: "writer", version: 1 });

    // Edit creates a new version; the allowlist error comes back in Chinese.
    const key = "edit-writer";
    const edited = await write(
      "/writer/update",
      {
        instructions: "负责写文档和发布说明。",
        abilities: ["docs", "release"],
      },
      { key },
    );
    expect(edited.json).toMatchObject({ version: 2 });
    // Same key, same body: replay. Same key, other body: conflict.
    expect(
      (
        await write(
          "/writer/update",
          {
            instructions: "负责写文档和发布说明。",
            abilities: ["docs", "release"],
          },
          { key },
        )
      ).json,
    ).toEqual(edited.json);
    expect(
      (await write("/writer/update", { abilities: [] }, { key })).status,
    ).toBe(409);
    const widened = await write("/writer/update", {
      allowed_tools: ["whoami", "submit_review"],
    });
    expect(widened.status).toBe(400);
    expect(widened.json).toMatchObject({
      error: {
        code: "validation_failed",
        message: "produce 角色含有白名单之外的工具",
      },
    });
    const invented = await write("/writer/update", {
      allowed_tools: ["git_push"],
    });
    expect(invented.status).toBe(400);
    const verifyWrite = await write("/designer-x/update", {
      worktree: "write",
    });
    expect(verifyWrite.json).toMatchObject({
      error: { message: "验证型角色的 worktree 只能为 readonly 或 none" },
    });
    const blank = await write("/writer/update", { display_name: " " });
    expect(blank.status).toBe(400);
    expect(JSON.stringify(blank.json)).toMatch(/\p{Script=Han}/u);
    expect((await write("/writer/update", {})).status).toBe(400);
    expect((await write("/missing/update", { abilities: [] })).status).toBe(
      404,
    );

    // Deactivate / activate, then rollback to v1 as a new version.
    expect((await write("/writer/deactivate", {})).json).toMatchObject({
      version: 3,
      status: "inactive",
    });
    expect((await f.call(roles)).json).toMatchObject({
      roles: expect.arrayContaining([
        expect.objectContaining({ role_id: "writer", status: "inactive" }),
      ]),
    });
    expect((await write("/writer/activate", {})).json).toMatchObject({
      version: 4,
      status: "active",
    });
    const rolled = await write("/writer/rollback", { version: 1 });
    expect(rolled.json).toMatchObject({
      version: 5,
      instructions: "负责写文档。",
      abilities: ["docs"],
      status: "active",
    });
    expect((await write("/writer/rollback", { version: 99 })).status).toBe(404);
    expect((await write("/writer/rollback", { version: 0 })).status).toBe(400);

    const writer = (await f.call(f.projectPath("/roles/writer"))).json as Json;
    expect(writer.role).toMatchObject({ version: 5 });
    expect(writer.previous).toMatchObject({ version: 4 });
    expect(writer.legacy_conversion).toBeNull();
    const history = (await f.call(f.projectPath("/roles/writer/history")))
      .json as { versions: Json[] };
    expect(history.versions.map((v) => [v.version, v.action])).toEqual([
      [5, "回退"],
      [4, "启用"],
      [3, "停用"],
      [2, "编辑"],
      [1, "创建"],
    ]);
    expect(history.versions[3]).toMatchObject({
      summary: "编辑：改动 instructions、abilities",
      changes: ["instructions", "abilities"],
      actor: "human",
      author_display: "你",
      created_at: expect.any(String),
    });

    // Cross-project copy: invalid source ids are 400 before any lookup; a real
    // copy reads the source role only and leaves the source project untouched.
    for (const bad of ["bad/id", "../other", "Other", " "])
      expect(
        (
          await write("/copy", {
            role_id: "coder-x",
            source: { kind: "project", project_id: bad, role_id: "coder" },
          })
        ).json,
      ).toMatchObject({
        error: {
          code: "validation_failed",
          message: expect.stringContaining("来源项目编号不合法"),
        },
      });
    const source = f.project.project_id;
    const snapshot = () =>
      f.store().uow.read((tx) => ({
        roles: tx.roles.list(source),
        events: tx.events.listAfter(source, undefined, 0),
      }));
    f.store().createProject({ id: "other" });
    const before = snapshot();
    const crossed = await f.call("/api/projects/other/roles/copy", {
      method: "POST",
      body: {
        role_id: "imported-writer",
        source: { kind: "project", project_id: source, role_id: "writer" },
      },
      headers: { "idempotency-key": "cross-project" },
    });
    expect(crossed.status).toBe(200);
    expect(crossed.json).toMatchObject({
      role_id: "imported-writer",
      version: 1,
      instructions: "负责写文档。",
    });
    expect(snapshot()).toEqual(before);
    expect(
      ((await f.call("/api/projects/other/roles")).json as Json).roles,
    ).toEqual([expect.objectContaining({ role_id: "imported-writer" })]);

    // Non-human callers: an Agent token, no session, or an actor field.
    const agent = await f.call(roles, {
      method: "POST",
      anonymous: true,
      body: { role_id: "agent-made" },
      headers: {
        authorization: `Bearer ${f.token(f.primary.owner)}`,
        "idempotency-key": "agent",
      },
    });
    expect(agent.status).toBe(401);
    const spoofed = await write("/writer/update", {
      abilities: [],
      actor: { kind: "assignment" },
    });
    expect(spoofed.status).toBe(400);
    expect((await write("/writer/activate", {}, { key: null })).status).toBe(
      400,
    );
    const events = f
      .store()
      .uow.read((tx) => tx.events.listAfter(f.project.project_id, undefined, 0))
      .filter((e) => e.type.startsWith("role_") && e.actor.kind !== "human");
    expect(
      events.filter((e) =>
        ["writer", "designer-x", "coder-b"].includes(
          (e.payload as { role: { role_id: string } }).role.role_id,
        ),
      ),
    ).toEqual([]);
  } finally {
    await f.close();
  }
});
