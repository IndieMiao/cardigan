import {
  type Card,
  type CardTemplateDefinition,
  createCard,
  generalCardTemplate,
  type Role,
} from "@cardigan/domain";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import { writeRole } from "@cardigan/store";
import { afterEach, beforeEach, expect, test } from "vitest";
import { call, type WebHarness, webHarness } from "../../test-support/web.js";

const project = "templates",
  password = "template route test password";
let h: WebHarness, cookie: string;
let serial = 0;
const path = (rest: string) => `/api/projects/${project}${rest}`;
const read = (rest: string) => call(h.port, path(rest), { cookie });
const write = (
  rest: string,
  body: unknown,
  key: string | null = `template-${++serial}`,
  session = cookie,
) =>
  call(h.port, path(rest), {
    method: "POST",
    cookie: session,
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      origin: h.server.url,
      ...(key === null ? {} : { "idempotency-key": key }),
    },
  });
const definition = (
  extra: Partial<CardTemplateDefinition> = {},
): CardTemplateDefinition => {
  const {
    builtin: _builtin,
    status: _status,
    version: _version,
    ...base
  } = generalCardTemplate;
  return { ...base, id: "custom", ...extra };
};
function makeCard(template_id = "general") {
  return h.store.uow.run((tx) => {
    const effect = unwrap(
      createCard(
        loadCommandState(tx, project),
        { kind: "human", project_id: project },
        {
          template_id,
          title: "Template test",
          goal: "Validate completion",
          acceptance_criteria: ["Ready"],
          source: { kind: "quote", text: "Test" },
          repo: "example/repo",
          base_branch: "main",
        },
        { clock: { now: () => new Date().toISOString() }, ids: tx.ids },
      ),
    );
    persistEffect(tx, project, effect);
    return effect.data;
  });
}
beforeEach(async () => {
  h = await webHarness({ password });
  unwrap(h.store.createProject({ id: project }));
  h.store.uow.run((tx) => {
    for (const role_id of ["coder", "reviewer", "pm", "designer"]) {
      const role: Role = {
        role_id,
        version: 1,
        display_name: role_id,
        kind: "work",
        harness: "codex",
        core_prompt: "Test",
        launch_profile_ref: "test",
        abilities: [],
        capabilities: [],
        required_machine_tags: [],
        worktree: "none",
        allowed_tools: [],
      };
      writeRole(tx, project, role, { mode: "add" });
    }
  });
  cookie = await h.login(password);
});
afterEach(async () => {
  await h.close();
});

test("list, details and version history preserve project boundaries and do not mutate state", async () => {
  const before = h.store.database
    .prepare("SELECT count(*) AS n FROM events")
    .get();
  expect((await read("/card-templates")).json).toMatchObject({
    templates: [
      { id: "artifact", builtin: true, version: 1, status: "active" },
      {
        id: "design",
        builtin: true,
        completion: { mode: "review", reviewer: "human" },
      },
      { id: "dev", requires_repo: true, merge: "confirm" },
      { id: "general", completion: { mode: "human_mark_done" } },
    ],
  });
  expect((await read("/card-templates/dev")).json).toMatchObject({
    template: {
      primary_work_item_key: "development",
      require_acceptance_criteria: true,
      work_items: expect.any(Array),
    },
    previous: null,
  });
  expect((await read("/card-templates/general/history")).json).toMatchObject({
    versions: [{ version: 1, summary: expect.any(String), created_at: null }],
  });
  expect((await read("/card-templates/missing")).status).toBe(404);
  expect(
    h.store.database.prepare("SELECT count(*) AS n FROM events").get(),
  ).toEqual(before);
  expect((await call(h.port, path("/card-templates"))).status).toBe(401);
});

