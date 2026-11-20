import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { extMessageQuiet, loadExtMessageConfig } from "./ext-message-config.js";

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ext-config-"));
  path = join(dir, "ext-message.yaml");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const config = (extra = "") =>
  `enabled: true\nworkbench_url: https://workbench.invalid\nchannels:\n  fake:\n    enabled: true\n    credential_file: secret\n${extra}`;
const write = (text: string) => {
  writeFileSync(path, text, { mode: 0o600 });
};
test("missing is disabled; private config and secret files load without persisting or printing their contents", () => {
  expect(loadExtMessageConfig(path)).toEqual({ status: "missing" });
  write(config());
  writeFileSync(join(dir, "secret"), "SYNTHETIC_SECRET", { mode: 0o600 });
  const loaded = loadExtMessageConfig(path);
  expect(loaded).toMatchObject({
    status: "loaded",
    config: {
      enabled: true,
      channels: { fake: { credential: "SYNTHETIC_SECRET" } },
      policy: {
        timeout_ms: 10000,
        max_attempts: 3,
        retry_delays_ms: [30000, 60000],
        title_limit: 120,
        digest_limit: 20,
      },
    },
  });
  chmodSync(join(dir, "secret"), 0o640);
  expect(loadExtMessageConfig(path)).toEqual({ status: "invalid" });
});
test("world-readable configs and symlinks are rejected before parse", () => {
  write("enabled: false");
  chmodSync(path, 0o644);
  expect(loadExtMessageConfig(path)).toEqual({ status: "invalid" });
  chmodSync(path, 0o600);
  symlinkSync(path, join(dir, "link"));
  expect(loadExtMessageConfig(join(dir, "link"))).toEqual({
    status: "invalid",
  });
});
test.each([
  "policy: { timeout_ms: 0 }",
  "policy: { max_attempts: 2 }",
  "policy: { retry_delays_ms: [30, -1] }",
  "quiet_hours: { enabled: true, start: '22:00', end: '08:00' }",
  "workbench_url: https://user:SECRET@workbench.invalid",
  "workbench_url: https://workbench.invalid/?token=SECRET",
  "channels: { fake: { enabled: true, credential_file: missing } }",
])("invalid values fail closed without echo: %s", (extra) => {
  write(`enabled: true\nworkbench_url: https://workbench.invalid\n${extra}\n`);
  expect(loadExtMessageConfig(path)).toEqual({ status: "invalid" });
});
test("disabled config does not read referenced credentials; explicit quiet timezone and bounds work", () => {
  write(config().replace("enabled: true", "enabled: false"));
  expect(loadExtMessageConfig(path)).toMatchObject({
    status: "loaded",
    config: { enabled: false },
  });
  write(
    "enabled: true\nworkbench_url: https://workbench.invalid\nquiet_hours: { enabled: true, timezone: Asia/Shanghai, start: '22:00', end: '08:00' }\npolicy: { timeout_ms: 50, max_attempts: 1, retry_delays_ms: [], title_limit: 10, digest_limit: 2 }",
  );
  const c = loadExtMessageConfig(path);
  expect(c.status).toBe("loaded");
  if (c.status !== "loaded") return;
  expect(extMessageQuiet(c.config, "2026-01-01T14:00:00.000Z")).toBe(true);
  expect(extMessageQuiet(c.config, "2026-01-02T00:00:00.000Z")).toBe(false);
});

const syntheticWebhook =
  "https://open.feishu.cn/open-apis/bot/v2/hook/synthetic-only";
