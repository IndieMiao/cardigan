import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isAcceptedLaunchRevision,
  selectableLaunchConfig,
  withLaunchSnapshot,
} from "@cardigan/host";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { call, webHarness } from "../../test-support/web.js";
import { loadLaunchFiles } from "../host.js";
import { liveLaunch } from "../live-launch.js";
import { installSecrets } from "./launch-settings-secrets.js";

// C-549: Providers are created, edited and deleted from the Web, and
// secrets.env is write-only. Injected failures exercise both rollbacks.
const faults = vi.hoisted(() => ({
  publish: false,
  secretsRename: false,
  /** Runs right before the YAML step: another writer, deterministically. */
  beforePublish: undefined as (() => void) | undefined,
}));
vi.mock("@cardigan/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cardigan/host")>();
  return {
    ...actual,
    publishModelFile: (...args: Parameters<typeof actual.publishModelFile>) => {
      faults.beforePublish?.();
      if (faults.publish) throw new Error("fixture: disk full");
      return actual.publishModelFile(...args);
    },
  };
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const renameSync: typeof actual.renameSync = (from, to) => {
    if (faults.secretsRename && String(to).endsWith("secrets.env"))
      throw Object.assign(new Error("fixture: EIO"), { code: "EIO" });
    return actual.renameSync(from, to);
  };
  return { ...actual, default: { ...actual, renameSync }, renameSync };
});

const secret = "fixture-value-private",
  fresh = "fixture-new-credential-7f3a",
  config = `# keep my comment
providers:
  gateway:
    api: anthropic-messages
    name: Fixture
    base_url: https://gateway.example.invalid
    env: { PRIVATE_ENV: hidden-inline-value, PLAIN_MODEL: plain-model-name }
    secret_env: { ANTHROPIC_API_KEY: KEY }
models:
  primary: { provider: gateway, id: first, context_window: 32000 }
profiles:
  a: { harness: claude-code, model: primary }
`;
const secretsText = `# operator note\nKEY=${secret}\nOTHER=other-private-value\n`;
let live: Awaited<
  ReturnType<typeof liveLaunch<Awaited<ReturnType<typeof loadLaunchFiles>>>>
>;
let dir: string,
  h: Awaited<ReturnType<typeof webHarness>>,
  cookie: string,
  file: string,
  version: string;
const get = () => call(h.port, "/api/launch-settings", { cookie });
const post = (
  rest: string,
  body: unknown,
  key = "one",
  headers: Record<string, string> = {},
) =>
  call(h.port, `/api/launch-settings/${rest}`, {
    method: "POST",
    cookie,
    headers: {
      origin: `http://${h.hostHeader}`,
      "content-type": "application/json",
      "idempotency-key": key,
      ...headers,
    },
    body: JSON.stringify(body),
  });
const preview = (change: unknown) => post("preview", { version, change });
async function confirmation(change: unknown) {
  const response = await preview(change);
  expect(response.status, response.body).toBe(200);
  expect(response.body).not.toContain(fresh);
  return {
    version,
    preview_id: JSON.parse(response.body).preview_id as string,
    diff: JSON.parse(response.body).diff,
  };
}
const confirm = (
  data: { version: string; preview_id: string },
  secrets?: Record<string, string>,
  key = "one",
) =>
  post(
    "confirm",
    { version: data.version, preview_id: data.preview_id, secrets },
    key,
  );
const secretsFile = () => join(dir, "secrets.env");
const reread = async () => {
  const read = await get();
  expect(read.status, read.body).toBe(200);
  version = JSON.parse(read.body).version;
  return JSON.parse(read.body);
};
/** Everything a response, the store or the logs could carry. */
function exposed(...responses: string[]) {
  const tables = h.store.database
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((t) =>
      JSON.stringify(
        h.store.database.prepare(`SELECT * FROM "${String(t.name)}"`).all(),
      ),
    );
  return [...responses, ...tables].join("\n");
}

