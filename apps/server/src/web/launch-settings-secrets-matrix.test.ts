import { execFileSync, fork } from "node:child_process";
import { once } from "node:events";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isAcceptedLaunchRevision,
  selectableLaunchConfig,
} from "@cardigan/host";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { call, webHarness } from "../../test-support/web.js";
import { loadLaunchFiles } from "../host.js";
import { liveLaunch } from "../live-launch.js";

/*
 * C-549 secrets save/recovery state matrix (C-549#263, #264, #267), as
 * confirmed by code review and independent review. Every row runs against
 * synthetic files, a temporary SQLite store and fake values. Crash rows run
 * the confirmation in a child process that really exits at the named point;
 * recovery then happens in this process (a different owner).
 */
const faults = vi.hoisted(() => ({
  beforePublish: undefined as (() => void) | undefined,
  afterPublish: undefined as (() => void) | undefined,
  shortWrite: false,
  /** Right after the staged secrets.env is renamed into place. */
  afterSecretsRename: undefined as (() => void) | undefined,
  /** When the key clean-up writes its staged file. */
  onCleanupWrite: undefined as (() => void) | undefined,
  /** Remaining failures of removing an own staging directory. */
  stagingRmFailures: 0,
}));
vi.mock("@cardigan/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cardigan/host")>();
  return {
    ...actual,
    publishModelFile: (...args: Parameters<typeof actual.publishModelFile>) => {
      faults.beforePublish?.();
      const revision = actual.publishModelFile(...args);
      faults.afterPublish?.();
      return revision;
    },
  };
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const staged = (path: unknown) => String(path).includes("/.secrets-staging/");
  const writeFileSync: typeof actual.writeFileSync = (path, data, opts) => {
    if (
      faults.shortWrite &&
      staged(path) &&
      String(path).endsWith("/secrets.env")
    ) {
      actual.writeFileSync(path, String(data).slice(0, 5), opts);
      throw Object.assign(new Error("fixture: ENOSPC"), { code: "ENOSPC" });
    }
    if (staged(path) && String(path).endsWith("/cleanup"))
      faults.onCleanupWrite?.();
    return actual.writeFileSync(path, data, opts);
  };
  const renameSync: typeof actual.renameSync = (from, to) => {
    actual.renameSync(from, to);
    if (
      staged(from) &&
      String(from).endsWith("/secrets.env") &&
      String(to).endsWith("/secrets.env")
    )
      faults.afterSecretsRename?.();
  };
  const rmSync: typeof actual.rmSync = (path, opts) => {
    if (
      faults.stagingRmFailures > 0 &&
      /\/\.secrets-staging\/[^/]+$/u.test(String(path))
    ) {
      faults.stagingRmFailures -= 1;
      throw Object.assign(new Error("fixture: EIO"), { code: "EIO" });
    }
    return actual.rmSync(path, opts);
  };
  const patched = { writeFileSync, renameSync, rmSync };
  return { ...actual, ...patched, default: { ...actual, ...patched } };
});

const secret = "fixture-value-private",
  fresh = "fixture-new-credential-7f3a",
  config = `providers:
  gateway:
    api: anthropic-messages
    name: Fixture
    base_url: https://gateway.example.invalid
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
const secretsFile = () => join(dir, "secrets.env");
const stagingRoot = () => join(dir, ".secrets-staging");
const get = () => call(h.port, "/api/launch-settings", { cookie });
const post = (rest: string, body: unknown, key = "one") =>
  call(h.port, `/api/launch-settings/${rest}`, {
    method: "POST",
    cookie,
    headers: {
      origin: `http://${h.hostHeader}`,
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: JSON.stringify(body),
  });
