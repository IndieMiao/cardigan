import { randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExtMessageSender,
  extFingerprints,
  loadExtMessageConfig,
} from "@cardigan/host";
import {
  extChannelActivation,
  extEventWatermark,
  Store,
} from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { parse } from "yaml";
import { call, webHarness } from "../../test-support/web.js";
import { project_id } from "../../test-support/web-data.js";

const mock = vi.hoisted(() => ({
  send: vi.fn(),
  appSend: vi.fn(),
  failRename: false,
  failCleanup: false,
}));
vi.mock("@cardigan/host", async (orig) => ({
  ...(await orig<typeof import("@cardigan/host")>()),
  extMessageAdapters: { lark: () => ({ send: mock.send }) },
  boundTestAdapter: () => ({ send: mock.appSend }),
}));
vi.mock("node:fs", async (orig) => {
  const fs = await orig<typeof import("node:fs")>();
  return {
    ...fs,
    rmSync: (...args: Parameters<typeof fs.rmSync>) => {
      if (
        mock.failCleanup &&
        typeof args[0] === "string" &&
        args[0].includes("/.feishu-")
      ) {
        mock.failCleanup = false;
        throw Object.assign(new Error("fixture cleanup error"), {
          code: "EIO",
        });
      }
      return fs.rmSync(...args);
    },
    renameSync: (src: string, dst: string) => {
      if (mock.failRename && dst.endsWith("/ext-message.yaml"))
        throw new Error("fixture rename error");
      return fs.renameSync(src, dst);
    },
  };
});
const webhook = "https://open.feishu.cn/open-apis/bot/v2/hook/fixture-hook",
  sign = "fixture-private-sign",
  appId = "cli_0123456789abcdef",
  appSecret = "fixture-private-app",
  tenant = "fixture-tenant";
const app = JSON.stringify({
  app_id: appId,
  app_secret: appSecret,
  tenant_key: tenant,
});
let dir: string,
  path: string,
  cookie: string,
  h: Awaited<ReturnType<typeof webHarness>>;
const get = () => call(h.port, "/api/feishu-settings", { cookie });
const post = (
  rest: string,
  body: unknown,
  key: string = randomUUID(),
  session = cookie,
  other: Record<string, string> = {},
) =>
  call(h.port, `/api/feishu-settings/${rest}`, {
    method: "POST",
    cookie: session,
    headers: {
      origin: `http://${h.hostHeader}`,
      "content-type": "application/json",
      "idempotency-key": key,
      ...other,
    },
    body: JSON.stringify(body),
  });
const put = (file: string, text: string) =>
  writeFileSync(join(dir, file), text, { mode: 0o600 });
const settings = () => readFileSync(path, "utf8");
const state = async () => {
  const r = await get();
  expect(r.status, r.body).toBe(200);
  return JSON.parse(r.body);
};
const preview = async (change: unknown) => {
  const { version } = await state(),
    p = await post("preview", { version, change });
  expect(p.status, p.body).toBe(200);
  return JSON.parse(p.body);
};
const confirm = (
  p: { version: string; preview_id: string },
  secrets: Record<string, string> = {},
  key: string = randomUUID(),
  session = cookie,
) =>
  post(
    "confirm",
    { version: p.version, preview_id: p.preview_id, secrets },
    key,
    session,
  );