beforeEach(async () => {
  faults.publish = false;
  faults.secretsRename = false;
  faults.beforePublish = undefined;
  dir = mkdtempSync(join(tmpdir(), "launch-providers-"));
  file = join(dir, "launch.yaml");
  writeFileSync(file, config, { mode: 0o600 });
  writeFileSync(secretsFile(), secretsText, { mode: 0o600 });
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
  writeFileSync(
    join(h.dataDir, "models-dev.json"),
    JSON.stringify({ fetched_at: new Date().toISOString(), entries: [] }),
  );
  live = await liveLaunch(
    dir,
    () => loadLaunchFiles(dir, () => {}, h.dataDir, h.store),
    () => {},
    (next) => isAcceptedLaunchRevision(h.store, dir, next.revision),
  );
  cookie = await h.login("launch-password");
  await reread();
});
afterEach(async () => {
  await h?.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(dir, { force: true, recursive: true });
});

test("a new Provider with env and a write-only secret installs both files; no value ever leaves", async () => {
  const logs = [
    vi.spyOn(console, "log"),
    vi.spyOn(console, "warn"),
    vi.spyOn(console, "error"),
  ];
  const view = await reread();
  expect(view.providers[0]).toMatchObject({
    id: "gateway",
    harness: null,
    api: "anthropic-messages",
    profiles: ["a"],
    models: ["primary"],
    env: [
      { name: "PRIVATE_ENV", value: null },
      { name: "PLAIN_MODEL", value: "plain-model-name" },
    ],
    secrets: [
      { env: "ANTHROPIC_API_KEY", key: "KEY", set: true, updated_at: null },
    ],
  });
  const change = {
    op: "create_provider",
    name: "relay",
    fields: {
      name: "Relay",
      harness: "claude-code",
      base_url: "https://relay.example.invalid",
      env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "relay-opus" },
      secret_env: { ANTHROPIC_AUTH_TOKEN: "RELAY_TOKEN" },
    },
    secrets: { set: ["RELAY_TOKEN"] },
  };
  const data = await confirmation(change);
  expect(data.diff).toContainEqual({
    field: "secrets.RELAY_TOKEN",
    before: "unset",
    after: "new",
  });
  expect(readFileSync(file, "utf8")).toBe(config);
  // Values only for exactly the previewed keys.
  expect((await confirm(data)).status).toBe(400);
  expect((await confirm(data, { RELAY_TOKEN: fresh, OTHER: "x" })).status).toBe(
    400,
  );
  expect((await confirm(data, { RELAY_TOKEN: ` ${fresh}` })).status).toBe(400);
  expect(readFileSync(secretsFile(), "utf8")).toBe(secretsText);
  const ok = await confirm(data, { RELAY_TOKEN: fresh }, "two");
  expect(ok.status, ok.body).toBe(200);
  // Replays settle without a second write or a value.
  expect((await confirm(data, { RELAY_TOKEN: fresh }, "two")).status).toBe(200);
  const written = readFileSync(secretsFile(), "utf8");
  expect(written).toBe(`${secretsText}RELAY_TOKEN=${fresh}\n`);
  expect(statSync(secretsFile()).mode & 0o777).toBe(0o600);
  expect(readFileSync(file, "utf8")).toContain("# keep my comment");
  expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  const backups = readdirSync(dir).filter((n) => n.startsWith("secrets.env."));
  expect(backups).toHaveLength(1);
  expect(readFileSync(join(dir, backups[0] ?? ""), "utf8")).toBe(secretsText);
  const loaded = await live.refresh();
  expect(loaded.config.providers.relay).toMatchObject({
    harness: "claude-code",
    env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "relay-opus" },
    secret_env: { ANTHROPIC_AUTH_TOKEN: "RELAY_TOKEN" },
  });
  expect(loaded.secrets.RELAY_TOKEN).toBe(fresh);
  const after = await get();
  const relay = JSON.parse(after.body).providers.find(
    (p: { id: string }) => p.id === "relay",
  );
  expect(relay).toMatchObject({
    name: "Relay",
    profiles: [],
    env: [{ name: "ANTHROPIC_DEFAULT_OPUS_MODEL", value: "relay-opus" }],
    secrets: [{ env: "ANTHROPIC_AUTH_TOKEN", key: "RELAY_TOKEN", set: true }],
  });
  expect(Date.parse(relay.secrets[0].updated_at)).not.toBeNaN();
  expect(
    h.store.database
      .prepare("SELECT key,action FROM launch_secret_changes")
      .all(),
  ).toEqual([{ key: "RELAY_TOKEN", action: "set" }]);
  expect(exposed(ok.body, after.body)).not.toContain(fresh);
  expect(exposed(after.body)).not.toContain(secret);
  for (const log of logs)
    expect(JSON.stringify(log.mock.calls)).not.toContain(fresh);
});

