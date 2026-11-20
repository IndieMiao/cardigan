import { execFileSync, fork } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEmployee } from "@cardigan/domain";
import { isAcceptedLaunchRevision } from "@cardigan/host";
import { defaultRoleDefinition, resolveProfile } from "@cardigan/roles";
import { persistEmployeeEffect, roleDocument } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { call, webHarness } from "../../test-support/web.js";
import { loadLaunchFiles } from "../host.js";
import { liveLaunch, selectableLaunchConfig } from "../live-launch.js";

const secret = "fixture-value-private",
  config = `# keep my comment
providers:
  gateway:
    api: anthropic-messages
    name: Fixture
    base_url: https://gateway.example.invalid
    env: { PRIVATE_ENV: hidden-inline-value }
    secret_env: { ANTHROPIC_API_KEY: KEY }
models:
  primary: { provider: gateway, id: first, context_window: 32000, cost: { input: 1, output: 2 } }
profiles:
  a: { harness: claude-code, model: primary, effort: high, args: [hidden-argument] }
  b: { harness: pi, model: standalone }
  no-model: { harness: pi }
`;
let live: Awaited<
  ReturnType<typeof liveLaunch<Awaited<ReturnType<typeof loadLaunchFiles>>>>
>;
let dir: string,
  h: Awaited<ReturnType<typeof webHarness>>,
  cookie: string,
  file: string,
  version: string;
const get = (rest = "") =>
  call(h.port, `/api/launch-settings${rest}`, { cookie });
