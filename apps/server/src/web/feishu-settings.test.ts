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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExtMessageConfig } from "@cardigan/host";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { parse } from "yaml";
import { call, webHarness } from "../../test-support/web.js";

const mock = vi.hoisted(() => ({
  send: vi.fn(),
  appSend: vi.fn(),
  failRename: false,
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
  });
  cookie = await h.login("test-private-password");
  mock.failRename = false;
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
test("failure at rename preserves both live secret files and YAML, with no success audit", async () => {
  const original = fixture();
  const p = await preview({
    secrets: { set: ["app_secret", "lark_sign_secret"] },
  });
  mock.failRename = true;
  expect(
    (await confirm(p, { app_secret: "new-app", lark_sign_secret: "new-sign" }))
      .status,
  ).toBe(400);
  expect(settings()).toBe(original);
  expect(readFileSync(join(dir, "feishu-app.secrets"), "utf8")).toBe(app);
  expect(readFileSync(join(dir, "ext-message.secrets"), "utf8")).toContain(
    sign,
  );
  expect(audit()).toBe("[]");
  expect(readdirSync(dir).filter((k) => k.startsWith("."))).toEqual([]);
});
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
