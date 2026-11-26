import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  checkStepFingerprint,
  loadMergeGateConfig,
} from "./merge-gate-config.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture(source?: unknown) {
  const root = await mkdtemp(join(tmpdir(), "cg-gate-config-"));
  roots.push(root);
  const file = join(root, "merge-gate.yaml");
  if (source !== undefined)
    await writeFile(
      file,
      typeof source === "string" ? source : JSON.stringify(source),
      { mode: 0o600 },
    );
  const load = () =>
    loadMergeGateConfig({
      env: { CARDIGAN_CONFIG_DIR: root },
      projectIds: ["p", "q"],
    });
  return { root, file, load };
}
const valid = { checks: [{ name: "test", run: "pnpm test" }] };
test("missing configuration preserves legacy behavior; enabled projects get bounded defaults and explicit env", async () => {
  const f = await fixture();
  expect((await f.load()).forProject("p")).toEqual({ status: "disabled" });
  await writeFile(
    f.file,
    JSON.stringify({
      projects: {
        p: { ...valid, env: { CHECK_VALUE: "explicit" } },
        q: {
          checks: [{ name: "build", run: "pnpm build", timeout_minutes: 2 }],
          total_timeout_minutes: 5,
        },
      },
    }),
    { mode: 0o600 },
  );
  const config = await f.load();
  expect(config.errors).toEqual([]);
  expect(config.forProject("p")).toStrictEqual({
    status: "enabled",
    checks: [{ name: "test", run: "pnpm test", timeoutMs: 1800000 }],
    env: { CHECK_VALUE: "explicit" },
    totalTimeoutMs: 3600000,
  });
  expect(config.forProject("q")).toStrictEqual({
    status: "enabled",
    totalTimeoutMs: 300000,
    checks: [{ name: "build", run: "pnpm build", timeoutMs: 120000 }],
    env: {},
  });
  expect(config.forProject("unconfigured")).toEqual({ status: "disabled" });
});
test.each([
  { checks: [] },
  { checks: [{ name: "test", run: " " }] },
  { checks: [{ name: "test", run: "true", timeout_minutes: 0 }] },
  { checks: [{ name: "test", run: "true", timeout_minutes: 1.5 }] },
  { ...valid, total_timeout_minutes: "60" },
  { ...valid, total_timeout_minutes: 100000000 },
  { checks: [valid.checks[0], valid.checks[0]] },
  { ...valid, push: { remote: "ignored" } },
  { ...valid, env: { SECRET: false } },
  { ...valid, env: { HOME: "/host" } },
  { ...valid, env: { TMPDIR: "/outside" } },
  { ...valid, env: { HC_SESSION: "production" } },
  { ...valid, env: { CARDIGAN_TOKEN: "sensitive-value" } },
  { ...valid, env: { CARDIGAN_AFFECTED_PATHS: "packages/host" } },
  { ...valid, env: { CARDIGAN_AFFECTED_PATHS: "" } },
])(
  "invalid project config stays blocked without disabling other projects: %j",
  async (bad) => {
    const f = await fixture({ projects: { p: bad, q: valid } }),
      config = await f.load();
    expect(config.forProject("p").status).toBe("invalid");
    expect(config.forProject("q").status).toBe("enabled");
    expect(config.forProject("absent").status).toBe("disabled");
    expect(config.errors.join(" ")).not.toContain("sensitive-value");
  },
);
test.each([
  "projects: [",
  "projects: {}\nprojects: {}",
  "projects: !unknown-tag {p: secret-value}",
  "not_projects: {}",
  "projects: &a {p: *a}",
  "projects: !!set {p: null}",
])(
  "invalid document fails closed, including future projects, without echoing source: %s",
  async (source) => {
    const f = await fixture(source),
      config = await f.load();
    expect(config.forProject("p").status).toBe("invalid");
    expect(config.forProject("future").status).toBe("invalid");
    expect(config.errors.join(" ")).not.toContain("secret-value");
  },
);
test("unknown projects report invalid configuration; symlink or writable configuration fails closed", async () => {
  const f = await fixture({ projects: { missing: valid, p: valid } });
  expect((await f.load()).forProject("missing").status).toBe("invalid");
  await chmod(f.file, 0o666);
  expect((await f.load()).forProject("p").status).toBe("invalid");
  await rm(f.file);
  const other = join(f.root, "other");
  await mkdir(other);
  await writeFile(
    join(other, "config"),
    JSON.stringify({ projects: { p: valid } }),
  );
  await symlink(join(other, "config"), f.file);
  expect((await f.load()).forProject("p").status).toBe("invalid");
});