const post = (rest: string, body: unknown, key = "one", session = cookie) =>
  call(h.port, `/api/launch-settings/${rest}`, {
    method: "POST",
    cookie: session,
    headers: {
      origin: `http://${h.hostHeader}`,
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: JSON.stringify(body),
  });
const writeProject = (route: string, body: unknown, key: string) =>
  call(h.port, `/api/projects/p/${route}`, {
    method: "POST",
    cookie,
    headers: {
      origin: `http://${h.hostHeader}`,
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: JSON.stringify(body),
  });
const preview = (change: unknown) => post("preview", { version, change });
async function confirmation(change: unknown) {
  const response = await preview(change);
  expect(response.status, response.body).toBe(200);
  return { version, preview_id: JSON.parse(response.body).preview_id };
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "launch-settings-"));
  file = join(dir, "launch.yaml");
  writeFileSync(file, config, { mode: 0o600 });
  writeFileSync(
    join(dir, "secrets.env"),
    `KEY=${secret}\nOTHER=other-private-value`,
    { mode: 0o600 },
  );
  writeFileSync(
    join(dir, "claude"),
    '#!/bin/sh\nprintf "fixture 1.2.3 hidden-version-banner"\n',
    { mode: 0o700 },
  );
  vi.stubEnv("PATH", dir);
  h = await webHarness({
    password: "launch-password",
    diskStore: true,
    launchSettings: {
      dir,
      effective: () =>
        isAcceptedLaunchRevision(h.store, dir, live.current().revision)
          ? selectableLaunchConfig(live.current())
          : { ...live.current().config, profiles: {} },
      adopt: (generation) => live.adopt(generation),
    },
  });
  // Purely local fixtures; no catalog fetch unless a test explicitly supplies a fake upstream.
  writeFileSync(
    join(h.dataDir, "models-dev.json"),
    JSON.stringify({ fetched_at: new Date().toISOString(), entries: [] }),
  );
  live = await liveLaunch(
    dir,
    () => loadLaunchFiles(dir, () => {}, h.dataDir, h.store),
    () => {},
  );
  cookie = await h.login("launch-password");
  const read = await get();
  expect(read.status, read.body).toBe(200);
  version = JSON.parse(read.body).version;
});
afterEach(async () => {
  await h?.close();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(dir, { force: true, recursive: true });
});
test("only cookie-authenticated humans may read/write; views are offline, allowlisted, and missing keys are not values", async () => {
  const network = vi.fn();
  vi.stubGlobal("fetch", network);
  for (const rest of ["", "/profiles", "/checks", "/confirm"])
    expect(
      (
        await call(h.port, `/api/launch-settings${rest}`, {
          headers: { authorization: "Bearer fixture" },
        })
      ).status,
    ).toBe(401);
  expect(
    (
      await call(h.port, "/api/launch-settings", {
        cookie,
        headers: { authorization: "Bearer fixture" },
      })
    ).status,
  ).toBe(403);
  expect((await get("/profiles")).json).toEqual({ profiles: ["a", "b"] });
  const read = await get();
  expect(read.body).not.toMatch(
    /fixture-value-private|other-private-value|hidden-argument|PRIVATE_ENV|hidden-inline/,
  );
  expect(JSON.parse(read.body).profiles[0]).toMatchObject({
    model_alias: "primary",
    model_id: "first",
    metadata: { context_window: 32000, cost: { input: 1, output: 2 } },
    parameters: { effort: "high" },
    secrets: [{ key: "KEY", set: true }],
    cli: { path: join(dir, "claude"), version: "1.2.3" },
  });
  writeFileSync(join(dir, "secrets.env"), "");
  expect(JSON.parse((await get()).body).profiles[0].secrets).toEqual([
    { key: "KEY", set: false },
  ]);
  await live.refresh(); // missing secret rejects the entire disk generation
  expect((await get("/profiles")).json).toEqual({ profiles: ["a", "b"] });
  chmodSync(join(dir, "secrets.env"), 0o644);
  expect((await get()).status).toBe(400);
  expect((await get("/profiles")).json).toEqual({ profiles: ["a", "b"] });
  expect(network).not.toHaveBeenCalled();
});
test("a preview binds exact YAML, secret generation and human session; install once, keep comments and reload", async () => {
  const data = await confirmation({
    op: "set_model",
    name: "primary",
    id: "second",
  });
  expect(readFileSync(file, "utf8")).toBe(config);
  expect(
    (await post("confirm", data, "one", await h.login("launch-password")))
      .status,
  ).toBe(409);
  expect((await post("confirm", data)).status).toBe(200);
  expect((await post("confirm", data)).status).toBe(200);
  expect(
    (await post("confirm", { ...data, version: "0".repeat(64) })).status,
  ).toBe(409);
  expect((await live.refresh()).config.profiles.a?.model).toBe("second");
  expect(readFileSync(file, "utf8")).toContain("# keep my comment");
  const backups = readdirSync(dir).filter((n) => n.endsWith(".bak"));
  expect(backups).toHaveLength(1);
  const backup = join(dir, backups[0] ?? "");
  expect(readFileSync(backup, "utf8")).toBe(config);
  expect(statSync(backup).mode & 0o777).toBe(0o600);
  expect(
    h.store.database
      .prepare("SELECT action,target,installed FROM launch_web_changes")
      .all(),
  ).toEqual([{ action: "set_model", target: "primary", installed: 1 }]);
  expect(
    (await preview({ op: "copy_profile", name: "c", source: "a" })).status,
  ).toBe(409);
});
test("unpreviewed, invalid or stale writes never install; secrets can only be selected by existing key", async () => {
  const fake = { version, preview_id: "71f8db4b-e973-4bf8-9f87-cbb0915e83da" };
  expect((await post("confirm", fake)).status).toBe(409);
  for (const change of [
    {
      op: "edit_provider",
      name: "gateway",
      fields: { secret_env: { ANTHROPIC_API_KEY: "UNKNOWN" } },
    },
    { op: "edit_provider", name: "gateway", fields: { env: { KEY: secret } } },
    {
      op: "edit_provider",
      name: "gateway",
      fields: { base_url: "https://user:password@example.invalid" },
    },
    { op: "edit_profile", name: "a", fields: { provider: "absent" } },
    { op: "create_profile", name: "a", fields: { harness: "pi" } },
    { op: "set_model", name: "primary", id: "   " },
  ]) {
    const rejected = await preview(change);
    expect(rejected.status).toBe(400);
    expect(rejected.body).not.toContain(secret);
  }
  const data = await confirmation({
    op: "edit_provider",
    name: "gateway",
    fields: {
      name: "Next",
      base_url: "https://next.example.invalid",
      secret_env: { ANTHROPIC_API_KEY: "OTHER" },
    },
  });
  writeFileSync(join(dir, "secrets.env"), "KEY=changed\nOTHER=new");
  expect((await post("confirm", data)).status).toBe(409);
  expect(readFileSync(file, "utf8")).toBe(config);
});
test("confirm rechecks global references including historical role versions added since preview", async () => {
  const data = await confirmation({ op: "delete_profile", name: "a" });
  h.store.createProject({ id: "other" });
  h.store.uow.run((tx) => {
    const created = createEmployee(
      [],
      { kind: "human" },
      {
        name: "Fixture",
        title: "Dev",
        role_id: "coder",
        launch_profile_ref: "a",
      },
      {
        clock: { now: () => new Date().toISOString() },
        ids: tx.global_ids,
        launch_profiles: ["a"],
      },
    );
    if (!created.ok) throw Error(created.error.message);
    persistEmployeeEffect(tx, created.value);
    for (const [version, ref] of [
      [1, "a"],
      [2, "b"],
    ] as const)
      tx.roles.put(
        "other",
        roleDocument({
          ...defaultRoleDefinition("coder", {
            harness: "claude-code",
            launch_profile_ref: ref,
          }),
          version,
        }),
      );
  });
  const res = await post("confirm", data);
  expect(res.json).toMatchObject({
    error: {
      code: "profile_in_use",
      details: {
        references: [
          { project_id: "other", role_id: "coder", version: 1 },
          { employee_id: "E-1", name: "Fixture" },
        ],
      },
    },
  });
  expect((await preview({ op: "delete_profile", name: "a" })).status).toBe(409);
  expect(readFileSync(file, "utf8")).toBe(config);
});
test("metadata and online jobs run on demand, mutually exclude one profile, and audit only sanitized results", async () => {
  let resolve!: (response: Response) => void;
  const fetch = vi.fn(
    () =>
      new Promise<Response>((r) => {
        resolve = r;
      }),
  );
  vi.stubGlobal("fetch", fetch);
  const check = (mode: string) =>
    post("checks", { profile: "a", mode, version });
  expect((await check("metadata")).status).toBe(202);
  async function last() {
    return JSON.parse((await get()).body).profiles[0].last_check;
  }
  await vi.waitFor(async () =>
    expect(await last()).toMatchObject({
      mode: "metadata",
      status: "failed",
      cli_version: "1.2.3",
      problems: ["missing_max_output_tokens", "missing_reasoning_efforts"],
    }),
  );
  expect(fetch).not.toHaveBeenCalled();
  expect((await check("online")).status).toBe(202);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  expect((await check("metadata")).status).toBe(409);
  resolve(Response.json({ data: [{ id: "first", private: secret }] }));
  await vi.waitFor(async () =>
    expect(await last()).toMatchObject({ status: "passed", version }),
  );
  expect(fetch).toHaveBeenCalledWith(
    "https://gateway.example.invalid/v1/models",
    expect.objectContaining({ method: "GET", redirect: "error" }),
  );
  expect(
    JSON.stringify(
      h.store.database.prepare("SELECT * FROM launch_profile_checks").all(),
    ),
  ).not.toMatch(/hidden-version-banner|fixture-value-private/);
});

