import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import { MAX_AVATAR_BYTES } from "@cardigan/domain";
import { defaultRoleDefinition } from "@cardigan/roles";
import { roleDocument } from "@cardigan/store";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  assignment,
  run,
} from "../../../../packages/domain/src/commands/test-fixtures.js";
import { type CallOptions, call, webHarness } from "../../test-support/web.js";
import { serveEmployees } from "./employees.js";
import { HttpRejection } from "./http.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
const path = "/api/projects/p-test/employees";
const input = {
  name: "关羽",
  title: "开发工程师",
  role_id: "coder",
  avatar: "library:guan-yu",
};
let h: Awaited<ReturnType<typeof webHarness>>;
let cookie: string;
let sequence: number;
beforeEach(async () => {
  h = await webHarness({ password: "employee-test-password" });
  h.store.createProject({ id: "p-test" });
  h.store.uow.run((tx) =>
    tx.roles.put(
      "p-test",
      roleDocument({
        ...defaultRoleDefinition("coder", {
          harness: "codex",
          launch_profile_ref: "fixture",
        }),
        version: 1,
      }),
    ),
  );
  cookie = await h.login("employee-test-password");
  sequence = 0;
});
afterEach(async () => {
  await h.close();
});
function post(body: unknown = input, overrides: CallOptions = {}) {
  return call(h.port, path, {
    method: "POST",
    cookie,
    body: JSON.stringify(body),
    ...overrides,
    headers: {
      origin: `http://${h.hostHeader}`,
      "content-type": "application/json",
      "idempotency-key": `employee-${++sequence}`,
      ...overrides.headers,
    },
  });
}
const employees = () => h.store.uow.read((tx) => tx.employees.list());
const createdEvents = () =>
  h.store.uow.read((tx) =>
    tx.global_events.listAfter(0).filter((e) => e.type === "employee_created"),
  );

test("owner creates audited global employees; options include all characters and active project roles with inactive occupancy", async () => {
  const response = await post({ ...input, name: "云长", bio: "负责开发" });
  expect(response.status).toBe(200);
  expect(response.json).toEqual({
    id: "E-1",
    name: "云长",
    role_id: "coder",
    projects: ["p-test"],
  });
  expect(createdEvents()).toEqual([
    expect.objectContaining({
      actor: { kind: "human" },
      payload: {
        employee: expect.objectContaining({
          name: "云长",
          bio: "负责开发",
          avatar: input.avatar,
        }),
      },
    }),
  ]);
  h.store.uow.run((tx) => {
    const employee = tx.employees.list()[0];
    if (!employee) throw new Error("missing created employee");
    tx.employees.put({ ...employee, status: "inactive" });
    tx.roles.put(
      "p-test",
      roleDocument({
        ...defaultRoleDefinition("reviewer", {
          harness: "codex",
          launch_profile_ref: "fixture",
        }),
        version: 1,
      }),
    );
    tx.roles.put(
      "p-test",
      roleDocument({
        ...defaultRoleDefinition("reviewer", {
          harness: "codex",
          launch_profile_ref: "fixture",
        }),
        version: 2,
        status: "inactive",
      }),
    );
  });
  const options = await call(h.port, `${path}/options`, { cookie });
  expect(options.status).toBe(200);
  expect(options.json).toMatchObject({
    library: expect.any(Array),
    roles: [{ role_id: "coder", display_name: expect.any(String) }],
  });
  const library = (options.json as { library: unknown[] }).library;
  expect((options.json as { employees: unknown[] }).employees).toEqual([
    {
      id: "E-1",
      name: "云长",
      title: input.title,
      status: "inactive",
      avatar: "/avatars/v1/guan-yu/head-64.webp",
      role_id: "coder",
      projects: ["p-test"],
      role_change_blocked: null,
    },
  ]);
  expect(library).toHaveLength(60);
  expect(library).toContainEqual({
    id: "guan-yu",
    name: "关羽",
    source: "三国演义",
    avatar: "/avatars/v1/guan-yu/head-128.webp",
    occupied_by: { id: "E-1", name: "云长", status: "inactive" },
  });
  expect((await post({ ...input, name: "另一个名字" })).status).toBe(400);
  expect(
    (
      await post({
        ...input,
        avatar: "library:sun-wukong",
        role_id: "reviewer",
      })
    ).status,
  ).toBe(400);
  expect(
    (await post({ ...input, avatar: "library:sun-wukong", role_id: "unknown" }))
      .status,
  ).toBe(400);
  expect(employees()).toHaveLength(1);
  expect(createdEvents()).toHaveLength(1);
});