test("tiered YAML parses optional fields without adding defaults to other steps", async () => {
  const f = await fixture(`projects:
  p:
    checks:
      - name: install
        run: pnpm install --frozen-lockfile
      - name: test
        run: pnpm vitest run $CARDIGAN_AFFECTED_PATHS
        tiers: [card, batch]
        scope: affected
        skip_docs_only: true
      - name: e2e
        run: pnpm test:e2e
        tiers: [batch]
        skip_docs_only: false
    affected:
      extra_dependents:
        packages/domain: [packages/host, apps/server]
        apps/web: [apps/server]
        packages/host: []
`);
  const config = await f.load();
  expect(config.errors).toEqual([]);
  expect(config.forProject("p")).toStrictEqual({
    status: "enabled",
    checks: [
      {
        name: "install",
        run: "pnpm install --frozen-lockfile",
        timeoutMs: 1800000,
      },
      {
        name: "test",
        run: "pnpm vitest run $CARDIGAN_AFFECTED_PATHS",
        timeoutMs: 1800000,
        tiers: ["card", "batch"],
        scope: "affected",
        skipDocsOnly: true,
      },
      {
        name: "e2e",
        run: "pnpm test:e2e",
        timeoutMs: 1800000,
        tiers: ["batch"],
        skipDocsOnly: false,
      },
    ],
    affected: {
      extraDependents: {
        "packages/domain": ["packages/host", "apps/server"],
        "apps/web": ["apps/server"],
        "packages/host": [],
      },
    },
    env: {},
    totalTimeoutMs: 3600000,
  });
});

test.each([{}, { extra_dependents: {} }])(
  "empty affected settings are valid: %j",
  async (affected) => {
    const f = await fixture({ projects: { p: { ...valid, affected } } });
    const config = await f.load();
    expect(config.errors).toEqual([]);
    expect(config.forProject("p")).toMatchObject({
      status: "enabled",
      affected: "extra_dependents" in affected ? { extraDependents: {} } : {},
    });
  },
);

test.each([{ tiers: ["card"] }, { tiers: ["batch", "card"] }])(
  "tier membership is independent of order: %j",
  async (fields) => {
    const f = await fixture({
      projects: { p: { checks: [{ ...valid.checks[0], ...fields }] } },
    });
    const config = await f.load();
    expect(config.errors).toEqual([]);
    expect(config.forProject("p")).toMatchObject({
      status: "enabled",
      checks: [fields],
    });
  },
);

async function expectInvalidProject(project: unknown, reason: string | RegExp) {
  const f = await fixture({ projects: { p: project, q: valid } });
  const config = await f.load();
  expect(config.forProject("p")).toEqual({
    status: "invalid",
    reason: expect.stringMatching(reason),
  });
  expect(config.errors).toEqual([expect.stringMatching(reason)]);
  expect(config.forProject("q").status).toBe("enabled");
  expect(config.forProject("absent").status).toBe("disabled");
}

test.each([
  ...[
    null,
    true,
    1,
    "card",
    {},
    [],
    ["card", "card"],
    ["card", "batch", "card"],
    ["single"],
    ["Card"],
    ["card", null],
    ["card", {}],
  ].map((tiers) => ({ tiers })),
  ...[null, true, 1, "full", "", ["affected"], {}].map((scope) => ({ scope })),
  ...[null, 0, 1, "true", "false", [], {}].map((skip_docs_only) => ({
    skip_docs_only,
  })),
])(
  "invalid tiered step fields block the project with a Chinese reason: %j",
  async (fields) => {
    await expectInvalidProject(
      { checks: [{ ...valid.checks[0], ...fields }] },
      /项目 p 的合并闸门无效：(tiers|scope|skip_docs_only) (必须|只允许)/u,
    );
  },
);

test.each([
  ...[null, true, 1, "affected", []].map((affected) => ({ affected })),
  ...[null, true, 1, "packages/host", []].map((extra_dependents) => ({
    affected: { extra_dependents },
  })),
  ...[null, true, 1, "apps/server", {}, [null], [1], [{}], [[]]].map(
    (dependents) => ({
      affected: { extra_dependents: { "packages/host": dependents } },
    }),
  ),
])(
  "invalid affected shapes block only the configured project: %j",
  async (fields) => {
    await expectInvalidProject(
      { ...valid, ...fields },
      /项目 p 的合并闸门无效：affected(?:\.extra_dependents)? (必须|的键)/u,
    );
  },
);

test.each([
  "",
  "packages",
  "packages/",
  "apps/",
  "../packages/host",
  "/packages/host",
  "packages/../host",
  "packages/host/src",
  "packages/host/",
  "packages\\host",
  "packages/Host",
  "packages/host_name",
  "packages/主机",
  "other/host",
  "packages/host apps/server",
  "packages/host;true",
  "packages/host\n",
  "packages/host\0",
  "__proto__",
])(
  "unsafe package directories are rejected as either keys or dependents: %j",
  async (path) => {
    for (const extra_dependents of [
      { [path]: ["apps/server"] },
      { "packages/host": [path] },
    ]) {
      await expectInvalidProject(
        { ...valid, affected: { extra_dependents } },
        "项目 p 的合并闸门无效：affected.extra_dependents 的键和列表元素必须是 packages/ 或 apps/ 下仅含小写字母、数字、短横线的包目录",
      );
    }
  },
);