test("creation, copy, edit, provider remap and unreferenced delete keep both views in sync", async () => {
  let sequence = 0;
  async function install(change: unknown) {
    const confirm = await confirmation(change);
    const ok = await post("confirm", confirm, `action-${++sequence}`);
    expect(ok.status, ok.body).toBe(200);
    const view = JSON.parse((await get()).body);
    version = view.version;
    return view;
  }
  await install({
    op: "create_profile",
    name: "created",
    fields: { harness: "claude-code", model: "primary" },
  });
  await install({ op: "copy_profile", name: "copy", source: "a" });
  const edited = await install({
    op: "edit_profile",
    name: "copy",
    fields: { effort: "low", permission_mode: "acceptEdits" },
  });
  expect(
    edited.profiles.find((p: { name: string }) => p.name === "copy"),
  ).toMatchObject({
    parameters: {
      effort: "low",
      permission_mode: "acceptEdits",
      custom_args_count: 1,
    },
  });
  const remapped = await install({
    op: "edit_provider",
    name: "gateway",
    fields: {
      name: "New display",
      base_url: "https://updated.example.invalid",
      secret_env: { ANTHROPIC_API_KEY: "OTHER" },
    },
  });
  expect(remapped.providers[0]).toMatchObject({
    id: "gateway",
    name: "New display",
    base_url: "https://updated.example.invalid",
  });
  expect(remapped.profiles[0].secrets).toEqual([{ key: "OTHER", set: true }]);
  await install({ op: "delete_profile", name: "created" });
  expect((await get("/profiles")).json).toEqual({
    profiles: ["a", "b", "copy"],
  });
});