test("enabled lark validates its private JSON credential; disabled channels do not open it", () => {
  const yaml =
    "enabled: true\nworkbench_url: https://workbench.invalid\nchannels: { lark: { enabled: true, credential_file: lark.json } }";
  write(yaml);
  writeFileSync(
    join(dir, "lark.json"),
    JSON.stringify({
      webhook: syntheticWebhook,
      secret: "SYNTHETIC_SIGNING_SECRET",
    }),
    { mode: 0o600 },
  );
  expect(loadExtMessageConfig(path)).toMatchObject({
    status: "loaded",
    config: { channels: { lark: { enabled: true } } },
  });
  writeFileSync(join(dir, "lark.json"), "invalid SYNTHETIC_SIGNING_SECRET");
  expect(loadExtMessageConfig(path)).toEqual({ status: "invalid" });
  write(yaml.replace("lark: { enabled: true", "lark: { enabled: false"));
  expect(loadExtMessageConfig(path)).toMatchObject({ status: "loaded" });
});
test.each([
  "http://open.feishu.cn/open-apis/bot/v2/hook/synthetic-only",
  "https://user:secret@open.feishu.cn/open-apis/bot/v2/hook/synthetic-only",
  "https://open.feishu.cn.attacker.invalid/open-apis/bot/v2/hook/synthetic-only",
  "https://open.feishu.cn/open-apis/bot/v2/hook/synthetic-only?secret=synthetic",
  "https://open.feishu.cn/open-apis/bot/v2/hook/synthetic-only#fragment",
  "https://open.feishu.cn:8443/open-apis/bot/v2/hook/synthetic-only",
])("invalid webhook fails closed without disclosure: %s", (webhook) => {
  write(
    `enabled: true\nworkbench_url: https://workbench.invalid\nchannels:\n  lark:\n    enabled: true\n    credential: '${JSON.stringify({ webhook })}'`,
  );
  expect(loadExtMessageConfig(path)).toEqual({ status: "invalid" });
});
test.each([
  ["Asia/Shanghai", "22:00", "08:00", "2026-01-01T13:59:59Z", false],
  ["Asia/Shanghai", "22:00", "08:00", "2026-01-01T14:00:00Z", true],
  ["Asia/Shanghai", "22:00", "08:00", "2026-01-01T16:00:00Z", true],
  ["Asia/Shanghai", "22:00", "08:00", "2026-01-01T23:59:59Z", true],
  ["Asia/Shanghai", "22:00", "08:00", "2026-01-02T00:00:00Z", false],
  ["UTC", "12:00", "13:00", "2026-01-01T12:00:00Z", true],
  ["UTC", "12:00", "13:00", "2026-01-01T13:00:00Z", false],
  ["America/New_York", "22:00", "08:00", "2026-03-08T11:59:59Z", true],
  ["America/New_York", "22:00", "08:00", "2026-03-08T12:00:00Z", false],
  ["America/New_York", "22:00", "08:00", "2026-11-01T12:59:59Z", true],
  ["America/New_York", "22:00", "08:00", "2026-11-01T13:00:00Z", false],
] as const)(
  "quiet interval uses explicit zone %s %s-%s at %s",
  (timezone, start, end, now, quiet) => {
    write(
      `enabled: false\nquiet_hours: { enabled: true, timezone: ${timezone}, start: '${start}', end: '${end}' }`,
    );
    const c = loadExtMessageConfig(path);
    if (c.status !== "loaded") throw new Error("Expected valid fixture");
    expect(extMessageQuiet(c.config, now)).toBe(quiet);
  },
);

test("an unreadable private application secret never disables the independent old channel or leaks its contents", () => {
  write(
    `enabled: true\nworkbench_url: https://workbench.invalid\nchannels:\n  lark: {enabled: true, credential: '${JSON.stringify({ webhook: syntheticWebhook })}'}\n  lark_app: {enabled: true, credential_file: private}\n`,
  );
  writeFileSync(join(dir, "private"), "SYNTHETIC_PRIVATE", { mode: 0o644 });
  const c = loadExtMessageConfig(path);
  expect(c).toMatchObject({
    status: "loaded",
    config: {
      channels: { lark: { enabled: true }, lark_app: { enabled: true } },
    },
  });
  expect(JSON.stringify(c)).not.toContain("SYNTHETIC_PRIVATE");
});