test("competing requests reserve the same character only once and replay does not duplicate audit or IDs", async () => {
  const results = await Promise.all([
    post(input, { headers: { "idempotency-key": "first" } }),
    post(
      { ...input, name: "第二位" },
      { headers: { "idempotency-key": "second" } },
    ),
  ]);
  expect(results.map((result) => result.status).sort()).toEqual([200, 400]);
  expect(employees()).toHaveLength(1);
  expect(createdEvents()).toHaveLength(1);
  const firstWon = results[0]?.status === 200;
  const body = firstWon ? input : { ...input, name: "第二位" };
  const key = firstWon ? "first" : "second";
  expect(
    (await post(body, { headers: { "idempotency-key": key } })).json,
  ).toEqual(results[firstWon ? 0 : 1]?.json);
  expect(
    (
      await post(
        { ...body, title: "changed" },
        { headers: { "idempotency-key": key } },
      )
    ).status,
  ).toBe(409);
  expect(createdEvents()).toHaveLength(1);
  expect(
    (await post({ name: "自定义", title: "开发", role_id: "coder" })).json,
  ).toMatchObject({ id: "E-2" });
});

test("custom bitmaps reuse CLI blob storage and authenticated reads serve only bitmap MIME with nosniff", async () => {
  const webp = await readFile(
    new URL(
      "../../../web/public/avatars/v1/guan-yu/head-64.webp",
      import.meta.url,
    ),
  );
  for (const [index, bytes, mime, extension] of [
    [0, png, "image/png", "png"],
    [1, webp, "image/webp", "webp"],
  ] as const) {
    const body = {
      name: `自定义 ${index}`,
      title: "开发",
      role_id: "coder",
      avatar_file: bytes.toString("base64"),
    };
    const response = await post(body, {
      headers: { "idempotency-key": `upload-${index}` },
    });
    expect(response.status).toBe(200);
    const digest = createHash("sha256").update(bytes).digest("hex");
    expect(employees()[index]?.avatar).toBe(`upload:${digest}`);
    expect(
      await readFile(join(h.dataDir, "avatars", `${digest}.${extension}`)),
    ).toEqual(bytes);
    const served = await call(h.port, `/api/avatars/${digest}`, { cookie });
    expect(served.headers).toMatchObject({
      "content-type": mime,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    });
    expect(
      (await post(body, { headers: { "idempotency-key": `upload-${index}` } }))
        .json,
    ).toEqual(response.json);
  }
  expect(await readdir(join(h.dataDir, "avatars"))).toHaveLength(2);
  expect(createdEvents()).toHaveLength(2);
});

test("invalid files, spoofed references, metadata and oversized bodies never create employees", async () => {
  const custom = { name: "自定义", title: "开发", role_id: "coder" };
  for (const bytes of [
    Buffer.from("<svg onload='alert(1)'></svg>"),
    Buffer.from("<html>image.png</html>"),
    Buffer.from("GIF89a"),
    png.subarray(0, 32),
    Buffer.alloc(0),
  ]) {
    expect(
      (await post({ ...custom, avatar_file: bytes.toString("base64") })).status,
    ).toBe(400);
  }
  for (const body of [
    { ...custom, avatar: "library:unknown" },
    { ...custom, avatar: `upload:${"a".repeat(64)}` },
    { ...input, avatar_file: png.toString("base64") },
    { ...custom, avatar_file: "not base64" },
    {
      ...custom,
      avatar_file: png.toString("base64"),
      filename: "../../escape.png",
      mime: "image/png",
    },
    { ...input, actor: { kind: "human" } },
  ])
    expect((await post(body)).status).toBe(400);
  expect(
    (
      await post({
        ...custom,
        avatar_file: Buffer.alloc(MAX_AVATAR_BYTES + 1).toString("base64"),
      })
    ).status,
  ).toBe(413);
  expect(
    (await post({ ...custom, avatar_file: "a".repeat(3 * 1024 * 1024) }))
      .status,
  ).toBe(413);
  const invalidKey = await post(input, { headers: { "idempotency-key": "" } });
  expect(invalidKey.status).toBe(400);
  expect(invalidKey.json).toEqual({
    error: {
      code: "validation_failed",
      message: "提交的内容不完整，请刷新页面后重试",
    },
  });
  expect(employees()).toEqual([]);
  expect(createdEvents()).toEqual([]);
  expect(existsSync(join(h.dataDir, "avatars"))).toBe(false);
});