test("a lost commit after rename is recovered by the same confirmation without a second install", async () => {
  const data = await confirmation({
    op: "set_model",
    name: "primary",
    id: "second",
  });
  h.store.database.exec(
    `CREATE TRIGGER fail_receipt BEFORE UPDATE ON launch_web_changes BEGIN SELECT RAISE(ABORT,'receipt failure'); END;`,
  );
  expect((await post("confirm", data)).status).not.toBe(200);
  expect(readFileSync(file, "utf8")).toContain("second");
  h.store.database.exec("DROP TRIGGER fail_receipt");
  expect((await post("confirm", data)).status).toBe(200);
  expect(readdirSync(dir).filter((f) => f.endsWith(".bak"))).toHaveLength(1);
  expect(
    h.store.database.prepare("SELECT installed FROM launch_web_changes").all(),
  ).toEqual([{ installed: 1 }]);
});

test("only the installed, explicitly selected endpoint may receive a credential; errors do not echo the upstream", async () => {
  const network = vi.fn(async () => new Response(secret, { status: 403 }));
  vi.stubGlobal("fetch", network);
  const data = await confirmation({
    op: "edit_provider",
    name: "gateway",
    fields: { base_url: "https://new.example.invalid" },
  });
  expect(network).not.toHaveBeenCalled();
  const check = () => post("checks", { profile: "a", mode: "online", version });
  expect((await check()).status).toBe(202);
  await vi.waitFor(async () =>
    expect(JSON.parse((await get()).body).profiles[0].last_check.status).toBe(
      "failed",
    ),
  );
  expect(network).toHaveBeenCalledOnce();
  expect(network.mock.calls[0]).toMatchObject([
    "https://gateway.example.invalid/v1/models",
    { headers: { "x-api-key": secret }, redirect: "error" },
  ]);
  expect((await post("confirm", data)).status).toBe(200);
  expect((await check()).status).toBe(409);
  expect(network).toHaveBeenCalledTimes(1);
  const next = await get();
  expect(next.body).not.toContain(secret);
  version = JSON.parse(next.body).version;
  expect((await check()).status).toBe(202);
  await vi.waitFor(() => expect(network).toHaveBeenCalledTimes(2));
  expect(network.mock.calls[1]).toMatchObject([
    "https://new.example.invalid/v1/models",
    { headers: { "x-api-key": secret }, redirect: "error" },
  ]);
  const audit = h.store.database
    .prepare("SELECT result FROM launch_profile_checks")
    .all();
  expect(JSON.stringify(audit)).not.toContain(secret);
});

test("confirm revalidates stale catalog entries with the real reload loader before any installation", async () => {
  h.store.createProject({ id: "catalog" });
  const cache = join(h.dataDir, "models-dev.json");
  const entries = ["first", "removed"].map((id) => ({
    provider: "gateway",
    id,
    context_window: 32000,
  }));
  writeFileSync(
    cache,
    JSON.stringify({ fetched_at: new Date(0).toISOString(), entries }),
  );
  const original = config.replace("context_window: 32000, ", "");
  writeFileSync(file, original);
  const catalog = vi.fn(async () =>
    Response.json({
      gateway: { models: { first: { limit: { context: 32000 } } } },
    }),
  );
  vi.stubGlobal("fetch", catalog);
  version = JSON.parse((await get()).body).version;
  const data = await confirmation({
    op: "set_model",
    name: "primary",
    id: "removed",
  });
  expect(catalog).not.toHaveBeenCalled();
  expect((await post("confirm", data)).json).toMatchObject({
    error: { code: "validation_failed" },
  });
  expect(catalog).toHaveBeenCalledOnce();
  expect(readFileSync(file, "utf8")).toBe(original);
  expect(readdirSync(dir).filter((n) => /\.(tmp|bak)$/u.test(n))).toEqual([]);
  expect(
    h.store.database.prepare("SELECT * FROM launch_web_changes").all(),
  ).toEqual([]);
  expect(
    h.store.database.prepare("SELECT * FROM launch_model_intents").all(),
  ).toEqual([]);
  expect(
    h.store.uow.read((tx) =>
      tx.events
        .listAfter("catalog", undefined, 0)
        .filter((e) => e.type === "launch_model_changed"),
    ),
  ).toEqual([]);
  expect((await live.refresh()).config.profiles.a?.model).toBe("first");
});