test.each(["copy", "add"] as const)(
  "a template named validate supports %s, reads and later edits without shadowing preview POST",
  async (action) => {
    expect((await read("/card-templates/validate")).status).toBe(404);
    const change =
      action === "copy"
        ? { action, template_id: "general", new_id: "validate" }
        : { action, definition: definition({ id: "validate" }) };
    expect(
      (await write("/card-templates/validate", change, null)).json,
    ).toEqual({ valid: true, reason: null });
    expect((await read("/card-templates/validate")).status).toBe(404);
    expect((await write("/card-templates", change)).json).toMatchObject({
      id: "validate",
      version: 1,
    });
    const detail = await read("/card-templates/validate");
    expect(detail.status).toBe(200);
    expect(detail.json).toMatchObject({
      template: { id: "validate", version: 1 },
      previous: null,
    });
    expect((await read("/card-templates/validate/history")).json).toMatchObject(
      { versions: [{ id: "validate", version: 1 }] },
    );
    const update = {
      action: "update",
      definition: definition({ id: "validate", title: "修改后的模板" }),
    };
    expect(
      (await write("/card-templates/validate", update, null)).json,
    ).toEqual({ valid: true, reason: null });
    expect((await read("/card-templates/validate")).json).toMatchObject({
      template: { version: 1 },
    });
    expect((await write("/card-templates", update)).json).toMatchObject({
      id: "validate",
      title: "修改后的模板",
      version: 2,
    });
    expect((await read("/card-templates/validate")).json).toMatchObject({
      template: { version: 2 },
      previous: { version: 1 },
    });
    expect((await read("/card-templates/validate/history")).json).toMatchObject(
      { versions: [{ version: 2 }, { version: 1 }] },
    );
  },
);

test("copy, edit, deactivate, activate and rollback append versions; writes replay with human audit", async () => {
  const copy = { action: "copy", template_id: "dev", new_id: "project-dev" };
  expect((await write("/card-templates", copy, null)).status).toBe(400);
  const first = await write("/card-templates", copy, "copy-key");
  expect(first.status).toBe(200);
  expect(first.json).toMatchObject({
    id: "project-dev",
    version: 1,
    builtin: false,
  });
  expect((await write("/card-templates", copy, "copy-key")).json).toEqual(
    first.json,
  );
  expect(
    (
      await write(
        "/card-templates",
        { ...copy, new_id: "different" },
        "copy-key",
      )
    ).status,
  ).toBe(409);
  const card = makeCard("project-dev");
  const updated = { ...definition(), id: "project-dev", title: "新版模板" };
  expect(
    (await write("/card-templates", { action: "update", definition: updated }))
      .json,
  ).toMatchObject({ version: 2, title: "新版模板" });
  expect((await read(`/cards/${card.id}`)).json).toMatchObject({
    template: { title: "开发卡", version: 1 },
  });
  for (const [action, version, status] of [
    ["deactivate", 3, "inactive"],
    ["activate", 4, "active"],
    ["deactivate", 5, "inactive"],
  ]) {
    expect(
      (await write("/card-templates", { action, template_id: "project-dev" }))
        .json,
    ).toMatchObject({ version, status });
  }
  expect(
    (
      await write("/card-templates", {
        action: "rollback",
        template_id: "project-dev",
        version: 1,
      })
    ).json,
  ).toMatchObject({ version: 6, title: "开发卡", status: "inactive" });
  expect(
    (await read("/card-templates/project-dev/history")).json,
  ).toMatchObject({
    versions: expect.arrayContaining([
      {
        ...(first.json as object),
        summary: "开发卡 · 3 个工作项",
        created_at: expect.any(String),
      },
    ]),
  });
  expect(
    (
      await write("/card-templates", {
        action: "rollback",
        template_id: "project-dev",
        version: 99,
      })
    ).status,
  ).toBe(404);
  const events = h.store.uow
    .read((tx) => tx.events.listAfter(project, undefined, 0))
    .filter((e) => e.type === "card_template_changed");
  expect(events).toHaveLength(6);
  expect(events.every((e) => e.actor.kind === "human")).toBe(true);
  unwrap(h.store.createProject({ id: "other" }));
  expect(
    (
      await call(h.port, "/api/projects/other/card-templates/project-dev", {
        cookie,
      })
    ).status,
  ).toBe(404);
});

