import type { Actor, Role } from "@cardigan/domain";
import { applyRoleDocument, previewRoleDocument } from "@cardigan/host";
import type { LaunchConfig } from "@cardigan/roles";
import { getRoleVersion, roleDocument } from "@cardigan/store";
import { afterEach, beforeEach, expect, test } from "vitest";
import { call, webHarness } from "../../test-support/web.js";
import { MAX_JSON_BODY_BYTES } from "./http.js";

const markdown = `---
role_id: author
based_on: default:coder
launch_profile: fixture
template:
  id: writing
  from: general
  add_work_item: {key: draft, title: Draft, required: true, kind: produce}
employees:
  - {name: First, title: Writer, avatar: 'library:guan-yu'}
  - {name: Second, title: Editor}
---
Draft and revise.
`;
let h: Awaited<ReturnType<typeof webHarness>>, cookie: string;
const project = "doc-project";
const route = (path: string) => `/api/projects/${project}/${path}`;
let launchConfig: LaunchConfig;
beforeEach(async () => {
  launchConfig = {
    profiles: { fixture: { harness: "codex", model: "first-model" } },
    providers: {},
  };
  h = await webHarness({
    password: "fixture-pass",
    roleLaunchConfig: () => launchConfig,
  });
  h.store.createProject({ id: project });
  cookie = await h.login("fixture-pass");
});
afterEach(async () => await h.close());
function post(
  op: string,
  body: object,
  key?: string,
  headers: Record<string, string> = {},
) {
  return call(h.port, route(`role-document/${op}`), {
    method: "POST",
    cookie,
    body: JSON.stringify(body),
    headers: {
      origin: `http://${h.hostHeader}`,
      "content-type": "application/json",
      ...(key && { "idempotency-key": key }),
      ...headers,
    },
  });
}
async function preview(text = markdown) {
  const r = await post("preview", { markdown: text });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json as { snapshot: string; role: { role: Role } };
}
function rows() {
  return h.store.uow.read((tx) => ({
    role: getRoleVersion(tx, project, "author")?.version,
    templates: tx.card_templates
      .list(project)
      .filter((t) => t.id === "writing")
      .map((t) => t.version),
    staff: tx.employees.list().map((e) => e.id),
    events: tx.events.listAfter(project, undefined, 0).length,
    global: tx.global_events.listAfter(0).length,
  }));
}

test("preview has no side effects; one transaction writes the group, same-key retries and re-import do not duplicate versions/events", async () => {
  const before = rows();
  const p = await preview();
  expect(rows()).toEqual(before);
  expect(p).toMatchObject({
    role: {
      action: "create",
      role: { role_id: "author", version: 1, harness: "codex" },
      relaxations: expect.arrayContaining(["新增工具 submit_delivery"]),
    },
    template: {
      action: "create",
      after: { work_items: [{ role_id: "author" }] },
    },
    employees: [{ id: null }, { id: null }],
  });
  const body = { markdown, snapshot: p.snapshot };
  expect((await post("apply", body)).status).toBe(400);
  const first = await post("apply", body, "key");
  expect(first.status, JSON.stringify(first.json)).toBe(200);
  expect(rows()).toEqual({
    role: 1,
    templates: [1],
    staff: ["E-1", "E-2"],
    events: before.events + 2,
    global: before.global + 2,
  });
  const saved = rows();
  expect((await post("apply", body, "key")).json).toEqual(first.json);
  expect(
    (await post("apply", { ...body, markdown: `${markdown}!` }, "key")).status,
  ).toBe(409);
  expect((await post("apply", body, "other")).status).toBe(409);
  const again = await preview();
  expect(again).toMatchObject({
    role: { action: "unchanged" },
    template: { action: "unchanged" },
    employees: [{ action: "unchanged" }, { action: "unchanged" }],
  });
  expect(
    (await post("apply", { markdown, snapshot: again.snapshot }, "again"))
      .status,
  ).toBe(200);
  const exported = await call(h.port, route("roles/author/export"), { cookie });
  expect(exported.status).toBe(200);
  const text = (exported.json as { markdown: string }).markdown;
  const round = await preview(text);
  expect(
    (await post("apply", { markdown: text, snapshot: round.snapshot }, "round"))
      .status,
  ).toBe(200);
  expect(rows()).toEqual(saved);
});

test("a late sqlite failure rolls back all versions, IDs, events and replay key", async () => {
  const p = await preview();
  const before = rows();
  const body = { markdown, snapshot: p.snapshot };
  h.store.database.exec(
    "CREATE TRIGGER fail_employee BEFORE INSERT ON employees WHEN NEW.id='E-2' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END",
  );
  expect((await post("apply", body, "retry")).status).toBe(500);
  expect(rows()).toEqual(before);
  h.store.database.exec("DROP TRIGGER fail_employee");
  expect((await post("apply", body, "retry")).status).toBe(200);
  expect(rows().staff).toEqual(["E-1", "E-2"]);
});