function projectWithRoleUsingA() {
  h.store.createProject({ id: "p" });
  h.store.uow.run((tx) =>
    tx.roles.put(
      "p",
      roleDocument({
        ...defaultRoleDefinition("coder", {
          harness: "claude-code",
          launch_profile_ref: "a",
        }),
        version: 1,
      }),
    ),
  );
}

test("employees and roles validate the accepted generation, excluding model-less profiles", async () => {
  projectWithRoleUsingA();
  writeFileSync(file, config.replace("  b: ", "  new: "));
  writeFileSync(join(dir, "secrets.env"), "");
  await live.refresh();
  expect(
    JSON.parse((await get()).body).profiles.map(
      (p: { name: string }) => p.name,
    ),
  ).toEqual(["a", "new", "no-model"]);
  expect((await get("/profiles")).json).toEqual({ profiles: ["a", "b"] });
  for (const [name, status] of [
    ["new", 400],
    ["no-model", 400],
    ["b", 200],
  ] as const) {
    const employee = await writeProject(
      "employees",
      {
        name: "Writer",
        title: "Dev",
        avatar: "library:guan-yu",
        role_id: "coder",
        launch_profile_ref: name,
      },
      `employee-${name}`,
    );
    expect(employee.status, employee.body).toBe(status);
    const role = await writeProject(
      "role-document/preview",
      {
        markdown: `---\nrole_id: author\nbased_on: default:coder\nlaunch_profile: ${name}\n---\nDraft.`,
      },
      `role-${name}`,
    );
    expect(role.status, role.body).toBe(status);
  }
});

test("a shared Claude endpoint is shown and updated through the same adapter as the running profile", async () => {
  const legacy = config
    .replace("    base_url: https://gateway.example.invalid\n", "")
    .replace(
      "PRIVATE_ENV: hidden-inline-value",
      "ANTHROPIC_BASE_URL: https://legacy.example.invalid",
    );
  writeFileSync(file, legacy);
  const read = JSON.parse((await get()).body);
  expect(read.providers[0].base_url).toBe("https://legacy.example.invalid");
  version = read.version;
  const url = "https://next.example.invalid";
  const change = {
    op: "edit_provider",
    name: "gateway",
    fields: { base_url: url },
  };
  const data = await confirmation(change);
  expect(readFileSync(file, "utf8")).toBe(legacy);
  expect((await post("confirm", data)).status).toBe(200);
  const resolved = resolveProfile((await live.refresh()).config, "a").provider
    ?.definition;
  expect(resolved).toMatchObject({
    base_url: url,
    env: { ANTHROPIC_BASE_URL: url },
  });
  expect(JSON.parse((await get()).body).providers[0].base_url).toBe(url);
  writeFileSync(
    file,
    legacy.replace(
      "legacy.example.invalid",
      "fixture:password@legacy.example.invalid",
    ),
  );
  const unsafe = await get();
  expect(unsafe.body).not.toContain("password");
  version = JSON.parse(unsafe.body).version;
  expect(JSON.parse(unsafe.body).providers[0].base_url).toBeNull();
  expect((await preview(change)).status).toBe(400);
});

test("secret values can collide with protocol keys, statuses and snapshot characters without breaking round trips", async () => {
  writeFileSync(
    join(dir, "secrets.env"),
    `KEY=${secret}\nOTHER=version\nTINY=0\nSTATE=running\n`,
  );
  writeFileSync(file, config.replace("name: Fixture", `name: '${secret}'`));
  const read = await get();
  version = JSON.parse(read.body).version;
  expect(version).toMatch(/^[0-9a-f]{64}$/u);
  expect(JSON.parse(read.body).providers[0].name).toBe("***");
  const task = await post("checks", {
    profile: "a",
    mode: "metadata",
    version,
  });
  expect(task.json).toMatchObject({ status: "running", version });
  await vi.waitFor(async () =>
    expect(JSON.parse((await get()).body).profiles[0].last_check).toMatchObject(
      { id: JSON.parse(task.body).id, version, status: "failed" },
    ),
  );
  const data = await confirmation({
    op: "set_model",
    name: "primary",
    id: "second",
  });
  expect((await post("confirm", data)).json).toEqual({
    ok: true,
    preview_id: data.preview_id,
  });
  expect((await live.refresh()).config.profiles.a?.model).toBe("second");
  expect((await get()).body).not.toContain(secret);
});