test("only a human session reaches the secret write; a Bearer token is refused before any write", async () => {
  const data = await confirmation({
    op: "edit_provider",
    name: "gateway",
    fields: {},
    secrets: { set: ["KEY"] },
  });
  for (const headers of [
    { authorization: "Bearer fixture" },
    { authorization: `Bearer ${fresh}` },
  ]) {
    const refused = await call(h.port, "/api/launch-settings/confirm", {
      method: "POST",
      cookie,
      headers: {
        origin: `http://${h.hostHeader}`,
        "content-type": "application/json",
        "idempotency-key": "token",
        ...headers,
      },
      body: JSON.stringify({
        ...data,
        diff: undefined,
        secrets: { KEY: fresh },
      }),
    });
    expect(refused.status).toBe(403);
    expect(refused.body).not.toContain(fresh);
    const tokenOnly = await call(h.port, "/api/launch-settings/confirm", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({
        ...data,
        diff: undefined,
        secrets: { KEY: fresh },
      }),
    });
    expect([401, 403]).toContain(tokenOnly.status);
  }
  expect(readFileSync(secretsFile(), "utf8")).toBe(secretsText);
  expect(
    h.store.database.prepare("SELECT * FROM launch_secret_changes").all(),
  ).toEqual([]);
});

test("replace and clear secrets: a key a profile needs cannot be cleared; a secret-only write keeps the YAML", async () => {
  // Clearing what profile a needs is refused at preview.
  expect(
    (
      await preview({
        op: "edit_provider",
        name: "gateway",
        fields: {},
        secrets: { clear: ["KEY"] },
      })
    ).status,
  ).toBe(400);
  // A key this Provider does not reference cannot be written through it.
  expect(
    (
      await preview({
        op: "edit_provider",
        name: "gateway",
        fields: {},
        secrets: { set: ["OTHER"] },
      })
    ).status,
  ).toBe(400);
  const data = await confirmation({
    op: "edit_provider",
    name: "gateway",
    fields: {},
    secrets: { set: ["KEY"] },
  });
  expect(data.diff).toEqual([
    { field: "secrets.KEY", before: "set", after: "new" },
  ]);
  const ok = await confirm(data, { KEY: fresh });
  expect(ok.status, ok.body).toBe(200);
  expect(readFileSync(file, "utf8")).toBe(config);
  expect(readFileSync(secretsFile(), "utf8")).toBe(
    `# operator note\nOTHER=other-private-value\nKEY=${fresh}\n`,
  );
  expect((await live.refresh()).secrets.KEY).toBe(fresh);
  expect(
    h.store.database
      .prepare("SELECT action,target,installed FROM launch_web_changes")
      .all(),
  ).toEqual([{ action: "edit_provider", target: "gateway", installed: 1 }]);
  // Unused once the reference moves: the same change can clear it.
  await reread();
  // Clearing a key the old YAML still needs would break a crash between the renames.
  expect(
    (
      await preview({
        op: "edit_provider",
        name: "gateway",
        fields: { secret_env: { ANTHROPIC_API_KEY: "OTHER" } },
        secrets: { clear: ["KEY"] },
      })
    ).status,
  ).toBe(400);
  const remap = await confirmation({
    op: "edit_provider",
    name: "gateway",
    fields: {
      secret_env: { ANTHROPIC_API_KEY: "OTHER" },
      env: { PLAIN_MODEL: null, EXTRA_FLAG: "1" },
    },
  });
  expect((await confirm(remap, undefined, "four")).status).toBe(200);
  // A key no profile needs can be cleared; the line goes, the audit keeps the name.
  await reread();
  const spare = await confirmation({
    op: "create_provider",
    name: "spare",
    fields: {
      harness: "codex",
      base_url: "https://spare.example.invalid",
      secret_env: { OPENAI_API_KEY: "SPARE" },
    },
    secrets: { set: ["SPARE"] },
  });
  expect((await confirm(spare, { SPARE: fresh }, "five")).status).toBe(200);
  await reread();
  const cleared = await confirmation({
    op: "edit_provider",
    name: "spare",
    fields: {},
    secrets: { clear: ["SPARE"] },
  });
  expect(cleared.diff).toEqual([
    { field: "secrets.SPARE", before: "set", after: "unset" },
  ]);
  expect((await confirm(cleared, undefined, "six")).status).toBe(200);
  expect(readFileSync(secretsFile(), "utf8")).not.toContain("SPARE");
  expect(
    h.store.database
      .prepare("SELECT key,action FROM launch_secret_changes ORDER BY id")
      .all(),
  ).toEqual([
    { key: "KEY", action: "set" },
    { key: "SPARE", action: "set" },
    { key: "SPARE", action: "clear" },
  ]);
  const view = (await reread()).providers[0];
  expect(view.env).toEqual([
    { name: "PRIVATE_ENV", value: null },
    { name: "EXTRA_FLAG", value: "1" },
  ]);
});