test("builtin mutations and Agent credentials are rejected, actor fields cannot be forged", async () => {
  for (const id of ["dev", "general", "artifact"]) {
    for (const action of ["deactivate", "activate", "rollback"]) {
      const response = await write("/card-templates", {
        action,
        template_id: id,
        ...(action === "rollback" ? { version: 1 } : {}),
      });
      expect(response.json).toMatchObject({
        error: { message: "内置模板不能修改，请先复制成新编号" },
      });
    }
    expect(
      (
        await write("/card-templates", {
          action: "update",
          definition: definition({ id }),
        })
      ).status,
    ).toBe(400);
  }
  const body = { action: "add", definition: definition() };
  expect(
    (await write("/card-templates", { ...body, actor: { kind: "human" } }))
      .status,
  ).toBe(400);
  for (const rest of [
    "/card-templates",
    "/card-templates/validate",
    `/cards/${makeCard().id}/mark-done`,
  ]) {
    const res = await call(h.port, path(rest), {
      method: "POST",
      headers: {
        authorization: "Bearer agent-credential",
        origin: h.server.url,
        "content-type": "application/json",
        "idempotency-key": "agent",
      },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(401);
  }
});

test("live validation uses domain rules without allocating IDs or writing events, save revalidates", async () => {
  const produce = {
    key: "work",
    title: "产出",
    role_id: "coder",
    kind: "produce",
    required: true,
  } as const;
  const verify = {
    key: "review",
    title: "验证",
    role_id: "reviewer",
    kind: "verify",
    required: true,
  } as const;
  const invalid: [Partial<CardTemplateDefinition>, string][] = [
    [{ work_items: [produce, produce] }, "工作项 key 必须唯一"],
    [
      { work_items: [{ ...verify, target_work_item_key: "missing" }] },
      "验证目标必须是同模板的产出项",
    ],
    [
      { work_items: [verify], primary_work_item_key: "review" },
      "主产出 key 必须指向产出项或为空",
    ],
    [
      { completion: { mode: "review", reviewer: "human" } },
      "审核完成必须有主产出项",
    ],
    [{ merge: "auto", requires_repo: false }, "需要合并的模板必须要求仓库"],
    [
      { work_items: [{ ...produce, role_id: "missing" }] },
      "角色 missing 未登记或已停用",
    ],
    [
      {
        work_items: [produce],
        primary_work_item_key: "work",
        completion: { mode: "review", reviewer: "role:pm" },
      },
      "完成审核必须有该角色的必需验收项",
    ],
  ];
  const before = JSON.stringify(
    h.store.uow.read((tx) => loadCommandState(tx, project)),
  );
  for (const [extra, reason] of invalid) {
    const body = { action: "add", definition: definition(extra) };
    expect((await write("/card-templates/validate", body, null)).json).toEqual({
      valid: false,
      reason,
    });
    expect((await write("/card-templates", body)).json).toMatchObject({
      error: { message: reason },
    });
  }
  const valid = {
    action: "add",
    definition: definition({ work_items: [produce] }),
  };
  expect((await write("/card-templates/validate", valid, null)).json).toEqual({
    valid: true,
    reason: null,
  });
  expect(
    JSON.stringify(h.store.uow.read((tx) => loadCommandState(tx, project))),
  ).toBe(before);
  h.store.uow.run((tx) => {
    const role = tx.roles.get(project, { role_id: "coder", role_version: 1 });
    if (!role) throw new Error("Missing role");
    tx.roles.put(project, { ...role, role_version: 2, status: "inactive" });
  });
  expect((await write("/card-templates", valid)).json).toMatchObject({
    error: { message: "角色 coder 未登记或已停用" },
  });
  expect(
    (
      await write("/card-templates", {
        action: "add",
        definition: definition(),
      })
    ).json,
  ).toMatchObject({ id: "custom", version: 1 });
});

test("mark done exposes domain eligibility, requires result, enforces same-card evidence and replays once", async () => {
  const card = makeCard();
  const other = makeCard();
  const route = `/cards/${card.id}/mark-done`;
  expect((await read(`/cards/${card.id}`)).json).toMatchObject({
    template: { title: "通用任务", version: 1 },
    mark_done: { allowed: true, reason: null },
  });
  expect((await write(route, { result: "完成" }, null)).status).toBe(400);
  expect((await write(route, { result: "  " })).status).toBe(400);
  h.store.uow.run((tx) => {
    tx.attachments.put(project, {
      id: "evidence",
      card_id: other.id,
      sha256: "a".repeat(64),
      storage_path: "test",
      mime: "text/plain",
      size: 1,
      kind: "evidence",
      uploaded_by: "human",
      attach_to: { kind: "timeline_entry", id: `${other.id}#1` },
    });
  });
  expect(
    (await write(route, { result: "完成", attachments: ["evidence"] })).json,
  ).toMatchObject({ error: { message: "证据附件不属于此卡片" } });
  h.store.uow.run((tx) => {
    const a = tx.attachments.get(project, "evidence");
    if (a) tx.attachments.put(project, { ...a, card_id: card.id });
  });
  const body = { result: "结果已确认", attachments: ["evidence"] };
  const done = await write(route, body, "done-key");
  expect(done.json).toMatchObject({ status: "done", resolution: "done" });
  expect((await write(route, body, "done-key")).json).toEqual(done.json);
  expect((await write(route, body)).status).toBe(409);
  expect((await read(`/cards/${card.id}`)).json).toMatchObject({
    mark_done: { allowed: false, reason: "当前卡片状态不允许标记完成。" },
  });
  const events = h.store.uow
    .read((tx) => tx.events.listAfter(project, card.id, 0))
    .filter((e) => e.type === "card_marked_done");
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ actor: { kind: "human" }, payload: body });
  const dev = makeCard("dev");
  expect((await read(`/cards/${dev.id}`)).json).toMatchObject({
    mark_done: null,
  });
  expect(
    (await write(`/cards/${dev.id}/mark-done`, { result: "完成" })).json,
  ).toMatchObject({ error: { message: "该模板不允许人标记完成" } });
});