test.each([
  ["invalid role id", "role_id: author", "role_id: A/B"],
  ["missing profile", "launch_profile: fixture", "launch_profile: typo"],
  ["unknown tool", "template:", "tools: {remove: [not_a_tool]}\ntemplate:"],
  ["capability", "template:", "required_capabilities: ['godot~4']\ntemplate:"],
  ["work-item role missing", "from: general", "from: dev"],
  ["employee profile", "name: Second", "launch_profile: typo, name: Second"],
  ["avatar", "library:guan-yu", "library:missing"],
  [
    "duplicated avatar",
    "name: Second",
    "avatar: 'library:guan-yu', name: Second",
  ],
  [
    "permission ceiling",
    "template:",
    "tools: {add: [record_decision]}\ntemplate:",
  ],
])("%s fails during preview before any writes", async (_label, from, to) => {
  const before = rows();
  expect(
    (await post("preview", { markdown: markdown.replace(from, to) })).status,
  ).toBe(400);
  expect(rows()).toEqual(before);
});

test("owner and actor are checked on preview, apply and cached replay", async () => {
  const p = await preview();
  const body = { markdown, snapshot: p.snapshot };
  expect((await post("apply", body, "first")).status).toBe(200);
  expect(
    (
      await post("preview", { markdown }, undefined, {
        authorization: "Bearer synthetic",
      })
    ).status,
  ).toBe(403);
  h.store.uow.run((tx) => {
    const member = tx.members.list()[0];
    if (!member) throw new Error("missing fixture owner");
    tx.members.put({ ...member, id: "M-2", status: "inactive" });
  });
  h.store.database.exec("UPDATE web_sessions SET member_id='M-2'");
  expect((await post("preview", { markdown })).status).toBe(403);
  expect((await post("apply", body, "first")).status).toBe(403);
  for (const actor of [
    { kind: "assignment", project_id: project },
    { kind: "human", project_id: "elsewhere" },
  ] as Actor[]) {
    const context = {
      store: h.store,
      project_id: project,
      actor,
      launchConfig: () => undefined,
      clock: { now: () => new Date().toISOString() },
      authorize: () => {},
    };
    expect(() => previewRoleDocument(context, markdown)).toThrow(
      /只有同项目的人/,
    );
    expect(() =>
      applyRoleDocument(context, markdown, p.snapshot, "first"),
    ).toThrow(/只有同项目的人/);
  }
});

test("copy reads the previewed base version; later base changes do not alter the saved role", async () => {
  const roleOnly = `${markdown.split("template:")[0]}---\nBody`;
  const base = (await preview(roleOnly)).role.role;
  const seed = (version: number) =>
    h.store.uow.run((tx) =>
      tx.roles.put(
        project,
        roleDocument({
          ...base,
          role_id: "base",
          version,
          abilities: [String(version)],
        }),
      ),
    );
  seed(1);
  const copy = roleOnly.replace("default:coder", "base");
  const p = await preview(copy);
  seed(2);
  expect(
    (await post("apply", { markdown: copy, snapshot: p.snapshot }, "stale"))
      .status,
  ).toBe(409);
  const fresh = await preview(copy);
  expect(
    (await post("apply", { markdown: copy, snapshot: fresh.snapshot }, "copy"))
      .status,
  ).toBe(200);
  seed(3);
  expect(await preview(copy)).toMatchObject({
    role: { action: "unchanged", role: { abilities: ["2"] } },
  });
});

test("replacing a template role previews the old and new work items; changing the referenced template invalidates its preview", async () => {
  const p = await preview();
  expect(
    (await post("apply", { markdown, snapshot: p.snapshot }, "seed")).status,
  ).toBe(200);
  const replacement = `---\nrole_id: editor\nbased_on: author\ntemplate: {id: editing, from: writing, replace_role: author}\n---\nEdit.\n`;
  const planned = await preview(replacement);
  expect(planned).toMatchObject({
    template: { after: { work_items: [{ key: "draft", role_id: "editor" }] } },
  });
  h.store.uow.run((tx) => {
    const t = tx.card_templates.list(project).find((t) => t.id === "writing");
    if (!t) throw new Error("missing template");
    tx.card_templates.put(project, { ...t, version: 2, title: "Revised" });
  });
  expect(
    (
      await post(
        "apply",
        { markdown: replacement, snapshot: planned.snapshot },
        "replace",
      )
    ).status,
  ).toBe(409);
  const fresh = await preview(replacement);
  expect(
    (
      await post(
        "apply",
        { markdown: replacement, snapshot: fresh.snapshot },
        "replace",
      )
    ).status,
  ).toBe(200);
  expect(await preview(replacement)).toMatchObject({
    role: { action: "unchanged" },
    template: { action: "unchanged", after: { version: 1 } },
  });
});