test("delete installs the accepted generation before any employee or role can save another reference", async () => {
  projectWithRoleUsingA();
  const markdown = `---\nrole_id: author\nbased_on: default:coder\nlaunch_profile: b\n---\nDraft.`;
  const rolePreview = await writeProject(
    "role-document/preview",
    { markdown },
    "preview-role",
  );
  expect(rolePreview.status).toBe(200);
  const deletion = await confirmation({ op: "delete_profile", name: "b" });
  expect((await post("confirm", deletion)).status).toBe(200);
  // No live.refresh() or timer between the success response and these writes.
  expect(live.current().config.profiles.b).toBeUndefined();
  expect((await get("/profiles")).json).toEqual({ profiles: ["a"] });
  const employee = await writeProject(
    "employees",
    {
      name: "Writer",
      title: "Dev",
      avatar: "library:guan-yu",
      role_id: "coder",
      launch_profile_ref: "b",
    },
    "late-employee",
  );
  expect(employee.status).toBe(400);
  const oldRole = await writeProject(
    "role-document/apply",
    { markdown, snapshot: JSON.parse(rolePreview.body).snapshot },
    "stale-role",
  );
  expect([400, 409]).toContain(oldRole.status);
  expect(
    (await writeProject("role-document/preview", { markdown }, "late-role"))
      .status,
  ).toBe(400);
  expect(h.store.uow.read((tx) => tx.employees.list())).toEqual([]);
  expect((await live.refresh()).config.profiles.b).toBeUndefined();
});

test("a stale confirm discards the fetched catalog without invalidating the active YAML or its preview", async () => {
  const cache = join(h.dataDir, "models-dev.json");
  const entries = ["first", "new"].map((id) => ({
    provider: "gateway",
    id,
    context_window: 32000,
  }));
  const previous = JSON.stringify({
    fetched_at: new Date(0).toISOString(),
    entries,
  });
  writeFileSync(cache, previous);
  const original = config.replace("context_window: 32000, ", "");
  writeFileSync(file, original);
  version = JSON.parse((await get()).body).version;
  const change = { op: "set_model", name: "primary", id: "new" };
  const data = await confirmation(change);
  const delayed = Promise.withResolvers<Response>();
  const fetch = vi.fn(() => delayed.promise);
  vi.stubGlobal("fetch", fetch);
  const attempt = post("confirm", data);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  writeFileSync(join(dir, "secrets.env"), `KEY=${secret}\nOTHER=changed`);
  delayed.resolve(
    Response.json({
      gateway: { models: { new: { limit: { context: 64000 } } } },
    }),
  );
  expect((await attempt).json).toMatchObject({
    error: { code: "stale_snapshot" },
  });
  expect(readFileSync(file, "utf8")).toBe(original);
  expect(readFileSync(cache, "utf8")).toBe(previous);
  expect(
    readdirSync(h.dataDir).filter((n) => n.startsWith(".models-dev.json.")),
  ).toEqual([]);
  const read = await get();
  expect(read.status).toBe(200);
  expect(JSON.parse(read.body).profiles[0].model_id).toBe("first");
  version = JSON.parse(read.body).version;
  const retry = await confirmation(change);
  // An older poll may still be fetching the previous generation when the retry commits.
  const oldCatalog = Promise.withResolvers<Response>();
  fetch.mockImplementationOnce(() => oldCatalog.promise);
  const polling = live.refresh();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  fetch.mockImplementationOnce(async () =>
    Response.json({
      gateway: { models: { new: { limit: { context: 64000 } } } },
    }),
  );
  expect((await post("confirm", retry)).status).toBe(200);
  oldCatalog.resolve(
    Response.json({
      gateway: { models: { first: { limit: { context: 32000 } } } },
    }),
  );
  expect((await polling).config.profiles.a?.model).toBe("new");
  expect(live.current().config.profiles.a?.model).toBe("new");
  expect(JSON.parse(readFileSync(cache, "utf8")).entries).toEqual([
    { provider: "gateway", id: "new", context_window: 64000 },
  ]);
  expect(
    JSON.parse((await get()).body).profiles[0].metadata.context_window,
  ).toBe(64000);
});

