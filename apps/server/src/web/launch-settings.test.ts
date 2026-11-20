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
import { createEmployee } from "@cardigan/domain";
import { defaultRoleDefinition } from "@cardigan/roles";
import { persistEmployeeEffect, roleDocument } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { call, webHarness } from "../../test-support/web.js";
import { liveLaunch } from "../live-launch.js";
import { readLaunchSettings } from "./launch-settings-file.js";

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
  b: { harness: pi }
`;
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
  h = await webHarness({ password: "launch-password", launchSettingsDir: dir });
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
  expect((await get("/profiles")).json).toEqual({ profiles: ["b"] });
  chmodSync(join(dir, "secrets.env"), 0o644);
  expect((await get()).status).toBe(400);
  expect(network).not.toHaveBeenCalled();
});
test("a preview binds exact YAML, secret generation and human session; install once, keep comments and reload", async () => {
  const live = await liveLaunch(
    dir,
    async () => readLaunchSettings(dir, h.dataDir).config,
    () => {
      throw Error("bad reload");
    },
  );
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
  expect((await live.refresh()).profiles.a?.model).toBe("second");
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