test("valid images with invalid business fields are rejected before blob IO without allocating IDs or audit events", async () => {
  expect((await post(input)).status).toBe(200);
  h.store.uow.run((tx) =>
    tx.roles.put(
      "p-test",
      roleDocument({
        ...defaultRoleDefinition("reviewer", {
          harness: "codex",
          launch_profile_ref: "fixture",
        }),
        version: 1,
        status: "inactive",
      }),
    ),
  );
  const before = { employees: employees(), events: createdEvents() };
  const body = {
    name: "自定义",
    title: "开发",
    role_id: "coder",
    avatar_file: png.toString("base64"),
  };
  for (const patch of [
    { role_id: "unknown" },
    { role_id: "reviewer" },
    { name: input.name },
    { name: "　关羽　" },
    { name: " " },
    { title: " " },
    { name: "\t名字" },
    { bio: "一行\n两行" },
    { name: "名".repeat(41) },
    { title: "职".repeat(41) },
    { bio: "介".repeat(201) },
  ]) {
    expect((await post({ ...body, ...patch })).status).toBe(400);
    expect(existsSync(join(h.dataDir, "avatars"))).toBe(false);
    expect({ employees: employees(), events: createdEvents() }).toEqual(before);
  }
  expect((await post(body)).json).toMatchObject({ id: "E-2" });
  expect(await readdir(join(h.dataDir, "avatars"))).toHaveLength(1);
  expect(createdEvents()).toHaveLength(2);
});

test("HTTP text limits match domain Unicode boundaries without stripping control characters", async () => {
  const body = {
    name: `　${"𠮷".repeat(40)}　`,
    title: ` ${"😀".repeat(40)} `,
    bio: ` ${"𠮷".repeat(200)} `,
    role_id: "coder",
    avatar_file: png.toString("base64"),
  };
  for (const patch of [
    { name: "𠮷".repeat(41) },
    { title: "😀".repeat(41) },
    { bio: "𠮷".repeat(201) },
  ]) {
    const response = await post({ ...body, ...patch });
    expect(response.status).toBe(400);
    expect(response.json).toEqual({
      error: {
        code: "validation_failed",
        message: "提交的内容不完整，请刷新页面后重试",
      },
    });
    expect(existsSync(join(h.dataDir, "avatars"))).toBe(false);
  }
  const control = await post({ ...body, name: "\t合法长度" });
  expect(control.status).toBe(400);
  expect(control.json).toMatchObject({
    error: { message: expect.stringContaining("控制字符") },
  });
  expect((await post(body)).status).toBe(200);
  expect(employees()[0]).toMatchObject({
    id: "E-1",
    name: "𠮷".repeat(40),
    title: "😀".repeat(40),
    bio: "𠮷".repeat(200),
  });
});

test("Agent tokens, invalid owner membership, foreign origins and revoked sessions cannot create or replay", async () => {
  const token = h.store.issueToken({
    project_id: "p-test",
    assignment_id: "A-1",
    role: { role_version: 1, allowed_tools: ["whoami"] },
  }).token;
  expect(
    (
      await post(input, {
        cookie: "",
        headers: { authorization: `Bearer ${token}` },
      })
    ).status,
  ).toBe(401);
  expect(
    (await post(input, { headers: { authorization: `Bearer ${token}` } }))
      .status,
  ).toBe(403);
  expect(
    (await post(input, { headers: { origin: "http://evil.example" } })).status,
  ).toBe(403);
  expect(
    (await post(input, { headers: { host: "evil.example" } })).status,
  ).toBe(421);
  expect(employees()).toEqual([]);
  expect(
    (await post(input, { headers: { "idempotency-key": "replay-auth" } }))
      .status,
  ).toBe(200);
  h.store.uow.run((tx) => {
    const member = tx.members.list()[0];
    if (!member) throw new Error("missing owner");
    tx.members.put({ ...member, id: "M-2", status: "inactive" });
  });
  h.store.database.exec("UPDATE web_sessions SET member_id = 'M-2'");
  expect(
    (await post(input, { headers: { "idempotency-key": "replay-auth" } }))
      .status,
  ).toBe(403);
  h.store.setWebPassword("changed-employee-password");
  expect(
    (await post(input, { headers: { "idempotency-key": "replay-auth" } }))
      .status,
  ).toBe(401);
  expect(createdEvents()).toHaveLength(1);
});