const audit = () =>
  JSON.stringify(
    h.store.database.prepare("SELECT * FROM feishu_settings_requests").all(),
  );
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "feishu-settings-"));
  path = join(dir, "ext-message.yaml");
  h = await webHarness({
    password: "test-private-password",
    feishuSettingsPath: path,
    diskStore: true,
  });
  cookie = await h.login("test-private-password");
  mock.failRename = false;
  mock.failCleanup = false;
  mock.send.mockReset().mockResolvedValue("sent");
  mock.appSend.mockReset().mockResolvedValue("sent");
});
afterEach(async () => {
  await h.close();
  rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const yaml = `# retained note\nenabled: true\nworkbench_url: https://workbench.invalid\nchannels:\n  lark: {enabled: true, credential_file: ext-message.secrets}\n  lark_app: {enabled: true, credential_file: feishu-app.secrets}\n`;
  put("ext-message.yaml", yaml);
  put("ext-message.secrets", JSON.stringify({ webhook, secret: sign }));
  put("feishu-app.secrets", app);
  return yaml;
}
test("empty configuration, including defaults, can be bootstrapped without reading or writing on preview", async () => {
  const s = await state();
  expect(s.settings["policy.max_per_minute"]).toBe(10);
  expect(s.secrets.app_secret).toEqual({ set: false, updated_at: null });
  const p = await preview({
    settings: {
      "channels.lark.enabled": true,
      enabled: true,
      workbench_url: "https://workbench.invalid",
    },
    secrets: { set: ["lark_webhook"] },
  });
  expect(readdirSync(dir)).toEqual([]);
  expect(p.restart_required).toBe(false);
  expect(
    (await confirm(p, { lark_webhook: "https://example.invalid" })).status,
  ).toBe(400);
  expect(readdirSync(dir)).toEqual([]);
  expect((await confirm(p, { lark_webhook: webhook })).status).toBe(200);
  expect(loadExtMessageConfig(path)).toMatchObject({
    status: "loaded",
    config: { channels: { lark: { enabled: true } } },
  });
});
test("read and previews are write-only; two secret files rotate with one YAML publication, old backup stays usable", async () => {
  const original = fixture(),
    before = await state();
  expect(before.secrets.app_secret).toEqual({
    set: true,
    updated_at: expect.any(String),
  });
  const p = await preview({
    settings: {
      "channels.lark.max_per_minute": 3,
      "channels.lark_app.max_per_minute": 7,
      "quiet_hours.enabled": true,
      "quiet_hours.start": "20:30",
    },
    secrets: { set: ["app_secret"], clear: ["lark_sign_secret"] },
  });
  const values = { app_secret: "updated-private-value" },
    r = await confirm(p, values, "rotate");
  expect(r.status, r.body).toBe(200);
  expect((await confirm(p, values, "rotate")).json).toEqual(r.json);
  const after = await state(),
    raw = parse(settings());
  expect(settings()).toContain("# retained note");
  expect(settings()).not.toContain(values.app_secret);
  const backup = join(dir, readdirSync(dir).find((f) => f.endsWith(".bak"))!);
  expect(readFileSync(backup, "utf8")).toBe(original);
  expect(loadExtMessageConfig(backup)).toMatchObject({
    status: "loaded",
  });
  for (const ch of ["lark", "lark_app"]) {
    const file = join(dir, raw.channels[ch].credential_file);
    expect(lstatSync(file).isSymbolicLink()).toBe(false);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  }
  expect(after.secrets.lark_sign_secret.set).toBe(false);
  expect(after.secrets.app_id.updated_at).toBe(
    before.secrets.app_id.updated_at,
  );
  expect(loadExtMessageConfig(path)).toMatchObject({
    status: "loaded",
    config: {
      quiet_hours: { start: "20:30" },
      channels: {
        lark: { max_per_minute: 3, credential: JSON.stringify({ webhook }) },
        lark_app: {
          max_per_minute: 7,
          credential: JSON.stringify({
            app_id: appId,
            ...values,
            tenant_key: tenant,
          }),
        },
      },
    },
  });
  const exposed = JSON.stringify([after, before, p, r.json, audit()]);
  for (const secret of [
    webhook,
    sign,
    appSecret,
    tenant,
    appId,
    values.app_secret,
  ])
    expect(exposed).not.toContain(secret);
  expect(audit()).not.toContain("workbench.invalid");
});
test.each(["ordinary setting", "clear last credential"])(
  "a cleanup error after saving %s does not change the first response or its replay",
  async (kind) => {
    fixture();
    put("ext-message.secrets", JSON.stringify({ webhook }));
    const clear = kind === "clear last credential";
    const p = await preview(
      clear
        ? {
            settings: { "channels.lark.enabled": false },
            secrets: { clear: ["lark_webhook"] },
          }
        : { settings: { "policy.timeout_ms": 987 } },
    );
    mock.failCleanup = true;
    const first = await confirm(p, {}, "cleanup"),
      after = await state();
    expect(mock.failCleanup).toBe(false);
    expect(first.status).toBe(200);
    expect(first.json).toEqual({ result: "applied" });
    if (clear) {
      expect(after.settings["channels.lark.enabled"]).toBe(false);
      expect(after.secrets.lark_webhook.set).toBe(false);
    } else expect(after.settings["policy.timeout_ms"]).toBe(987);
    const retry = await confirm(p, {}, "cleanup");
    expect(retry.status).toBe(200);
    expect(retry.json).toEqual(first.json);
    expect((await state()).version).toBe(after.version);
    expect(JSON.parse(audit())).toMatchObject([{ result: "applied" }]);
  },
);
test.each([false, true])(
  "rename failure preserves both live secret files and YAML (cleanup also fails: %s)",
  async (failCleanup) => {
    const original = fixture();
    const p = await preview({
      secrets: { set: ["app_secret", "lark_sign_secret"] },
    });
    mock.failRename = true;
    mock.failCleanup = failCleanup;
    expect(
      (
        await confirm(
          p,
          { app_secret: "new-app", lark_sign_secret: "new-sign" },
          "failed-rename",
        )
      ).status,
    ).toBe(503);
    mock.failRename = false;
    const replay = await confirm(
      p,
      { app_secret: "new-app", lark_sign_secret: "new-sign" },
      "failed-rename",
    );
    expect(replay.status).toBe(409);
    expect(replay.body).toContain("not_applied");
    expect(settings()).toBe(original);
    expect(readFileSync(join(dir, "feishu-app.secrets"), "utf8")).toBe(app);
    expect(readFileSync(join(dir, "ext-message.secrets"), "utf8")).toContain(
      sign,
    );
    expect(JSON.parse(audit())).toMatchObject([{ result: "not_applied" }]);
    expect(mock.failCleanup).toBe(false);
    expect(
      readdirSync(dir).filter((k) => k.startsWith(".feishu-")),
    ).toHaveLength(failCleanup ? 1 : 0);
  },
);
test("permission and symlink failures do not follow target, preview is session/version bound and never accepts credential paths", async () => {
  fixture();
  const p = await preview({ settings: { "policy.timeout_ms": 99 } });
  const other = await h.login("test-private-password");
  expect((await confirm(p, {}, randomUUID(), other)).status).toBe(409);
  expect((await confirm(p, { unexpected: sign })).status).toBe(400);
  expect(
    (
      await post("preview", {
        version: p.version,
        change: { settings: { "channels.lark.credential_file": "other" } },
      })
    ).status,
  ).toBe(400);
  put("feishu-app.secrets", `${app} `);
  expect((await confirm(p)).status).toBe(409);
  const c = join(dir, "ext-message.secrets");
  chmodSync(c, 0o644);
  expect((await get()).status).toBe(400);
  rmSync(c);
  symlinkSync("feishu-app.secrets", c);
  expect((await get()).status).toBe(400);
  expect(readFileSync(join(dir, "feishu-app.secrets"), "utf8")).toBe(`${app} `);
});
test.each(["agent", "pm"])(
  "%s bearer is refused, even alongside a valid human cookie",
  async (role) => {
    fixture();
    const headers = { authorization: `Bearer synthetic-${role}` };
    expect(
      (await call(h.port, "/api/feishu-settings", { headers })).status,
    ).toBe(401);
    expect(
      (await call(h.port, "/api/feishu-settings", { headers, cookie })).status,
    ).toBe(403);
    for (const route of ["preview", "confirm", "test/lark", "test/lark_app"])
      expect((await post(route, {}, "k", cookie, headers)).status).toBe(403);
    expect(mock.send).not.toHaveBeenCalled();
    expect(audit()).toBe("[]");
  },
);
test("each fixed-message endpoint records before sending; concurrent requests, failures and replays never resend", async () => {
  fixture();
  let done!: () => void, entered!: () => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  mock.send.mockImplementationOnce(
    () =>
      new Promise<string>((r) => {
        entered();
        done = () => r("sent");
      }),
  );
  const first = post("test/lark", {}, "test-one");
  await started;
  expect((await post("test/lark", {}, "test-one")).json).toEqual({
    result: "unknown",
  });
  done();
  expect((await first).json).toEqual({ result: "sent" });
  expect((await post("test/lark", {}, "test-one")).json).toEqual({
    result: "sent",
  });
  expect(mock.send).toHaveBeenCalledTimes(1);
  expect(mock.send.mock.calls[0]?.[0]).toEqual({
    title: "Cardigan 外部通知测试",
    url: "https://workbench.invalid",
  });
  expect((await post("test/lark_app", {}, "test-one")).status).toBe(409);
  expect((await post("test/lark_app", { to: "untrusted" })).status).toBe(400);
  mock.appSend.mockRejectedValue(new Error(appSecret));
  for (let i = 0; i < 2; i++)
    expect((await post("test/lark_app", {}, "test-two")).json).toEqual({
      result: "unknown",
    });
  expect(mock.appSend).toHaveBeenCalledTimes(1);
  expect(audit()).not.toContain(appSecret);
});

test("test requests use the selected channel budget, and clearing required keys needs an explicit disable", async () => {
  fixture();
  const p = await preview({ settings: { "channels.lark.max_per_minute": 1 } });
  expect((await confirm(p)).status).toBe(200);
  expect((await post("test/lark", {})).status).toBe(200);
  expect((await post("test/lark", {})).status).toBe(429);
  expect(mock.send).toHaveBeenCalledTimes(1);
  const { version } = await state();
  expect(
    (
      await post("preview", {
        version,
        change: { secrets: { clear: ["lark_webhook"] } },
      })
    ).status,
  ).toBe(400);
  const off = await preview({
    settings: { "channels.lark.enabled": false },
    secrets: { clear: ["lark_webhook", "lark_sign_secret"] },
  });
  expect((await confirm(off)).status).toBe(200);
  expect((await state()).secrets.lark_webhook.set).toBe(false);
  expect(parse(settings()).channels.lark.credential_file).toBeUndefined();
  expect((await post("test/lark", {})).status).toBe(409);
});

test("a failed reservation COMMIT leaves the original file and preview retryable", async () => {
  const original = fixture(),
    db = h.store.database;
  const p = await preview({ settings: { "policy.timeout_ms": 987 } });
  db.exec(`CREATE TABLE abort_commit (id TEXT REFERENCES members(id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TRIGGER reject_reservation AFTER INSERT ON feishu_settings_requests BEGIN INSERT INTO abort_commit VALUES('missing'); END;`);
  expect((await confirm(p, {}, "commit")).status).toBe(503);
  expect(settings()).toBe(original);
  expect(audit()).toBe("[]");
  db.exec("DROP TRIGGER reject_reservation");
  expect((await confirm(p, {}, "commit")).json).toEqual({ result: "applied" });
});

test.each([
  { first: "web", rotate: false },
  { first: "web", rotate: true },
  { first: "background", rotate: false },
  { first: "background", rotate: true },
])(
  "a prepared publication is reconciled by $first after rename (credential rotated: $rotate)",
  async ({ first, rotate }) => {
    fixture();
    const db = h.store.database;
    const p = await preview({ settings: { "policy.timeout_ms": 987 } });
    db.exec(`CREATE TABLE abort_commit (id TEXT REFERENCES members(id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TRIGGER reject_outcome AFTER UPDATE OF result ON feishu_settings_requests WHEN NEW.result='applied' BEGIN INSERT INTO abort_commit VALUES('missing'); END;`);
    expect((await confirm(p, {}, "ambiguous")).json).toEqual({
      result: "applied",
    });
    expect(parse(settings()).policy.timeout_ms).toBe(987);
    expect(JSON.parse(audit())).toMatchObject([{ result: "prepared" }]);
    const receipt = db
      .prepare("SELECT fingerprints FROM feishu_settings_publications")
      .get();
    expect(JSON.parse(String(receipt?.fingerprints))).toEqual([
      ...extFingerprints(loadExtMessageConfig(path), true),
    ]);
    expect((await confirm(p, {}, "ambiguous")).json).toEqual({
      result: "applied",
    });
    // An event committed after publication must remain beyond the recovered activation cutoff.
    const cutoff = extEventWatermark(db);
    h.store.createProject({ id: project_id, name: "fixture" });
    h.store.uow.run((tx) =>
      tx.events.append(project_id, {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(project_id),
        type: "fixture_test",
        actor: { kind: "system", project_id },
        created_at: new Date().toISOString(),
        payload: {},
      }),
    );
    expect(extEventWatermark(db)).toBeGreaterThan(cutoff);
    const current = extEventWatermark(db);
    if (rotate)
      put(
        "ext-message.secrets",
        JSON.stringify({ webhook, secret: "rotated-fixture" }),
      );
    db.exec("DROP TRIGGER reject_outcome");
    const { FeishuSettings } = await import("./feishu-settings.js");
    const reopened = Store.open({ dataDir: h.dataDir });
    try {
      const configuration = loadExtMessageConfig(path);
      const expected = {
        fingerprint: extFingerprints(configuration, true).get("lark"),
        watermark: rotate ? current : cutoff,
      };
      if (first === "background") {
        const start = () =>
          new ExtMessageSender({
            store: reopened,
            configuration: loadExtMessageConfig(path),
            startApplication: () => undefined,
          }).recordStatus();
        start();
        const channel = extChannelActivation(db, "lark");
        expect(channel).toMatchObject(expected);
        start(); // a second process must not restart the same recovered epoch
        expect(extChannelActivation(db, "lark")).toEqual(channel);
        if (rotate) {
          put("ext-message.secrets", JSON.stringify({ webhook, secret: sign }));
          start(); // A return to the prepared fingerprint is another rotation, not a rewind.
          expect(extChannelActivation(db, "lark")?.watermark).toBe(current);
        }
      }
      new FeishuSettings(reopened, path);
      expect(extChannelActivation(db, "lark")?.watermark).toBe(
        expected.watermark,
      );
      if (first === "web") {
        expect(extChannelActivation(db, "lark")).toMatchObject(expected);
        expect(extChannelActivation(db, "lark_app")?.watermark).toBe(cutoff);
      }
    } finally {
      reopened.close();
    } // new connection, empty previews
    expect(JSON.parse(audit())).toMatchObject([
      { result: "applied", keys: JSON.stringify(["policy.timeout_ms"]) },
    ]);
    expect(
      db.prepare("SELECT * FROM feishu_settings_publications").all(),
    ).toEqual([]);
    expect(
      db.prepare("SELECT name FROM ext_message_channels ORDER BY name").all(),
    ).toEqual([{ name: "lark" }, { name: "lark_app" }]);
    expect((await confirm(p, {}, "ambiguous")).json).toEqual({
      result: "applied",
    });
  },
);

test("a settings-only save preserves legacy inline credential timestamps", async () => {
  fixture();
  put(
    "ext-message.yaml",
    settings().replace(
      "credential_file: feishu-app.secrets",
      `credential: '${app}'`,
    ),
  );
  utimesSync(path, new Date("2026-01-01"), new Date("2026-01-01"));
  const before = (await state()).secrets;
  expect(before.app_secret.updated_at).toBe("2026-01-01T00:00:00.000Z");
  expect(
    (await confirm(await preview({ settings: { "policy.timeout_ms": 1234 } })))
      .status,
  ).toBe(200);
  expect((await state()).secrets).toEqual(before);
});

test("a masked link cannot be sent or unmasked by rotating or clearing the credential", async () => {
  fixture();
  put(
    "ext-message.yaml",
    settings().replace(
      "https://workbench.invalid",
      `https://workbench.invalid/${sign}`,
    ),
  );
  const s = await state();
  expect(s.settings.workbench_url).toBeNull();
  for (const name of ["lark", "lark_app"])
    expect((await post(`test/${name}`, {})).status).toBe(400);
  expect(audit()).toBe("[]");
  expect(mock.send).not.toHaveBeenCalled();
  expect(mock.appSend).not.toHaveBeenCalled();
  for (const action of ["set", "clear"])
    expect(
      (
        await post("preview", {
          version: s.version,
          change: { secrets: { [action]: ["lark_sign_secret"] } },
        })
      ).status,
    ).toBe(400);
  const p = await preview({
    settings: { workbench_url: "https://safe.invalid" },
    secrets: { set: ["lark_sign_secret"] },
  });
  expect(JSON.stringify(p)).not.toContain(sign);
  expect((await confirm(p, { lark_sign_secret: "replacement" })).status).toBe(
    200,
  );
  expect(JSON.stringify(await state())).not.toContain(sign);
});
test("C-580 push filter reads its defaults, saves through preview and confirm, and keeps channel epochs", async () => {
  fixture();
  const s = await state();
  expect(
    Object.fromEntries(
      Object.entries(s.settings).filter(([k]) => k.startsWith("filter.")),
    ),
  ).toEqual({
    "filter.decision": true,
    "filter.human_action": true,
    "filter.merge_confirmation": true,
    "filter.notice": false,
    "filter.excluded_projects": [],
  });
  const before = loadExtMessageConfig(path);
  const change = {
    settings: {
      "filter.notice": true,
      "filter.decision": false,
      "filter.excluded_projects": ["sensen-godot"],
    },
  };
  const p = await preview(change);
  expect(p.diff).toEqual([
    { key: "filter.decision", before: true, after: false },
    { key: "filter.notice", before: false, after: true },
    {
      key: "filter.excluded_projects",
      before: [],
      after: ["sensen-godot"],
    },
  ]);
  expect((await confirm(p)).status).toBe(200);
  expect(parse(settings()).filter).toEqual({
    notice: true,
    decision: false,
    excluded_projects: ["sensen-godot"],
  });
  const after = loadExtMessageConfig(path);
  expect(after).toMatchObject({
    status: "loaded",
    config: {
      filter: {
        kinds: {
          decision: false,
          human_action: true,
          merge_confirmation: true,
          notice: true,
        },
        excluded_projects: ["sensen-godot"],
      },
    },
  });
  // The filter is not a channel rotation: pending retries keep their epoch.
  expect(extFingerprints(after, true)).toEqual(extFingerprints(before, true));
  const reread = await state();
  expect(reread.settings["filter.notice"]).toBe(true);
  expect(reread.settings["filter.excluded_projects"]).toEqual(["sensen-godot"]);
});
test.each([
  { "filter.notice": "yes" },
  { "filter.excluded_projects": "cardigan" },
  { "filter.excluded_projects": ["Cardigan"] },
  { "filter.excluded_projects": ["../escape"] },
  { "filter.excluded_projects": ["cardigan", "cardigan"] },
  { "filter.projects": ["cardigan"] },
])(
  "C-580 an invalid push filter change is refused before any write: %j",
  async (settings) => {
    const original = fixture();
    const { version } = await state();
    const r = await post("preview", { version, change: { settings } });
    expect(r.status).toBe(400);
    expect(readFileSync(path, "utf8")).toBe(original);
  },
);
test("C-580 a kind switched back on is cut off at the save, not at the later background reload", async () => {
  fixture();
  const db = h.store.database;
  const mark = () =>
    db
      .prepare(
        "SELECT enabled,watermark FROM ext_message_filter_marks WHERE scope='kind:notice'",
      )
      .get();
  new ExtMessageSender({
    store: h.store,
    configuration: loadExtMessageConfig(path),
    startApplication: () => undefined,
  }).recordStatus();
  expect(mark()).toEqual({ enabled: 0, watermark: 0 });
  const p = await preview({ settings: { "filter.notice": true } });
  expect((await confirm(p)).status).toBe(200);
  const atSave = extEventWatermark(db);
  expect(mark()).toEqual({ enabled: 1, watermark: atSave });
  // Facts recorded after the save are after the cutoff; a background reload
  // of the same publication keeps it.
  h.store.uow.run((tx) =>
    tx.events.append(project_id, {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(project_id),
      type: "host_role_upgraded",
      actor: { kind: "system", project_id },
      created_at: new Date().toISOString(),
      payload: {},
    }),
  );
  new ExtMessageSender({
    store: h.store,
    configuration: loadExtMessageConfig(path),
    startApplication: () => undefined,
  }).recordStatus();
  expect(mark()).toEqual({ enabled: 1, watermark: atSave });
});
test("C-580 an excluded project list holding a credential is hidden on read and cannot be previewed until corrected", async () => {
  fixture();
  // A hand-edited list whose member equals the synthetic tenant key.
  writeFileSync(
    path,
    `${settings()}filter:\n  excluded_projects: [cardigan, ${tenant}]\n`,
    { mode: 0o600 },
  );
  const read = await state();
  expect(read.settings["filter.excluded_projects"]).toBeNull();
  const r = await get();
  expect(r.body).not.toContain(tenant);
  const { version } = read;
  const unsafe = await post("preview", {
    version,
    change: { settings: { "filter.notice": true } },
  });
  expect(unsafe.status).toBe(400);
  expect(unsafe.body).not.toContain(tenant);
  const fixed = await preview({
    settings: { "filter.excluded_projects": ["cardigan"] },
  });
  expect(JSON.stringify(fixed)).not.toContain(tenant);
  expect(fixed.diff).toEqual([
    { key: "filter.excluded_projects", before: null, after: ["cardigan"] },
  ]);
});
test("C-580 any project identifier the CLI can create can be excluded", async () => {
  fixture();
  const long = `p${"x".repeat(200)}`;
  const p = await preview({ settings: { "filter.excluded_projects": [long] } });
  expect((await confirm(p)).status).toBe(200);
  expect(loadExtMessageConfig(path)).toMatchObject({
    status: "loaded",
    config: { filter: { excluded_projects: [long] } },
  });
});