test("a referenced Provider cannot be deleted and the refusal names its users; an unused one can", async () => {
  const refused = await preview({ op: "delete_provider", name: "gateway" });
  expect(refused.status).toBe(409);
  expect(refused.json).toMatchObject({
    error: {
      code: "provider_in_use",
      details: { profiles: ["a"], models: ["primary"] },
    },
  });
  const created = await confirmation({
    op: "create_provider",
    name: "spare",
    fields: { harness: "codex", base_url: "https://spare.example.invalid" },
  });
  expect((await confirm(created)).status).toBe(200);
  await reread();
  const removed = await confirmation({ op: "delete_provider", name: "spare" });
  expect(removed.diff).toEqual([
    { field: "providers.spare", before: "spare", after: null },
  ]);
  expect((await confirm(removed, undefined, "two")).status).toBe(200);
  expect((await live.refresh()).config.providers.spare).toBeUndefined();
  // Creating over an existing id is refused.
  await reread();
  expect(
    (
      await preview({
        op: "create_provider",
        name: "gateway",
        fields: { harness: "codex" },
      })
    ).json,
  ).toMatchObject({
    error: { code: "validation_failed", details: { field: "name" } },
  });
});

test("a failed YAML install puts secrets.env back; a failed secrets write leaves both files untouched", async () => {
  const change = {
    op: "create_provider",
    name: "relay",
    fields: {
      harness: "claude-code",
      base_url: "https://relay.example.invalid",
      secret_env: { ANTHROPIC_AUTH_TOKEN: "RELAY_TOKEN" },
    },
    secrets: { set: ["RELAY_TOKEN"] },
  };
  faults.publish = true;
  const data = await confirmation(change);
  const failed = await confirm(data, { RELAY_TOKEN: fresh });
  expect(failed.json).toMatchObject({ error: { code: "write_failed" } });
  expect(failed.body).not.toContain(fresh);
  expect(readFileSync(file, "utf8")).toBe(config);
  expect(readFileSync(secretsFile(), "utf8")).toBe(secretsText);
  expect(statSync(secretsFile()).mode & 0o777).toBe(0o600);
  expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  expect(
    h.store.database.prepare("SELECT * FROM launch_secret_changes").all(),
  ).toEqual([]);
  expect(exposed(failed.body)).not.toContain(fresh);

  faults.publish = false;
  faults.secretsRename = true;
  await reread();
  const again = await confirmation(change);
  const refused = await confirm(again, { RELAY_TOKEN: fresh }, "two");
  expect(refused.json).toMatchObject({ error: { code: "write_failed" } });
  expect(readFileSync(file, "utf8")).toBe(config);
  expect(readFileSync(secretsFile(), "utf8")).toBe(secretsText);
  expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  expect(
    h.store.database
      .prepare("SELECT * FROM launch_web_changes WHERE installed=1")
      .all(),
  ).toEqual([]);
  expect(exposed(refused.body)).not.toContain(fresh);
});