test("a masked probe destination is rejected before any network request; offline checks remain available", async () => {
  const network = vi.fn();
  vi.stubGlobal("fetch", network);
  writeFileSync(join(dir, "secrets.env"), `KEY=${secret}\nMASK=example`);
  const details = JSON.parse((await get()).body);
  expect(details.providers[0].base_url).toBe("***");
  const request = { profile: "a", version: details.version };
  const rejected = await post("checks", { ...request, mode: "online" });
  expect(rejected.status).toBe(400);
  expect(rejected.body).not.toContain(secret);
  expect(
    h.store.database.prepare("SELECT id FROM launch_profile_checks").all(),
  ).toEqual([]);
  expect((await post("checks", { ...request, mode: "metadata" })).status).toBe(
    202,
  );
  await vi.waitFor(async () =>
    expect(
      JSON.parse((await get()).body).profiles[0].last_check.finished_at,
    ).toBeTruthy(),
  );
  expect(network).not.toHaveBeenCalled();
});

test("a settled confirmation replays after unrelated invalid edits but never for a different request or session", async () => {
  const data = await confirmation({
    op: "set_model",
    name: "primary",
    id: "second",
  });
  const first = await post("confirm", data);
  expect(first.status).toBe(200);
  writeFileSync(file, "profiles: [");
  const replay = await post("confirm", data);
  expect(replay.status).toBe(200);
  expect(replay.json).toEqual(first.json);
  expect(
    (await post("confirm", { ...data, version: "0".repeat(64) })).status,
  ).toBe(409);
  expect(
    (await post("confirm", data, "one", await h.login("launch-password")))
      .status,
  ).not.toBe(200);
  expect(readFileSync(file, "utf8")).toBe("profiles: [");
  expect(readdirSync(dir).filter((n) => n.endsWith(".bak"))).toHaveLength(1);
});

// No sleeps: the IPC gate is before the old download returns, or *inside* the
// old publisher's final rename. The latter cannot be tested by an in-process mutex.
function racingProcess(mode: string) {
  const child = fork(
    fileURLToPath(
      new URL("../../test-support/launch-settings-race.mjs", import.meta.url),
    ),
    [dir, h.dataDir, mode],
    {
      execArgv: [],
      env: { HOME: dir, PATH: dir },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  const exited = once(child, "exit").then(([code]) => code as number);
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  const ready = () =>
    Promise.race([
      once(child, "message", { signal: AbortSignal.timeout(10000) }).then(
        ([msg]) => msg,
      ),
      exited.then(() => {
        throw Error(`fixture exited before barrier: ${stderr}`);
      }),
    ]);
  return { child, ready, exited };
}
async function prepareCatalogRace() {
  writeFileSync(file, config.replace("context_window: 32000, ", ""));
  writeFileSync(
    join(h.dataDir, "models-dev.json"),
    JSON.stringify({
      fetched_at: new Date(0).toISOString(),
      entries: ["first", "new", "cli"].map((id) => ({
        id,
        provider: "gateway",
        context_window: 64000,
      })),
    }),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        gateway: { models: { new: { limit: { context: 64000 } } } },
      }),
    ),
  );
  version = JSON.parse((await get()).body).version;
  return confirmation({ op: "set_model", name: "primary", id: "new" });
}
function expectPaired(id: string) {
  expect(readFileSync(file, "utf8")).toContain(`id: ${id}`);
  expect(
    JSON.parse(
      readFileSync(join(h.dataDir, "models-dev.json"), "utf8"),
    ).entries.map((entry: { id: string }) => entry.id),
  ).toEqual([id]);
}
test.each(["poll", "reload", "set-model", "read"])(
  "a late %s in another process cannot replace the confirmed catalog",
  async (mode) => {
    const data = await prepareCatalogRace();
    const { child, ready, exited } = racingProcess(mode);
    try {
      expect(await ready()).toBe("fetching");
      expect((await post("confirm", data)).status).toBe(200);
      child.send("resume");
      expect(await exited).toBe(mode === "read" ? 0 : 42);
      expectPaired("new");
      expect(JSON.parse((await get()).body).profiles[0].model_id).toBe("new");
      expect(JSON.parse((await get("/profiles")).body).profiles).toContain("a");
      expect((await post("confirm", data)).status).toBe(200);
      expect(
        h.store.database
          .prepare("SELECT installed FROM launch_web_changes")
          .all(),
      ).toEqual([{ installed: 1 }]);
    } finally {
      child.kill();
      await exited;
    }
  },
);
test("after the poll passes its final check no other process can publish ahead of its cache rename", async () => {
  const data = await prepareCatalogRace();
  const fifo = join(dir, "release.fifo");
  execFileSync("mkfifo", [fifo], { env: { PATH: "/usr/bin:/bin" } });
  const { child, ready, exited } = racingProcess("locked");
  try {
    expect(await ready()).toBe("locked");
    h.store.database.exec("PRAGMA busy_timeout=0");
    expect((await post("confirm", data)).status).not.toBe(200);
    expect(
      h.store.database
        .prepare("SELECT installed FROM launch_web_changes")
        .all(),
    ).toEqual([]);
    writeFileSync(fifo, "release");
    expect(await exited).toBe(0);
    // The successful poll advanced only the catalog revision, not the YAML stamp.
    expect((await post("confirm", data)).status).toBe(409);
    version = JSON.parse((await get()).body).version;
    const retry = await confirmation({
      op: "set_model",
      name: "primary",
      id: "new",
    });
    expect((await post("confirm", retry)).status).toBe(200);
    expect(JSON.parse((await get()).body).profiles[0].model_id).toBe("new");
  } finally {
    child.kill();
    await exited;
  }
});
test("after process death between YAML and cache rename the next read recovers the pair and one receipt", async () => {
  h.store.createProject({ id: "p" });
  await prepareCatalogRace();
  const { exited } = racingProcess("crash");
  expect(await exited).toBe(73);
  expect(readFileSync(file, "utf8")).toContain("id: new");
  expect(
    h.store.database.prepare("SELECT installed FROM launch_web_changes").all(),
  ).toEqual([{ installed: 0 }]);
  expect(
    JSON.parse(readFileSync(join(h.dataDir, "models-dev.json"), "utf8"))
      .entries,
  ).toHaveLength(3);
  for (let i = 0; i < 2; i++) {
    expect(JSON.parse((await get()).body).profiles[0].model_id).toBe("new");
    expectPaired("new");
    expect(
      h.store.database
        .prepare("SELECT installed FROM launch_web_changes")
        .all(),
    ).toEqual([{ installed: 1 }]);
    expect(
      h.store.database.prepare("SELECT path FROM launch_model_intents").all(),
    ).toEqual([]);
  }
  expect(
    h.store.database
      .prepare("SELECT type FROM events WHERE type='launch_model_changed'")
      .all(),
  ).toHaveLength(1);
});