test("session revocation while reading the body is checked before blob IO and writes", async () => {
  let valid = true;
  const req = Object.assign(
    Readable.from(
      (async function* () {
        valid = false;
        yield JSON.stringify({
          name: "上传",
          title: "开发",
          role_id: "coder",
          avatar_file: png.toString("base64"),
        });
      })(),
    ),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "revoked-body",
      },
    },
  ) as unknown as IncomingMessage;
  await expect(
    serveEmployees(
      {
        req,
        res: {} as ServerResponse,
        store: h.store,
        project_id: "p-test",
        dataDir: h.dataDir,
        clock: { now: () => new Date().toISOString() },
        authorize: () => {
          if (!valid)
            throw new HttpRejection(401, "unauthorized", "session revoked");
          return { member_id: "M-1" };
        },
      },
      "/employees",
    ),
  ).rejects.toMatchObject({ status: 401 });
  expect(existsSync(join(h.dataDir, "avatars"))).toBe(false);
  expect(employees()).toEqual([]);
});

test("profile overrides are validated on owner creation and update, and may be cleared", async () => {
  expect((await post({ ...input, launch_profile_ref: "missing" })).status).toBe(
    400,
  );
  expect(employees()).toHaveLength(0);
  expect((await post({ ...input, launch_profile_ref: "fixture" })).status).toBe(
    200,
  );
  const update = (profile: string | null, session = cookie) =>
    call(h.port, `${path}/E-1/update`, {
      method: "POST",
      cookie: session,
      body: JSON.stringify({ launch_profile_ref: profile }),
      headers: {
        origin: `http://${h.hostHeader}`,
        "content-type": "application/json",
        "idempotency-key": `change-${++sequence}`,
      },
    });
  expect((await update("missing")).status).toBe(400);
  expect((await update(null, "")).status).not.toBe(200);
  expect(employees()[0]?.launch_profile_ref).toBe("fixture");
  expect((await update(null)).status).toBe(200);
  expect(employees()[0]?.launch_profile_ref).toBeNull();
});

test("creation without an override rejects a role whose profile was removed", async () => {
  h.store.uow.run((tx) =>
    tx.roles.put(
      "p-test",
      roleDocument({
        ...defaultRoleDefinition("coder", {
          harness: "pi",
          launch_profile_ref: "removed",
        }),
        version: 2,
      }),
    ),
  );
  const response = await post(input);
  expect(response.status).toBe(400);
  expect(response.json).toMatchObject({
    error: { message: expect.stringContaining("removed") },
  });
  expect(employees()).toHaveLength(0);
});

test("owner can create and update project memberships without changing the launch profile", async () => {
  const projects = ["p-test", "other"];
  expect((await post({ ...input, projects })).json).toMatchObject({ projects });
  const update = (projects: unknown) =>
    call(h.port, `${path}/E-1/update`, {
      method: "POST",
      cookie,
      body: JSON.stringify({ projects }),
      headers: {
        origin: `http://${h.hostHeader}`,
        "content-type": "application/json",
        "idempotency-key": `membership-${++sequence}`,
      },
    });
  expect((await update([""])).status).toBe(400);
  expect(employees()[0]?.projects).toEqual(projects);
  expect((await update([])).json).toMatchObject({ projects: [] });
  expect(
    (await call(h.port, `${path}/options`, { cookie })).json,
  ).toMatchObject({ employees: [{ id: "E-1", projects: [] }] });
});