test("a secrets.env changed after the preview makes the confirmation stale and writes nothing", async () => {
  const data = await confirmation({
    op: "edit_provider",
    name: "gateway",
    fields: {},
    secrets: { set: ["KEY"] },
  });
  const edited = `${secretsText}LATER=1\n`;
  writeFileSync(secretsFile(), edited);
  chmodSync(secretsFile(), 0o600);
  const stale = await confirm(data, { KEY: fresh });
  expect(stale.status).toBe(409);
  expect(readFileSync(secretsFile(), "utf8")).toBe(edited);
});

test("a Provider probe lists models once with its own credential and records the result", async () => {
  const network = vi.fn(async () => Response.json({ data: [{ id: "x" }] }));
  vi.stubGlobal("fetch", network);
  const probe = () =>
    post("checks", { provider: "gateway", mode: "online", version });
  expect((await probe()).status).toBe(202);
  await vi.waitFor(async () =>
    expect((await reread()).providers[0].last_check).toMatchObject({
      mode: "online",
      status: "passed",
    }),
  );
  expect(network).toHaveBeenCalledOnce();
  expect(network.mock.calls[0]).toMatchObject([
    "https://gateway.example.invalid/v1/models",
    { headers: { "x-api-key": secret }, method: "GET", redirect: "error" },
  ]);
  network.mockImplementation(async () => new Response(secret, { status: 401 }));
  expect((await probe()).status).toBe(202);
  await vi.waitFor(async () =>
    expect((await reread()).providers[0].last_check).toMatchObject({
      status: "failed",
      problems: ["online_failed"],
    }),
  );
  // No endpoint, nothing to probe: refused before any request.
  const created = await confirmation({
    op: "create_provider",
    name: "bare",
    fields: { harness: "pi" },
  });
  expect((await confirm(created)).status).toBe(200);
  await reread();
  expect(
    (await post("checks", { provider: "bare", mode: "online", version })).json,
  ).toMatchObject({ error: { details: { field: "base_url" } } });
  expect(
    (await post("checks", { provider: "gateway", mode: "metadata", version }))
      .status,
  ).toBe(400);
  expect(network).toHaveBeenCalledTimes(2);
  expect(
    JSON.stringify(
      h.store.database.prepare("SELECT * FROM launch_profile_checks").all(),
    ),
  ).not.toContain(secret);
});

const rows = (sql: string) => h.store.database.prepare(sql).all();
const leftovers = () =>
  readdirSync(dir).filter((n) => n.endsWith(".tmp") || n.endsWith(".bak"));

test("a hidden env value never comes back: not in the read, not in any preview diff", async () => {
  const removed = await confirmation({
    op: "edit_provider",
    name: "gateway",
    fields: { env: { PRIVATE_ENV: null } },
  });
  expect(removed.diff).toEqual([
    {
      field: "providers.gateway.env.PRIVATE_ENV",
      before: { hidden: true },
      after: null,
    },
  ]);
  const replaced = await preview({
    op: "edit_provider",
    name: "gateway",
    fields: { env: { PRIVATE_ENV: "next-inline-value", PLAIN_MODEL: "m2" } },
  });
  expect(replaced.json).toMatchObject({
    diff: [
      {
        field: "providers.gateway.env.PRIVATE_ENV",
        before: { hidden: true },
        after: { hidden: true },
      },
      {
        field: "providers.gateway.env.PLAIN_MODEL",
        before: "plain-model-name",
        after: "m2",
      },
    ],
  });
  expect(replaced.body).not.toContain("hidden-inline-value");
  expect(replaced.body).not.toContain("next-inline-value");
  // A legacy endpoint with a query string is hidden in the env list as well
  // as in the endpoint column, and in a diff that removes or replaces it.
  writeFileSync(
    file,
    config
      .replace("    base_url: https://gateway.example.invalid\n", "")
      .replace(
        "PLAIN_MODEL: plain-model-name",
        "PLAIN_MODEL: plain-model-name, ANTHROPIC_BASE_URL: 'https://legacy.example.invalid/v1?sig=fixture-query'",
      ),
  );
  const read = await get();
  expect(read.body).not.toContain("fixture-query");
  const view = await reread();
  expect(view.providers[0].base_url).toBeNull();
  expect(view.providers[0].env).toContainEqual({
    name: "ANTHROPIC_BASE_URL",
    value: null,
  });
  for (const env of [
    { ANTHROPIC_BASE_URL: null },
    { ANTHROPIC_BASE_URL: "https://next.example.invalid" },
  ]) {
    const diff = await preview({
      op: "edit_provider",
      name: "gateway",
      fields: { env },
    });
    expect(diff.status, diff.body).toBe(200);
    expect(diff.body).not.toContain("fixture-query");
    expect(diff.json).toMatchObject({
      diff: [{ before: { hidden: true } }],
    });
  }
});