test("required work must be accepted or passed; optional work does not block human completion", async () => {
  await write("/card-templates", {
    action: "add",
    definition: definition({
      work_items: [
        {
          key: "p",
          title: "产出",
          role_id: "coder",
          kind: "produce",
          required: true,
        },
        {
          key: "v",
          title: "验证",
          role_id: "reviewer",
          kind: "verify",
          required: true,
          target_work_item_key: "p",
        },
        {
          key: "optional",
          title: "可选",
          role_id: "coder",
          kind: "produce",
          required: false,
        },
      ],
    }),
  });
  const card = makeCard("custom");
  const route = `/cards/${card.id}/mark-done`;
  expect((await read(`/cards/${card.id}`)).json).toMatchObject({
    mark_done: { allowed: false, reason: "必需工作项尚未全部完成" },
  });
  expect((await write(route, { result: "完成" })).status).toBe(409);
  h.store.uow.run((tx) => {
    for (const w of tx.work_items
      .list(project)
      .filter((w) => w.card_id === card.id && w.required))
      tx.work_items.put(project, {
        ...w,
        status: w.kind === "produce" ? "accepted" : "passed",
      });
  });
  expect((await read(`/cards/${card.id}`)).json).toMatchObject({
    mark_done: { allowed: true },
  });
  expect((await write(route, { result: "必需项完成" })).status).toBe(200);
  const cancelled = makeCard();
  h.store.uow.run((tx) =>
    tx.cards.put(project, { ...cancelled, status: "cancelled" } as Card),
  );
  expect(
    (await write(`/cards/${cancelled.id}/mark-done`, { result: "完成" }))
      .status,
  ).toBe(409);
});

test("role and template routes coexist: human role lifecycle changes reach template validation immediately", async () => {
  const change = {
    action: "add",
    definition: definition({
      work_items: [
        {
          key: "work",
          title: "产出",
          role_id: "coder",
          kind: "produce",
          required: true,
        },
      ],
    }),
  };
  expect((await read("/roles/coder")).status).toBe(200);
  expect((await write("/card-templates/validate", change, null)).json).toEqual({
    valid: true,
    reason: null,
  });
  expect((await write("/roles/coder/deactivate", {})).json).toMatchObject({
    role_id: "coder",
    status: "inactive",
  });
  expect((await write("/card-templates/validate", change, null)).json).toEqual({
    valid: false,
    reason: "角色 coder 未登记或已停用",
  });
  expect((await write("/card-templates", change)).status).toBe(400);
  expect((await write("/roles/coder/activate", {})).json).toMatchObject({
    role_id: "coder",
    status: "active",
  });
  expect((await write("/card-templates", change)).json).toMatchObject({
    id: "custom",
    version: 1,
  });
  expect((await read("/roles/coder/history")).status).toBe(200);
  expect((await read("/card-templates/custom/history")).json).toMatchObject({
    versions: [{ id: "custom", version: 1 }],
  });
});