test.each([
  { ...valid, unknown: true },
  { checks: [{ ...valid.checks[0], unknown: true }] },
  { ...valid, affected: { unknown: true } },
])(
  "unknown fields remain invalid at every configuration level: %j",
  async (project) => {
    await expectInvalidProject(
      project,
      "项目 p 的合并闸门无效：含有不支持的配置字段",
    );
  },
);

test.each(["1", "a", "1234567", "中文"])(
  "short env values are rejected without echoing them: %s",
  async (value) => {
    const f = await fixture({
      projects: { p: { ...valid, env: { VALUE: value } }, q: valid },
    });
    const config = await f.load();
    expect(config.forProject("p")).toEqual({
      status: "invalid",
      reason:
        "项目 p 的合并闸门无效：env 非空值必须至少 8 个 UTF-8 字节，短值不能可靠脱敏",
    });
    expect(config.forProject("q").status).toBe("enabled");
  },
);
test("the env threshold is UTF-8 bytes, permits empty values and rejects __proto__", async () => {
  const f = await fixture({
    projects: {
      p: { ...valid, env: { EMPTY: "", ASCII: "12345678", UNICODE: "中文值" } },
    },
  });
  expect((await f.load()).forProject("p").status).toBe("enabled");
  await writeFile(
    f.file,
    JSON.stringify({
      projects: { p: { ...valid, env: { ["__proto__"]: "12345678" } } },
    }),
  );
  expect((await f.load()).forProject("p").status).toBe("invalid");
});

test("C-391: queue is opt-in and has bounded, configurable batch and window defaults", async () => {
  const f = await fixture({
    projects: { p: { ...valid, queue: { enabled: true } } },
  });
  expect((await f.load()).forProject("p")).toMatchObject({
    status: "enabled",
    queue: {
      maxBatchSize: 4,
      conflictThreshold: 2,
      windowTimeoutMs: 86_400_000,
      windowHoldLimitMs: 7_200_000,
    },
  });
});
test("C-803: the window hold limit is configurable in minutes and rejects invalid values", async () => {
  const f = await fixture({
    projects: {
      p: { ...valid, queue: { enabled: true, window_hold_minutes: 45 } },
      q: { ...valid, queue: { enabled: true, window_hold_minutes: 0 } },
      r: { ...valid, queue: { enabled: true, window_hold_minutes: "2h" } },
    },
  });
  const config = await f.load();
  expect(config.forProject("p")).toMatchObject({
    queue: { windowHoldLimitMs: 45 * 60_000 },
  });
  for (const project of ["q", "r"])
    expect(config.forProject(project).status).toBe("invalid");
});
test("C-781: precheck reuse defaults on, can be switched off, and rejects non-booleans", async () => {
  const f = await fixture({
    projects: { p: { ...valid, queue: { enabled: true } } },
  });
  const on = (await f.load()).forProject("p");
  expect(on.status === "enabled" && on.queue).toStrictEqual({
    maxBatchSize: 4,
    conflictThreshold: 2,
    windowTimeoutMs: 86_400_000,
    windowHoldLimitMs: 7_200_000,
  });
  await writeFile(
    f.file,
    JSON.stringify({
      projects: {
        p: { ...valid, queue: { enabled: true, reuse_precheck: false } },
        q: { ...valid, queue: { enabled: true, reuse_precheck: "no" } },
      },
    }),
  );
  const config = await f.load();
  expect(config.forProject("p")).toMatchObject({
    queue: { reusePrecheck: false },
  });
  expect(config.forProject("q")).toMatchObject({
    status: "invalid",
    reason: expect.stringContaining("reuse_precheck"),
  });
});
test.each([0, 9, 1.5, "4"])(
  "C-391: rejects invalid max batch size %s",
  async (max_batch_size) => {
    const f = await fixture({
      projects: { p: { ...valid, queue: { enabled: true, max_batch_size } } },
    });
    expect((await f.load()).forProject("p").status).toBe("invalid");
  },
);

test("C-798 a check step fingerprint covers its name, command and timeout only", () => {
  const base = checkStepFingerprint({ name: "test", run: "pnpm test" });
  expect(base).toMatch(/^[a-f0-9]{64}$/u);
  expect(checkStepFingerprint({ name: "test", run: "pnpm test" })).toBe(base);
  for (const changed of [
    { name: "test", run: "pnpm test --changed" },
    { name: "test", run: "pnpm test " },
    { name: "lint", run: "pnpm test" },
    { name: "test", run: "pnpm test", timeoutMs: 60_000 },
  ])
    expect(checkStepFingerprint(changed)).not.toBe(base);
  // Selection metadata is not what the step executes.
  const selected = {
    name: "test",
    run: "pnpm test",
    tiers: ["card" as const],
    scope: "affected" as const,
    skipDocsOnly: true,
    skipReason: "docs_only" as const,
    affectedPaths: ["packages/host"],
  };
  expect(checkStepFingerprint(selected)).toBe(base);
});