test("an audit or commit failure around the secrets rename never leaves a half-applied write", async () => {
  const change = {
    op: "edit_provider",
    name: "gateway",
    fields: {},
    secrets: { set: ["KEY"] },
  };
  // The audit rows are committed with the intent, before the rename.
  h.store.database.exec(
    "CREATE TEMP TRIGGER fail_audit BEFORE INSERT ON launch_secret_changes BEGIN SELECT RAISE(ABORT, 'fixture'); END",
  );
  const audit = await confirm(await confirmation(change), { KEY: fresh });
  expect(audit.json).toMatchObject({ error: { code: "write_failed" } });
  expect(readFileSync(secretsFile(), "utf8")).toBe(secretsText);
  expect(rows("SELECT * FROM launch_secret_intents")).toEqual([]);
  expect(rows("SELECT * FROM launch_web_changes")).toEqual([]);
  expect(leftovers()).toEqual([]);
  h.store.database.exec("DROP TRIGGER fail_audit");

  // The commit after the rename fails, and so does settling it at once: the
  // outcome is reported as unknown, never as "nothing written".
  h.store.database.exec(
    "CREATE TEMP TRIGGER fail_commit BEFORE UPDATE ON launch_web_changes BEGIN SELECT RAISE(ABORT, 'fixture'); END",
  );
  await reread();
  const data = await confirmation(change);
  const unknown = await confirm(data, { KEY: fresh }, "two");
  expect(unknown.json).toMatchObject({ error: { code: "write_unsettled" } });
  expect(readFileSync(secretsFile(), "utf8")).toContain(`KEY=${fresh}`);
  expect(rows("SELECT operation FROM launch_secret_intents")).toHaveLength(1);
  h.store.database.exec("DROP TRIGGER fail_commit");
  // The next read settles it from the files: applied, with its audit row.
  await reread();
  expect(rows("SELECT * FROM launch_secret_intents")).toEqual([]);
  expect(rows("SELECT key,action FROM launch_secret_changes")).toEqual([
    { key: "KEY", action: "set" },
  ]);
  expect(rows("SELECT installed FROM launch_web_changes")).toEqual([
    { installed: 1 },
  ]);
  // The same confirmation replayed is answered from the receipt.
  expect((await confirm(data, undefined, "two")).status).toBe(200);
  expect(exposed(unknown.body)).not.toContain(fresh);
});

test("a crash between the secrets and the YAML rename is undone on the next read; once the YAML is in, it stands", async () => {
  const candidate = config.replace(
    "ANTHROPIC_API_KEY: KEY",
    "ANTHROPIC_API_KEY: NEXT",
  );
  const crash = (operation: string) => {
    const fence = withLaunchSnapshot(h.store, dir, h.dataDir, (f) => f);
    installSecrets(h.store, dir, h.dataDir, fence, {
      operation,
      original: secretsText,
      text: `${secretsText}NEXT=${fresh}\n`,
      yaml: {
        path: realpathSync(file),
        after: createHash("sha256").update(candidate).digest("hex"),
      },
      reserve: () =>
        h.store.database
          .prepare(
            "INSERT INTO launch_secret_changes(operation,key,action,actor,created_at) VALUES(?,?,?,?,?)",
          )
          .run(operation, "NEXT", "set", "human", new Date().toISOString()),
    });
    // The process dies here: no YAML rename, no settling.
    expect(readFileSync(secretsFile(), "utf8")).toContain("NEXT=");
  };
  crash("crashed-before-yaml");
  await reread();
  expect(readFileSync(secretsFile(), "utf8")).toBe(secretsText);
  expect(statSync(secretsFile()).mode & 0o777).toBe(0o600);
  expect(rows("SELECT * FROM launch_secret_changes")).toEqual([]);
  expect(rows("SELECT * FROM launch_secret_intents")).toEqual([]);
  expect(leftovers()).toEqual([]);

  crash("crashed-after-yaml");
  writeFileSync(file, candidate); // the YAML rename had completed
  await reread();
  expect(readFileSync(secretsFile(), "utf8")).toBe(
    `${secretsText}NEXT=${fresh}\n`,
  );
  expect(rows("SELECT key FROM launch_secret_changes")).toEqual([
    { key: "NEXT" },
  ]);
  expect(rows("SELECT * FROM launch_secret_intents")).toEqual([]);
});

