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
  expect(response.json).toEqual({ id: "E-1", name: "云长", role_id: "coder" });
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
  expect(employees()).toEqual([]);
  expect(createdEvents()).toEqual([]);
  expect(existsSync(join(h.dataDir, "avatars"))).toBe(false);
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