const reread = async () => {
  const read = await get();
  expect(read.status, read.body).toBe(200);
  version = JSON.parse(read.body).version;
  return JSON.parse(read.body);
};
async function confirmation(change: unknown) {
  const response = await post("preview", { version, change });
  expect(response.status, response.body).toBe(200);
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
const rows = (sql: string) => h.store.database.prepare(sql).all();
const audit = () =>
  rows("SELECT key,action,status FROM launch_secret_changes ORDER BY id");
const intentsLeft = () => rows("SELECT operation FROM launch_secret_intents");
const stagingEntries = () =>
  existsSync(stagingRoot()) ? readdirSync(stagingRoot()) : [];
const fresher = (op: string) =>
  `KEY_${op.replaceAll("-", "").slice(0, 8).toUpperCase()}`;

/** One confirmation in a child process; resolves with its messages and exit code. */
async function child(
  mode: string,
  change: unknown,
  values: Record<string, string> = {},
  replay?: unknown,
) {
  const proc = fork(
    fileURLToPath(
      new URL("../../test-support/launch-secrets-crash.mjs", import.meta.url),
    ),
    [
      dir,
      h.dataDir,
      mode,
      JSON.stringify(change),
      JSON.stringify(values),
      JSON.stringify(replay ?? null),
    ],
    {
      execArgv: [],
      env: { HOME: dir, PATH: dir },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  const messages: Record<string, unknown>[] = [];
  proc.on("message", (m) => messages.push(m as Record<string, unknown>));
  let stderr = "";
  proc.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  return {
    proc,
    messages,
    exited: once(proc, "exit").then(([code]) => ({
      code: code as number,
      stderr,
    })),
  };
}
async function crashed(mode: string, change: unknown, values = {}) {
  const run = await child(mode, change, values);
  const { code, stderr } = await run.exited;
  expect(code, stderr).toBe(73);
  return run.messages[0] as { preview_id: string; version: string };
}
async function replayIn(
  preview: { preview_id: string; version: string },
  override: Record<string, unknown> = {},
) {
  const run = await child(
    "replay",
    null,
    {},
    {
      ...preview,
      key: "child-key",
      ...override,
    },
  );
  const { code, stderr } = await run.exited;
  expect(code, stderr).toBe(0);
  return run.messages[0] as { ok?: true; code?: string };
}

const REPLACE = {
  op: "edit_provider",
  name: "gateway",
  fields: {},
  secrets: { set: ["KEY"] },
};
async function withSpare() {
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
  expect((await confirm(spare, { SPARE: fresh }, "spare")).status).toBe(200);
  await reread();
  return readFileSync(secretsFile(), "utf8");
}
const CLEAR = {
  op: "edit_provider",
  name: "spare",
  fields: {},
  secrets: { clear: ["SPARE"] },
};

beforeEach(async () => {
  faults.beforePublish = undefined;
  faults.afterPublish = undefined;
  faults.shortWrite = false;
  faults.afterSecretsRename = undefined;
  faults.onCleanupWrite = undefined;
  faults.stagingRmFailures = 0;
  dir = mkdtempSync(join(tmpdir(), "launch-matrix-"));
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
  vi.restoreAllMocks();
  rmSync(dir, { force: true, recursive: true });
});

// A2 (V-2727:1): fresh names stay distinct within one change; each value
// lands under its own key.
test("A2: two long keys that share 119 characters are replaced into two distinct keys", async () => {
  const long1 = `${"L".repeat(119)}X`,
    long2 = `${"L".repeat(119)}Y`;
  writeFileSync(
    file,
    config.replace(
      "secret_env: { ANTHROPIC_API_KEY: KEY }",
      `secret_env: { ANTHROPIC_API_KEY: KEY, AUX_ENV: ${long1}, AUX_TWO: ${long2} }`,
    ),
  );
  writeFileSync(
    secretsFile(),
    `${secretsText}${long1}=old-one\n${long2}=old-two\n`,
  );
  await reread();
  const data = await confirmation({
    op: "edit_provider",
    name: "gateway",
    fields: {},
    secrets: { set: [long1, long2] },
  });
  const ok = await confirm(data, { [long1]: "new-one", [long2]: "new-two" });
  expect(ok.status, ok.body).toBe(200);
  const loaded = await live.refresh();
  const refs = loaded.config.providers.gateway?.secret_env ?? {};
  expect(refs.AUX_ENV).not.toBe(refs.AUX_TWO);
  expect(refs.AUX_ENV?.length).toBeLessThanOrEqual(128);
  expect(loaded.secrets[refs.AUX_ENV ?? ""]).toBe("new-one");
  expect(loaded.secrets[refs.AUX_TWO ?? ""]).toBe("new-two");
  expect(audit()).toHaveLength(2);
});

// B2 (V-2727:2): refused before the rename; another writer's same-named key
// stays, only this operation's own staging goes.
test("B2: an external same-named key added before the rename is kept", async () => {
  const data = await confirmation({
    op: "edit_provider",
    name: "gateway",
    fields: { secret_env: { ANTHROPIC_API_KEY: "NEXT" } },
    secrets: { set: ["NEXT"] },
  });
  h.store.database.function("fixture_external", () => {
    writeFileSync(
      secretsFile(),
      `${readFileSync(secretsFile(), "utf8")}NEXT=external-value\n`,
    );
    return 0;
  });
  h.store.database.exec(
    "CREATE TEMP TRIGGER external AFTER INSERT ON launch_secret_changes BEGIN SELECT fixture_external(); END",
  );
  const refused = await confirm(data, { NEXT: fresh });
  h.store.database.exec("DROP TRIGGER external");
  expect(refused.json).toMatchObject({ error: { code: "stale_snapshot" } });
  expect(readFileSync(secretsFile(), "utf8")).toBe(
    `${secretsText}NEXT=external-value\n`,
  );
  expect(readFileSync(file, "utf8")).toBe(config);
  expect(audit()).toEqual([
    { key: "NEXT", action: "set", status: "not_applied" },
  ]);
  expect(stagingEntries()).toEqual([]);
  expect(intentsLeft()).toEqual([]);
});

// B3 (V-2729:2): a short temp write fails in place; nothing with secret bytes stays.
test("B3: a short write of the staged file leaves no fragment and changes nothing", async () => {
  const data = await confirmation(REPLACE);
  faults.shortWrite = true;
  const failed = await confirm(data, { KEY: fresh });
  faults.shortWrite = false;
  expect(failed.json).toMatchObject({ error: { code: "write_failed" } });
  expect(readFileSync(secretsFile(), "utf8")).toBe(secretsText);
  expect(stagingEntries()).toEqual([]);
  expect(audit()).toEqual([
    { key: fresher(data.preview_id), action: "set", status: "not_applied" },
  ]);
});

// B4 / B5 / C2 / F rows: the process really exits at the named point.
const crashRows = [
  {
    name: "B4 before the staging directory exists",
    mode: "exit-before-mkdir",
    kind: "write",
    staging: "none",
    secrets: "unchanged",
    status: "not_applied",
    replay: "stale_snapshot",
  },
  {
    name: "B4 directory made, identity not yet recorded (empty directory removed)",
    mode: "exit-after-mkdir",
    kind: "write",
    staging: "none",
    secrets: "unchanged",
    status: "not_applied",
    replay: "stale_snapshot",
  },
  {
    name: "B4 path already occupied (its content stays)",
    mode: "occupied-exit",
    kind: "write",
    staging: "occupied",
    secrets: "unchanged",
    status: "not_applied",
    replay: "stale_snapshot",
  },
  {
    name: "B4 short write of the staged secrets file (fragment removed)",
    mode: "short-temp",
    kind: "write",
    staging: "none",
    secrets: "unchanged",
    status: "not_applied",
    replay: "stale_snapshot",
  },
  {
    name: "B4 short write of the staged backup (fragment removed)",
    mode: "short-backup",
    kind: "write",
    staging: "none",
    secrets: "unchanged",
    status: "not_applied",
    replay: "stale_snapshot",
  },
  {
    name: "B4 temp recorded, rename not done",
    mode: "exit-before-rename",
    kind: "write",
    staging: "none",
    secrets: "unchanged",
    status: "not_applied",
    replay: "stale_snapshot",
  },
  {
    name: "B5 renamed, bookkeeping not committed (new key kept: no proof of no change)",
    mode: "exit-after-rename",
    kind: "write",
    staging: "none",
    secrets: "with-new-key",
    status: "not_applied",
    replay: "stale_snapshot",
  },
  {
    name: "C2 renamed and recorded, YAML never reserved (own unused key removed)",
    mode: "exit-before-yaml",
    kind: "write",
    staging: "none",
    secrets: "unchanged",
    status: "not_applied",
    replay: "stale_snapshot",
  },
  {
    name: "F clear: temp recorded, rename not done",
    mode: "exit-before-rename",
    kind: "clear",
    staging: "none",
    secrets: "unchanged",
    status: "not_applied",
    replay: "stale_snapshot",
  },
  {
    name: "F clear: renamed, bookkeeping not committed",
    mode: "exit-after-rename",
    kind: "clear",
    staging: "none",
    secrets: "cleared",
    status: "applied",
    replay: "ok",
  },
  {
    name: "F clear: short write of the staged file",
    mode: "short-temp",
    kind: "clear",
    staging: "none",
    secrets: "unchanged",
    status: "not_applied",
    replay: "stale_snapshot",
  },
] as const;

test.each(crashRows)("$name", async (row) => {
  const before =
    row.kind === "clear"
      ? await withSpare()
      : readFileSync(secretsFile(), "utf8");
  const statusBefore = audit().length;
  const preview = await crashed(
    row.mode,
    row.kind === "clear" ? CLEAR : REPLACE,
    row.kind === "clear" ? {} : { KEY: fresh },
  );
  // The host may load first: the running configuration is consistent.
  const loaded = await loadLaunchFiles(dir, () => {}, h.dataDir, h.store);
  expect(loaded.config.providers.gateway?.secret_env.ANTHROPIC_API_KEY).toBe(
    "KEY",
  );
  // Recovery in this process (the child, the owner, is gone).
  await reread();
  const text = readFileSync(secretsFile(), "utf8");
  if (row.secrets === "unchanged") expect(text).toBe(before);
  if (row.secrets === "with-new-key")
    expect(text).toBe(`${before}${fresher(preview.preview_id)}=${fresh}\n`);
  if (row.secrets === "cleared") expect(text).not.toContain("SPARE=");
  expect(readFileSync(file, "utf8")).not.toContain(fresher(preview.preview_id));
  const own = join(stagingRoot(), preview.preview_id);
  if (row.staging === "none") expect(existsSync(own)).toBe(false);
  if (row.staging === "occupied")
    expect(readFileSync(join(own, "keep.txt"), "utf8")).toBe("keep");
  const mine = audit().slice(statusBefore);
  expect(mine.every((r) => r.status === row.status)).toBe(true);
  expect(intentsLeft()).toEqual([]);
  expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  // H1': the same request, after the restart, gets the recorded outcome.
  const answer = await replayIn(preview);
  expect(answer.ok ? "ok" : answer.code).toBe(row.replay);
  expect(readFileSync(secretsFile(), "utf8")).toBe(text);
});

// C2 variant: changed after the rename, the new key cannot be proved ours.
test("C2: an edit to secrets.env after the crash keeps the new key", async () => {
  const preview = await crashed("exit-before-yaml", REPLACE, { KEY: fresh });
  writeFileSync(
    secretsFile(),
    `${readFileSync(secretsFile(), "utf8")}LATER=1\n`,
  );
  await reread();
  const text = readFileSync(secretsFile(), "utf8");
  expect(text).toContain(`${fresher(preview.preview_id)}=${fresh}`);
  expect(text).toContain("LATER=1");
  expect(audit().map((r) => r.status)).toEqual(["not_applied"]);
});

// C1: another writer edits secrets.env in place between the two steps.
test("C1: a stale YAML step keeps a new key that is no longer provably ours", async () => {
  const data = await confirmation(REPLACE);
  faults.beforePublish = () => {
    writeFileSync(
      secretsFile(),
      `${readFileSync(secretsFile(), "utf8")}LATER=1\n`,
    );
  };
  const refused = await confirm(data, { KEY: fresh });
  expect(refused.json).toMatchObject({ error: { code: "stale_snapshot" } });
  const text = readFileSync(secretsFile(), "utf8");
  expect(text).toContain("LATER=1");
  expect(text).toContain(`${fresher(data.preview_id)}=${fresh}`);
  expect(text).toContain(`KEY=${secret}`);
  expect(readFileSync(file, "utf8")).toBe(config);
  expect(audit().map((r) => r.status)).toEqual(["not_applied"]);
});

// A1': the superseded key goes only while the file is provably unchanged.
test("A1: a superseded key recreated externally with the same value is kept", async () => {
  const data = await confirmation(REPLACE);
  faults.afterPublish = () => {
    // Between the commit and the clean-up: same content, a new file version.
    const text = readFileSync(secretsFile(), "utf8");
    writeFileSync(`${secretsFile()}.fixture`, text, { mode: 0o600 });
    renameSync(`${secretsFile()}.fixture`, secretsFile());
  };
  const ok = await confirm(data, { KEY: fresh });
  expect(ok.status, ok.body).toBe(200);
  expect(readFileSync(secretsFile(), "utf8")).toContain(`KEY=${secret}`);
  expect(audit().map((r) => r.status)).toEqual(["applied"]);
  // Without the external rewrite the superseded key goes.
  faults.afterPublish = undefined;
  await reread();
  const again = await confirmation({
    op: "edit_provider",
    name: "gateway",
    fields: {},
    secrets: { set: [fresher(data.preview_id)] },
  });
  expect(
    (await confirm(again, { [fresher(data.preview_id)]: "next" }, "two"))
      .status,
  ).toBe(200);
  expect(readFileSync(secretsFile(), "utf8")).not.toContain(
    `${fresher(data.preview_id)}=${fresh}`,
  );
});

// D3 (V-2727:3): installed, receipt lost, YAML later restored to its original
// text and the host retires the receipt: never recorded as not applied.
test("D3: a retired receipt after a real installation is unconfirmed, never not applied", async () => {
  const data = await confirmation(REPLACE);
  h.store.database.exec(
    "CREATE TEMP TRIGGER fail_receipt BEFORE UPDATE ON launch_web_changes BEGIN SELECT RAISE(ABORT, 'fixture'); END",
  );
  const unknown = await confirm(data, { KEY: fresh });
  expect(unknown.json).toMatchObject({ error: { code: "write_unsettled" } });
  h.store.database.exec("DROP TRIGGER fail_receipt");
  expect(readFileSync(file, "utf8")).toContain(fresher(data.preview_id));
  // Restore the original YAML; another publication retires the old receipt.
  writeFileSync(file, config);
  await reread();
  const other = await confirmation({
    op: "edit_provider",
    name: "gateway",
    fields: { name: "Other" },
  });
  expect((await confirm(other, undefined, "three")).status).toBe(200);
  await reread();
  expect(
    rows(
      `SELECT DISTINCT status FROM launch_secret_changes WHERE operation='${data.preview_id}'`,
    ),
  ).toEqual([{ status: "unconfirmed" }]);
  // The same request still answers unconfirmed.
  expect((await confirm(data, undefined, "one")).json).toMatchObject({
    error: { code: "write_unsettled" },
  });
});

// E3 (V-2729:1): a writer paused between its two steps is never settled by a reader.
test("E3: a reader never settles a live writer paused between its steps", async () => {
  const fifo = join(dir, "release.fifo");
  execFileSync("mkfifo", [fifo], { env: { PATH: "/usr/bin:/bin" } });
  const run = await child("pause-before-yaml", REPLACE, { KEY: fresh });
  await vi.waitFor(
    () => expect(run.messages).toContainEqual({ paused: true }),
    {
      timeout: 10000,
    },
  );
  const preview = run.messages[0] as { preview_id: string };
  await reread();
  await reread();
  expect(intentsLeft()).toHaveLength(1);
  expect(readFileSync(secretsFile(), "utf8")).toContain(
    `${fresher(preview.preview_id)}=${fresh}`,
  );
  writeFileSync(fifo, "release");
  const { code, stderr } = await run.exited;
  expect(code, stderr).toBe(0);
  expect(run.messages.at(-1)).toEqual({ ok: true });
  await reread();
  expect(readFileSync(file, "utf8")).toContain(fresher(preview.preview_id));
  expect(audit().map((r) => r.status)).toEqual(["applied"]);
  expect(intentsLeft()).toEqual([]);
});

// H1': replay identity is the session + idempotency key + preview + version.
test("H1: after a restart, a different preview or session never gets the original result", async () => {
  const preview = await crashed("exit-after-rename", REPLACE, { KEY: fresh });
  await reread();
  const text = readFileSync(secretsFile(), "utf8");
  expect(
    await replayIn(preview, {
      preview_id: "71f8db4b-e973-4bf8-9f87-cbb0915e83da",
    }),
  ).toEqual({ code: "idempotency_conflict" });
  expect(await replayIn(preview, { version: "0".repeat(64) })).toEqual({
    code: "idempotency_conflict",
  });
  const other = await replayIn(preview, { session: "another-session" });
  expect(other.ok).toBeUndefined();
  expect(readFileSync(secretsFile(), "utf8")).toBe(text);
});

// H2': unconfirmed, then settled by the same running process.
test("H2: an unconfirmed answer is settled later without a restart", async () => {
  const data = await confirmation(REPLACE);
  h.store.database.exec(
    "CREATE TEMP TRIGGER fail_receipt BEFORE UPDATE ON launch_web_changes BEGIN SELECT RAISE(ABORT, 'fixture'); END",
  );
  const unknown = await confirm(data, { KEY: fresh });
  expect(unknown.json).toMatchObject({ error: { code: "write_unsettled" } });
  h.store.database.exec("DROP TRIGGER fail_receipt");
  await reread();
  expect(audit().map((r) => r.status)).toEqual(["applied"]);
  expect((await confirm(data, undefined, "one")).status).toBe(200);
  expect(intentsLeft()).toEqual([]);
});

/*
 * C-549#320 (confirmed in #336 / #337): single writer. Outside changes stop
 * the operation; the outcome is committed on its own; clean-up is staged in
 * the operation's own directory and retried until that directory is gone.
 */
const outside = `${secretsText}OUTSIDE=outside-private-value\n`;
const replaceOutside = () => {
  writeFileSync(`${secretsFile()}.outside`, outside, { mode: 0o600 });
  renameSync(`${secretsFile()}.outside`, secretsFile());
};
const receiptsOf = (op: string) =>
  rows(`SELECT installed FROM launch_web_changes WHERE operation='${op}'`);

// T1 (V-2748:1): replaced right after our rename, before the stamp.
test("T1: an outside file swapped in right after the rename stops the save and is kept", async () => {
  const data = await confirmation(REPLACE);
  faults.afterSecretsRename = replaceOutside;
  const refused = await confirm(data, { KEY: fresh });
  faults.afterSecretsRename = undefined;
  expect(refused.json).toMatchObject({ error: { code: "stale_snapshot" } });
  expect(readFileSync(secretsFile(), "utf8")).toBe(outside);
  expect(readFileSync(file, "utf8")).toBe(config);
  expect(receiptsOf(data.preview_id)).toEqual([]);
  expect(audit()).toEqual([
    { key: fresher(data.preview_id), action: "set", status: "not_applied" },
  ]);
  expect(intentsLeft()).toEqual([]);
  expect(stagingEntries()).toEqual([]);
  expect((await confirm(data, undefined)).json).toMatchObject({
    error: { code: "stale_snapshot" },
  });
  await reread();
  expect(readFileSync(secretsFile(), "utf8")).toBe(outside);
});

// T2 (V-2748:1): edited in place right after our rename, before the stamp.
test("T2: an outside line appended right after the rename stops the save and is kept", async () => {
  const data = await confirmation(REPLACE);
  faults.afterSecretsRename = () =>
    appendFileSync(secretsFile(), "OUTSIDE=1\n");
  const refused = await confirm(data, { KEY: fresh });
  faults.afterSecretsRename = undefined;
  expect(refused.json).toMatchObject({ error: { code: "stale_snapshot" } });
  const expected = `${secretsText}${fresher(data.preview_id)}=${fresh}\nOUTSIDE=1\n`;
  expect(readFileSync(secretsFile(), "utf8")).toBe(expected);
  expect(readFileSync(file, "utf8")).toBe(config);
  expect(receiptsOf(data.preview_id)).toEqual([]);
  expect(audit().map((r) => r.status)).toEqual(["not_applied"]);
  expect(intentsLeft()).toEqual([]);
  await reread();
  expect(readFileSync(secretsFile(), "utf8")).toBe(expected);
});

// T3 (V-2748:1): replaced after the stamp, before the YAML publication.
test("T3: an outside file swapped in before the YAML step stops the save and is kept", async () => {
  const data = await confirmation(REPLACE);
  faults.beforePublish = replaceOutside;
  const refused = await confirm(data, { KEY: fresh });
  faults.beforePublish = undefined;
  expect(refused.json).toMatchObject({ error: { code: "stale_snapshot" } });
  expect(readFileSync(secretsFile(), "utf8")).toBe(outside);
  expect(readFileSync(file, "utf8")).toBe(config);
  expect(audit().map((r) => r.status)).toEqual(["not_applied"]);
  expect(intentsLeft()).toEqual([]);
  expect(stagingEntries()).toEqual([]);
});

// Clear variant of T1: whether the clear still holds cannot be proved.
test("T1 clear: an outside file swapped in right after a clear's rename is kept, unconfirmed", async () => {
  await withSpare();
  const data = await confirmation(CLEAR);
  faults.afterSecretsRename = replaceOutside;
  const unknown = await confirm(data, undefined, "clear");
  faults.afterSecretsRename = undefined;
  expect(unknown.json).toMatchObject({ error: { code: "write_unsettled" } });
  expect(readFileSync(secretsFile(), "utf8")).toBe(outside);
  expect(audit().at(-1)).toEqual({
    key: "SPARE",
    action: "clear",
    status: "unconfirmed",
  });
  expect(intentsLeft()).toEqual([]);
  expect(stagingEntries()).toEqual([]);
  expect((await confirm(data, undefined, "clear")).json).toMatchObject({
    error: { code: "write_unsettled" },
  });
});

// T4 (V-2748:1 operator-update): the rotation is in effect; an outside line
// arrives after the clean-up read the file.
test("T4: an outside change during the old-key clean-up keeps the file and the old key", async () => {
  const data = await confirmation(REPLACE);
  faults.onCleanupWrite = () => {
    faults.onCleanupWrite = undefined;
    appendFileSync(secretsFile(), "OPERATOR=1\n");
  };
  const ok = await confirm(data, { KEY: fresh });
  expect(ok.status, ok.body).toBe(200);
  const text = readFileSync(secretsFile(), "utf8");
  expect(text).toContain("OPERATOR=1");
  expect(text).toContain(`KEY=${secret}`);
  expect(text).toContain(`${fresher(data.preview_id)}=${fresh}`);
  expect(readFileSync(file, "utf8")).toContain(fresher(data.preview_id));
  expect(audit().map((r) => r.status)).toEqual(["applied"]);
  expect(intentsLeft()).toEqual([]);
  expect(stagingEntries()).toEqual([]);
  expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  await reread();
  expect(readFileSync(secretsFile(), "utf8")).toBe(text);
  expect((await confirm(data, undefined)).status).toBe(200);
});

// T5 (V-2748:2): short write, then removing the staging directory fails once.
test("T5: a failed staging removal after a short write keeps the intent until it is removed", async () => {
  const data = await confirmation(REPLACE);
  faults.shortWrite = true;
  faults.stagingRmFailures = 1;
  const failed = await confirm(data, { KEY: fresh });
  faults.shortWrite = false;
  expect(failed.json).toMatchObject({ error: { code: "write_failed" } });
  expect(faults.stagingRmFailures).toBe(0);
  expect(readFileSync(secretsFile(), "utf8")).toBe(secretsText);
  expect(audit().map((r) => r.status)).toEqual(["not_applied"]);
  expect(rows("SELECT resolved, keys_done FROM launch_secret_intents")).toEqual(
    [{ resolved: "failed", keys_done: 1 }],
  );
  expect(stagingEntries()).toEqual([data.preview_id]);
  // The fault is gone: the next read finishes the clean-up.
  await reread();
  expect(stagingEntries()).toEqual([]);
  expect(intentsLeft()).toEqual([]);
  expect(audit().map((r) => r.status)).toEqual(["not_applied"]);
  expect((await confirm(data, undefined)).json).toMatchObject({
    error: { code: "stale_snapshot" },
  });
});

// T6 (V-2748:2): short write, outcome committed, the process exits before
// the staging directory goes.
test("T6: an exit between the recorded failure and the staging removal is recovered", async () => {
  const preview = await crashed("short-temp-exit-at-drop", REPLACE, {
    KEY: fresh,
  });
  expect(audit().map((r) => r.status)).toEqual(["not_applied"]);
  expect(stagingEntries()).toEqual([preview.preview_id]);
  await reread();
  await reread();
  expect(stagingEntries()).toEqual([]);
  expect(intentsLeft()).toEqual([]);
  expect(readFileSync(secretsFile(), "utf8")).toBe(secretsText);
  expect(audit().map((r) => r.status)).toEqual(["not_applied"]);
  expect(await replayIn(preview)).toEqual({ code: "stale_snapshot" });
});

// T7 (V-2748:3): published, then the old-key clean-up cannot write.
test("T7: a failing old-key clean-up never changes the published result", async () => {
  const data = await confirmation(REPLACE);
  faults.onCleanupWrite = () => {
    throw Object.assign(new Error("fixture: EIO"), { code: "EIO" });
  };
  const ok = await confirm(data, { KEY: fresh });
  expect(ok.status, ok.body).toBe(200);
  expect(receiptsOf(data.preview_id)).toEqual([{ installed: 1 }]);
  expect(audit().map((r) => r.status)).toEqual(["applied"]);
  expect(rows("SELECT resolved, keys_done FROM launch_secret_intents")).toEqual(
    [{ resolved: "applied", keys_done: 0 }],
  );
  await reread();
  expect((await confirm(data, undefined)).status).toBe(200);
  expect(audit().map((r) => r.status)).toEqual(["applied"]);
  expect(readFileSync(secretsFile(), "utf8")).toContain(`KEY=${secret}`);
  expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  // The fault is gone: the next read removes the old key and finishes.
  faults.onCleanupWrite = undefined;
  await reread();
  expect(readFileSync(secretsFile(), "utf8")).not.toContain(`KEY=${secret}`);
  expect(intentsLeft()).toEqual([]);
  expect(stagingEntries()).toEqual([]);
  expect(audit().map((r) => r.status)).toEqual(["applied"]);
  expect((await confirm(data, undefined)).status).toBe(200);
});

// T8 (V-2749:1): the clean-up copy is written, the process exits before its
// rename; the copy is inside the own staging directory and is recovered.
test("T8: an exit during the old-key clean-up leaves no secrets copy behind", async () => {
  const preview = await crashed("exit-at-cleanup", REPLACE, { KEY: fresh });
  expect(audit().map((r) => r.status)).toEqual(["applied"]);
  expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  expect(readdirSync(join(stagingRoot(), preview.preview_id))).toContain(
    "cleanup",
  );
  await reread();
  await reread();
  expect(stagingEntries()).toEqual([]);
  expect(intentsLeft()).toEqual([]);
  expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  const text = readFileSync(secretsFile(), "utf8");
  expect(text).not.toContain(`KEY=${secret}`);
  expect(text).toContain(`${fresher(preview.preview_id)}=${fresh}`);
  expect(audit().map((r) => r.status)).toEqual(["applied"]);
  expect(await replayIn(preview)).toEqual({ ok: true });
});

// T9: two Workbench confirmations at once run one after the other.
test("T9: concurrent confirmations are serialised; the second sees the new version", async () => {
  const one = await confirmation(REPLACE);
  const two = await confirmation({
    op: "edit_provider",
    name: "gateway",
    fields: { name: "Second" },
  });
  const answers = await Promise.all([
    confirm(one, { KEY: fresh }, "first"),
    confirm(two, undefined, "second"),
  ]);
  expect(answers.map((a) => a.status)).toEqual([200, 409]);
  expect(answers[1]?.json).toMatchObject({
    error: { code: "stale_snapshot" },
  });
  expect(audit().map((r) => r.status)).toEqual(["applied"]);
  expect(intentsLeft()).toEqual([]);
  expect(readFileSync(file, "utf8")).not.toContain("Second");
});