const saveEmployeeB = () =>
  writeProject(
    "employees",
    {
      name: "Writer",
      title: "Dev",
      avatar: "library:guan-yu",
      role_id: "coder",
      launch_profile_ref: "b",
    },
    "save-b",
  );
test("a different server deletes first: stale role and employee writers cannot use their local accepted names", async () => {
  projectWithRoleUsingA();
  const markdown = `---\nrole_id: author\nbased_on: default:coder\nlaunch_profile: b\n---\nDraft.`;
  const role = await writeProject(
    "role-document/preview",
    { markdown },
    "role-preview",
  );
  expect(role.status).toBe(200);
  expect(await racingProcess("delete").exited).toBe(0);
  expect(live.current().config.profiles.b).toBeDefined(); // no polling yet in this process
  expect((await saveEmployeeB()).status).toBe(400);
  expect([400, 409]).toContain(
    (
      await writeProject(
        "role-document/apply",
        { markdown, snapshot: JSON.parse(role.body).snapshot },
        "role-apply",
      )
    ).status,
  );
  expect(h.store.uow.read((tx) => tx.employees.list())).toEqual([]);
  await live.refresh();
  expect((await get("/profiles")).json).toEqual({ profiles: ["a"] });
});
test("an employee reference wins while a different server stages deletion: no YAML, catalog or receipt change", async () => {
  projectWithRoleUsingA();
  await prepareCatalogRace();
  const previous = readFileSync(file, "utf8"),
    cache = join(h.dataDir, "models-dev.json"),
    oldCache = readFileSync(cache, "utf8");
  const { child, ready, exited } = racingProcess("late-delete");
  try {
    expect(await ready()).toBe("fetching");
    expect((await saveEmployeeB()).status).toBe(200);
    child.send("resume");
    expect(await exited).toBe(43);
    expect(readFileSync(file, "utf8")).toBe(previous);
    expect(readFileSync(cache, "utf8")).toBe(oldCache);
    expect(
      h.store.database
        .prepare("SELECT operation FROM launch_web_changes")
        .all(),
    ).toEqual([]);
  } finally {
    child.kill();
    await exited;
  }
});