test("owner transfers across projects only after all bindings and runs end; replay does not duplicate the audit", async () => {
  expect((await post(input)).status).toBe(200);
  const employee = employees()[0];
  if (!employee) throw new Error("missing employee");
  const other = "other";
  h.store.createProject({ id: other });
  const owned = { ...assignment(), employee_id: employee.id };
  h.store.uow.run((tx) => {
    tx.roles.put(
      other,
      roleDocument({
        ...defaultRoleDefinition("reviewer", {
          harness: "codex",
          launch_profile_ref: "fixture",
        }),
        version: 1,
      }),
    );
    tx.assignments.put(other, owned);
  });
  const update = (
    body: unknown,
    key = `transfer-${++sequence}`,
    session = cookie,
  ) =>
    call(h.port, `${path}/${employee.id}/update`, {
      method: "POST",
      cookie: session,
      body: JSON.stringify(body),
      headers: {
        origin: `http://${h.hostHeader}`,
        "content-type": "application/json",
        "idempotency-key": key,
      },
    });
  const patch = { role_id: "reviewer" };
  const events = () =>
    h.store.uow.read((tx) =>
      tx.global_events
        .listAfter(0)
        .filter((e) => e.type === "employee_role_changed"),
    );
  // C-494: the options read names the same blocker the transfer would hit.
  const blocked = async () =>
    (
      (await call(h.port, `${path}/options`, { cookie })).json as {
        employees: { id: string; role_change_blocked: string | null }[];
      }
    ).employees.find((e) => e.id === employee.id)?.role_change_blocked;
  expect(await blocked()).toBe("assignment");
  expect((await update({})).status).toBe(400);
  expect((await update({ ...patch, changed_by_member_id: "M-1" })).status).toBe(
    400,
  );
  expect((await update(patch, "no-owner", "")).status).not.toBe(200);
  expect((await update(patch)).status).toBe(409);
  h.store.uow.run((tx) =>
    tx.assignments.put(other, { ...owned, status: "suspended" }),
  );
  expect((await update(patch)).status).toBe(409);
  h.store.uow.run((tx) => {
    tx.assignments.put(other, { ...owned, status: "released" });
    tx.runs.put(other, { ...run(1), status: "unknown" });
  });
  expect(await blocked()).toBe("run");
  expect((await update(patch)).status).toBe(409);
  expect(employees()).toEqual([employee]);
  expect(events()).toEqual([]);
  h.store.uow.run((tx) =>
    tx.runs.put(other, { ...run(1), status: "cancelled" }),
  );
  expect(await blocked()).toBeNull();
  for (let i = 0; i < 2; ++i) {
    const result = await update(patch, "idle-transfer");
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ id: employee.id, role_id: "reviewer" });
  }
  expect((await update({ ...patch, launch_profile_ref: null })).status).toBe(
    200,
  );
  expect(events()).toHaveLength(1);
  expect(events()[0]).toMatchObject({
    actor: { kind: "human" },
    payload: {
      changed_by_member_id: "M-1",
      from_role_id: "coder",
      to_role_id: "reviewer",
    },
  });
  expect(
    h.store.uow.read((tx) => tx.assignments.get(other, owned.id)),
  ).toMatchObject({ employee_id: employee.id, role_id: "coder" });
});

test("clearing an override on transfer cannot inherit a disabled project's profile", async () => {
  expect((await post({ ...input, launch_profile_ref: "fixture" })).status).toBe(
    200,
  );
  h.store.createProject({ id: "other" });
  h.store.uow.run((tx) => {
    const reviewer = defaultRoleDefinition("reviewer", {
      harness: "codex",
      launch_profile_ref: "fixture",
    });
    tx.roles.put(
      "p-test",
      roleDocument({ ...reviewer, version: 1, status: "inactive" }),
    );
    tx.roles.put(
      "other",
      roleDocument({
        ...reviewer,
        version: 1,
        status: "active",
        launch_profile_ref: "removed",
      }),
    );
  });
  const audit = () => h.store.uow.read((tx) => tx.global_events.listAfter(0));
  const before = { employees: employees(), audit: audit() };
  const response = await call(h.port, `${path}/E-1/update`, {
    method: "POST",
    cookie,
    body: JSON.stringify({ role_id: "reviewer", launch_profile_ref: null }),
    headers: {
      origin: `http://${h.hostHeader}`,
      "content-type": "application/json",
      "idempotency-key": "clear-on-transfer",
    },
  });
  expect(response.status).toBe(400);
  expect(response.json).toMatchObject({ error: { code: "validation_failed" } });
  expect({ employees: employees(), audit: audit() }).toEqual(before);
});