test("editing a role previews and commits the exact changes, including loosened tool, machine and worktree permissions", async () => {
  const base =
    "---\nrole_id: author\nlaunch_profile: fixture\nrequired_capabilities: [node]\nrequired_machine_tags: [special]\n---\nOriginal";
  const p = await preview(base);
  expect(
    (await post("apply", { markdown: base, snapshot: p.snapshot }, "base"))
      .status,
  ).toBe(200);
  const edit = base
    .replace("[node]", "[]")
    .replace("[special]", "[]\nworktree: write\ntools: {add: [get_card]}")
    .replace("Original", "Changed");
  const changed = await preview(edit);
  expect(changed).toMatchObject({
    role: {
      action: "update",
      role: { version: 2 },
      fields: expect.arrayContaining([
        { field: "instructions", before: "Original", after: "Changed" },
      ]),
      relaxations: expect.arrayContaining([
        "新增工具 get_card",
        "移除机器限制 node",
        "移除机器限制 special",
        "worktree 从 none 放宽为 write",
      ]),
    },
  });
  expect(
    (
      await post(
        "apply",
        { markdown: edit, snapshot: changed.snapshot },
        "edit",
      )
    ).status,
  ).toBe(200);
  expect(await preview(edit)).toMatchObject({
    role: {
      action: "unchanged",
      role: { version: 2 },
      fields: [],
      relaxations: [],
    },
  });
});

test("only changes to effective role and employee profiles invalidate the preview", async () => {
  const text = markdown.replace(
    "name: First",
    "launch_profile: staff, name: First",
  );
  launchConfig.profiles.staff = {
    harness: "codex",
    model: "staff-model",
    provider: "staff-route",
  };
  launchConfig.providers["staff-route"] = { env: {}, secret_env: {} };
  const before = rows();
  const original = await preview(text);
  launchConfig.profiles.fixture = { harness: "codex", model: "second-model" };
  const apply = (snapshot: string, key: string) =>
    post("apply", { markdown: text, snapshot }, key);
  expect((await apply(original.snapshot, "role-model")).status).toBe(409);
  const second = await preview(text);
  launchConfig.profiles.staff.args = ["--verbose"];
  expect((await apply(second.snapshot, "employee-args")).status).toBe(409);
  const third = await preview(text);
  launchConfig.providers["staff-route"].base_url = "https://fixture.example";
  expect((await apply(third.snapshot, "employee-provider")).status).toBe(409);
  expect(rows()).toEqual(before);
  const final = await preview(text);
  launchConfig.profiles.other = { harness: "pi", model: "unrelated-model" };
  expect((await preview(text)).snapshot).toBe(final.snapshot);
  expect((await apply(final.snapshot, "unrelated")).status).toBe(200);
});

test("preview and apply accept the same UTF-8 Markdown limit independently of JSON escaping and the snapshot envelope", async () => {
  const header = "---\nrole_id: author\nlaunch_profile: fixture\n---\n";
  const bytes = MAX_JSON_BODY_BYTES - Buffer.byteLength(header);
  const unit = "字\\\n"; // five bytes in UTF-8, seven in the JSON string
  const text =
    header +
    unit.repeat(Math.floor(bytes / Buffer.byteLength(unit))) +
    "x".repeat(bytes % Buffer.byteLength(unit));
  expect(Buffer.byteLength(text)).toBe(MAX_JSON_BODY_BYTES);
  const p = await preview(text);
  expect(
    (await post("apply", { markdown: text, snapshot: p.snapshot }, "max"))
      .status,
  ).toBe(200);
  const tooLarge = `${text}x`;
  expect((await post("preview", { markdown: tooLarge })).status).toBe(413);
  expect(
    (
      await post(
        "apply",
        { markdown: tooLarge, snapshot: p.snapshot },
        "excess",
      )
    ).status,
  ).toBe(413);
});

test("employee preview, applied and unchanged results agree with the normalized stored profile", async () => {
  const text = markdown.replace(
    "name: First, title: Writer",
    `name: '  First　', title: '  Writer ', bio: '  Example bio  '`,
  );
  const p = await preview(text);
  const result = await post(
    "apply",
    { markdown: text, snapshot: p.snapshot },
    "normalize",
  );
  expect(result.status).toBe(200);
  const saved = h.store.uow.read((tx) => tx.employees.list()[0]);
  if (!saved) throw new Error("missing employee");
  const { name, title, bio, avatar, role_id, launch_profile_ref } = saved;
  expect({ name, title, bio }).toEqual({
    name: "First",
    title: "Writer",
    bio: "Example bio",
  });
  const fields = { name, title, bio, avatar, role_id, launch_profile_ref };
  const staff = (id: string | null, action: string) => ({
    employees: expect.arrayContaining([
      expect.objectContaining({ ...fields, id, action }),
    ]),
  });
  expect(p).toMatchObject(staff(null, "create"));
  expect(result.json).toMatchObject(staff(saved.id, "create"));
  const again = await preview(text);
  expect(again).toMatchObject(staff(saved.id, "unchanged"));
  expect(
    (await post("apply", { markdown: text, snapshot: again.snapshot }, "same"))
      .json,
  ).toMatchObject(staff(saved.id, "unchanged"));
});