test("two writers: a secrets.env change between the two steps makes the YAML step stale and is never rolled back over", async () => {
  const data = await confirmation({
    op: "edit_provider",
    name: "gateway",
    fields: { secret_env: { ANTHROPIC_API_KEY: "NEXT" } },
    secrets: { set: ["NEXT"] },
  });
  let later = "";
  faults.beforePublish = () => {
    // The other writer edits secrets.env in place (same inode).
    later = readFileSync(secretsFile(), "utf8").replace(
      `NEXT=${fresh}\n`,
      "LATER=1\n",
    );
    writeFileSync(secretsFile(), later);
  };
  const refused = await confirm(data, { NEXT: fresh });
  expect(refused.json).toMatchObject({ error: { code: "stale_snapshot" } });
  expect(readFileSync(file, "utf8")).toBe(config);
  expect(readFileSync(secretsFile(), "utf8")).toBe(later);
  expect(rows("SELECT * FROM launch_secret_changes")).toEqual([]);
  expect(rows("SELECT * FROM launch_secret_intents")).toEqual([]);
  expect(rows("SELECT * FROM launch_web_changes WHERE installed=1")).toEqual(
    [],
  );
  // The YAML was never installed, so nothing could need the dropped key.
  expect((await live.refresh()).config.providers.gateway?.secret_env).toEqual({
    ANTHROPIC_API_KEY: "KEY",
  });
  expect(exposed(refused.body)).not.toContain(fresh);
});

test("a write to a key another Provider also reads is refused and names who reads it", async () => {
  const shared = {
    op: "create_provider",
    name: "relay",
    fields: {
      harness: "claude-code",
      base_url: "https://relay.example.invalid",
      secret_env: { ANTHROPIC_API_KEY: "KEY" },
    },
  };
  const refused = await preview({ ...shared, secrets: { set: ["KEY"] } });
  expect(refused.status).toBe(409);
  expect(refused.json).toMatchObject({
    error: {
      code: "secret_shared",
      details: { key: "KEY", providers: ["gateway"], profiles: ["a"] },
    },
  });
  // Referencing the existing value without writing it is fine.
  expect((await confirm(await confirmation(shared))).status).toBe(200);
  await reread();
  const back = await preview({
    op: "edit_provider",
    name: "gateway",
    fields: {},
    secrets: { set: ["KEY"] },
  });
  expect(back.json).toMatchObject({
    error: { code: "secret_shared", details: { providers: ["relay"] } },
  });
  expect(readFileSync(secretsFile(), "utf8")).toBe(secretsText);
});

test("a Provider whose endpoint is a safe legacy env URL can be probed, also after saving other fields", async () => {
  writeFileSync(
    file,
    config
      .replace("    base_url: https://gateway.example.invalid\n", "")
      .replace(
        "PLAIN_MODEL: plain-model-name",
        "PLAIN_MODEL: plain-model-name, ANTHROPIC_BASE_URL: https://legacy.example.invalid",
      ),
  );
  await reread();
  const saved = await confirmation({
    op: "edit_provider",
    name: "gateway",
    fields: { name: "Renamed" },
  });
  expect((await confirm(saved)).status).toBe(200);
  const view = await reread();
  expect(view.providers[0].base_url).toBe("https://legacy.example.invalid");
  const network = vi.fn(async () => Response.json({ data: [] }));
  vi.stubGlobal("fetch", network);
  const started = await post("checks", {
    provider: "gateway",
    mode: "online",
    version,
  });
  expect(started.status, started.body).toBe(202);
  await vi.waitFor(async () =>
    expect((await reread()).providers[0].last_check).toMatchObject({
      status: "passed",
    }),
  );
  expect(network.mock.calls[0]?.[0]).toBe(
    "https://legacy.example.invalid/v1/models",
  );
});
