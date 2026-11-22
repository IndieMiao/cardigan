import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { loadMergeGateConfig } from "./merge-gate-config.js";
import { executorExecution } from "./merge-gate-executors.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const checks = [{ name: "test", run: "pnpm test" }];
const ci = {
  host: "cardigan-ci",
  identity_file: "ssh/ci.key",
  known_hosts_file: "ssh/ci.known_hosts",
  agent_root: "/srv/cardigan-agent",
};
async function fixture(dataName = "data") {
  const root = await mkdtemp(join(tmpdir(), "cg-gate-executors-"));
  roots.push(root);
  const dataDir = join(root, dataName),
    ssh = join(dataDir, "ssh"),
    configDir = join(root, "config");
  for (const path of [dataDir, ssh, configDir])
    await mkdir(path, { mode: 0o700 });
  for (const name of ["ci.key", "ci.known_hosts"])
    await writeFile(join(ssh, name), "fictional-not-a-key", { mode: 0o600 });
  const save = (value: unknown) =>
    writeFile(join(configDir, "merge-gate.yaml"), JSON.stringify(value), {
      mode: 0o600,
    });
  const load = () =>
    loadMergeGateConfig({ configDir, dataDir, projectIds: ["p", "q"] });
  return { root, dataDir, ssh, configDir, save, load };
}

test("a project referencing an executor gets the parsed target with safe defaults", async () => {
  const f = await fixture();
  await f.save({
    executors: { "cardigan-ci": ci },
    projects: { p: { checks, executor: "cardigan-ci" } },
  });
  const config = await f.load();
  expect(config.errors).toEqual([]);
  expect(config.forProject("p")).toEqual({
    status: "enabled",
    checks: [{ name: "test", run: "pnpm test", timeoutMs: 1800000 }],
    env: {},
    totalTimeoutMs: 3600000,
    executor: {
      name: "cardigan-ci",
      host: "cardigan-ci",
      port: 22,
      user: "agent",
      hostKeyAlias: "cardigan-ci",
      identityFile: join(f.ssh, "ci.key"),
      knownHostsFile: join(f.ssh, "ci.known_hosts"),
      agentRoot: "/srv/cardigan-agent",
      maxConcurrent: 1,
    },
  });
});

test("explicit fields are honored, including concurrency bounds", async () => {
  const f = await fixture();
  await f.save({
    executors: {
      ci2: {
        ...ci,
        host: "ci.tail1234.ts.net",
        port: 2222,
        user: "ci_runner",
        host_key_alias: "cardigan-ci",
        max_concurrent: 16,
      },
    },
    projects: { p: { checks, executor: "ci2" } },
  });
  expect((await f.load()).forProject("p")).toMatchObject({
    status: "enabled",
    executor: {
      host: "ci.tail1234.ts.net",
      port: 2222,
      user: "ci_runner",
      hostKeyAlias: "cardigan-ci",
      maxConcurrent: 16,
    },
  });
});

test("no executor or executor: local is exactly today's behavior, even with executors configured", async () => {
  const f = await fixture();
  await f.save({ projects: { p: { checks } } });
  const legacy = (await f.load()).forProject("p");
  expect(legacy).not.toHaveProperty("executor");
  await f.save({
    executors: { "cardigan-ci": ci },
    projects: { p: { checks }, q: { checks, executor: "local" } },
  });
  const config = await f.load();
  expect(config.errors).toEqual([]);
  expect(config.forProject("p")).toEqual(legacy);
  expect(config.forProject("q")).toEqual(legacy);
  expect(config.forProject("q")).not.toHaveProperty("executor");
});

test.each([
  ["missing", "executor 引用了不存在的执行目标 missing，不会回退到本机"],
  [42, "executor 必须是 local 或 executors 中定义的执行目标名称"],
  ["Bad Name", "executor 必须是 local 或 executors 中定义的执行目标名称"],
])(
  "unknown executor %j blocks only that project with a Chinese reason, never falling back to local",
  async (executor, reason) => {
    const f = await fixture();
    await f.save({
      executors: { "cardigan-ci": ci },
      projects: { p: { checks, executor }, q: { checks } },
    });
    const config = await f.load();
    expect(config.forProject("p")).toEqual({
      status: "invalid",
      reason: `项目 p 的合并闸门无效：${reason}`,
    });
    expect(config.forProject("q").status).toBe("enabled");
  },
);

test.each([
  ["missing file", { identity_file: "ssh/absent.key" }, "identity_file 无效"],
  ["absolute path", { identity_file: "/etc/ssh/key" }, "identity_file 无效"],
  ["escape", { known_hosts_file: "../outside" }, "known_hosts_file 无效"],
  ["symlink", { identity_file: "ssh/link" }, "identity_file 无效"],
  ["hard link", { identity_file: "ssh/hard" }, "identity_file 无效"],
  ["same file", { known_hosts_file: "ssh/ci.key" }, "不能是同一个文件"],
])(
  "unsafe credential (%s) invalidates the executor and the projects referencing it",
  async (_label, override, reason) => {
    const f = await fixture();
    await symlink(join(f.ssh, "ci.key"), join(f.ssh, "link"));
    await writeFile(join(f.root, "outside"), "x", { mode: 0o600 });
    if (_label === "hard link")
      await link(join(f.ssh, "ci.key"), join(f.ssh, "hard"));
    await f.save({
      executors: { "cardigan-ci": { ...ci, ...override } },
      projects: { p: { checks, executor: "cardigan-ci" }, q: { checks } },
    });
    const config = await f.load();
    const p = config.forProject("p");
    expect(p.status).toBe("invalid");
    expect(p.status === "invalid" && p.reason).toContain(
      "执行目标 cardigan-ci 无效",
    );
    expect(p.status === "invalid" && p.reason).toContain(reason);
    expect(p.status === "invalid" && p.reason).toContain("不会回退到本机");
    expect(config.forProject("q").status).toBe("enabled");
    const all = config.errors.join(" ");
    expect(all).toContain(reason);
    expect(all).not.toContain("fictional-not-a-key");
    expect(all).not.toContain(f.dataDir);
  },
);

test.each(["file", "directory", "data-dir"])(
  "insecure %s permissions invalidate the executor",
  async (kind) => {
    const f = await fixture();
    if (kind === "file") await chmod(join(f.ssh, "ci.known_hosts"), 0o640);
    if (kind === "directory") await chmod(f.ssh, 0o750);
    if (kind === "data-dir") await chmod(f.dataDir, 0o755);
    await f.save({
      executors: { "cardigan-ci": ci },
      projects: { p: { checks, executor: "cardigan-ci" } },
    });
    const config = await f.load();
    expect(config.forProject("p").status).toBe("invalid");
    expect(config.errors.join(" ")).toMatch(/0600、目录 0700/u);
  },
);

test("an invalid executor that no project references is still reported but blocks nobody", async () => {
  const f = await fixture();
  await f.save({
    executors: { spare: { ...ci, port: 0 } },
    projects: { p: { checks } },
  });
  const config = await f.load();
  expect(config.forProject("p").status).toBe("enabled");
  expect(config.errors).toEqual([
    "执行目标 spare 无效：port 必须是 1 到 65535 的整数",
  ]);
});

test.each([
  ["host", { host: "-oProxyCommand=evil" }],
  ["host", { host: "ci host" }],
  ["host", { host: "ci\nhost" }],
  ["host", { host: "agent@ci" }],
  ["host", { host: "ci:22" }],
  ["host", { host: "" }],
  ["host", { host: undefined }],
  ["host", { host: 42 }],
  ["host", { host: `${"a".repeat(254)}` }],
  ["user", { user: "-oProxyCommand=evil" }],
  ["user", { user: "ag ent" }],
  ["user", { user: "agent\n" }],
  ["user", { user: "root@x" }],
  ["user", { user: "" }],
  ["host_key_alias", { host_key_alias: "-alias" }],
  ["host_key_alias", { host_key_alias: "a b" }],
  ["port", { port: 0 }],
  ["port", { port: 65536 }],
  ["port", { port: "22" }],
  ["port", { port: 22.5 }],
  ["max_concurrent", { max_concurrent: 0 }],
  ["max_concurrent", { max_concurrent: 17 }],
  ["max_concurrent", { max_concurrent: 1.5 }],
  ["max_concurrent", { max_concurrent: "1" }],
  ["agent_root", { agent_root: undefined }],
  ["agent_root", { agent_root: "/" }],
  ["agent_root", { agent_root: "relative/root" }],
  ["agent_root", { agent_root: "/srv/../etc" }],
  ["agent_root", { agent_root: "/srv/agent/" }],
  ["agent_root", { agent_root: "/srv//agent" }],
  ["agent_root", { agent_root: "/srv/agent root" }],
  ["agent_root", { agent_root: "/srv/$(id)" }],
  ["identity_file", { identity_file: undefined }],
  ["known_hosts_file", { known_hosts_file: undefined }],
  ["不支持的配置字段", { proxy_command: "nc %h %p" }],
])("%s rejects %j with a Chinese reason", async (field, override) => {
  const f = await fixture();
  await f.save({
    executors: { "cardigan-ci": { ...ci, ...override } },
    projects: { p: { checks, executor: "cardigan-ci" } },
  });
  const config = await f.load();
  const p = config.forProject("p");
  expect(p.status).toBe("invalid");
  expect(p.status === "invalid" && p.reason).toContain(field);
  expect(config.errors.join(" ")).not.toContain("evil");
});

test.each([
  ["executors: []\nprojects: {p: {checks: [{name: t, run: 'true'}]}}"],
  ["executors: ci\nprojects: {p: {checks: [{name: t, run: 'true'}]}}"],
  [
    "executors: {local: {host: x}}\nprojects: {p: {checks: [{name: t, run: 'true'}]}}",
  ],
  [
    "executors: {'-evil': {host: x}}\nprojects: {p: {checks: [{name: t, run: 'true'}]}}",
  ],
  [
    "executors: {Upper: {host: x}}\nprojects: {p: {checks: [{name: t, run: 'true'}]}}",
  ],
  ["runners: {}\nprojects: {p: {checks: [{name: t, run: 'true'}]}}"],
])(
  "malformed executors mapping fails the whole file closed: %s",
  async (source) => {
    const f = await fixture();
    await writeFile(join(f.configDir, "merge-gate.yaml"), source, {
      mode: 0o600,
    });
    const config = await f.load();
    expect(config.forProject("p").status).toBe("invalid");
    expect(config.forProject("future").status).toBe("invalid");
    expect(config.errors.join(" ")).not.toContain("-evil");
    expect(config.errors.join(" ")).toContain("所有项目暂停合并");
  },
);

// Control characters in the configured name are already refused by secureCredentialFile;
// U+200B (format character) passes that check and must be caught here.
const sshUnsafe = [" ", "%", "$", '"', "'", "\\", "\u200b"];
test.each(
  sshUnsafe.flatMap((c) =>
    (["identity_file", "known_hosts_file"] as const).map(
      (field) => [field, c] as const,
    ),
  ),
)(
  "%s whose file name contains %j is rejected even though permissions are safe",
  async (field, c) => {
    const f = await fixture();
    const name = `ci${c}x`;
    await writeFile(join(f.ssh, name), "fictional-not-a-key", { mode: 0o600 });
    await f.save({
      executors: { "cardigan-ci": { ...ci, [field]: `ssh/${name}` } },
      projects: { p: { checks, executor: "cardigan-ci" }, q: { checks } },
    });
    const config = await f.load();
    const p = config.forProject("p");
    expect(p).toEqual({
      status: "invalid",
      reason: `项目 p 的合并闸门无效：执行目标 cardigan-ci 无效：${field} 无效：数据目录和文件名的完整路径不能含空白、控制字符、引号、反斜杠、% 或 $，不会回退到本机`,
    });
    expect(config.forProject("q").status).toBe("enabled");
    expect(config.errors.join(" ")).not.toContain(name);
  },
);

test.each(["da ta", "data%h", "data$X", "data'q"])(
  "a data directory ancestor %j that ssh would expand invalidates both credentials",
  async (dataName) => {
    const f = await fixture(dataName);
    await f.save({
      executors: { "cardigan-ci": ci },
      projects: { p: { checks, executor: "cardigan-ci" } },
    });
    const config = await f.load();
    const p = config.forProject("p");
    expect(p.status).toBe("invalid");
    expect(p.status === "invalid" && p.reason).toContain(
      "identity_file 无效：数据目录和文件名的完整路径",
    );
    expect(config.errors.join(" ")).not.toContain(dataName);
  },
);

test("executorExecution targets the executor over agent-ssh and keeps host-side fields of the default execution", async () => {
  const f = await fixture();
  await f.save({
    executors: { "cardigan-ci": { ...ci, port: 2222, user: "runner" } },
    projects: { p: { checks, executor: "cardigan-ci" } },
  });
  const settings = (await f.load()).forProject("p");
  if (settings.status !== "enabled" || !settings.executor)
    throw new Error("expected an executor");
  const base = {
    mode: "agent-ssh",
    dataDir: f.dataDir,
    agentRoot: "/var/lib/cardigan-agent",
    gid: 2001,
    machine: "cardigan-agent",
    identityFile: "/host/agent.key",
    knownHostsFile: "/host/agent.known_hosts",
    agentNice: 10,
  } as const;
  const execution = executorExecution(settings.executor, base);
  expect(execution).toEqual({
    mode: "agent-ssh",
    dataDir: f.dataDir,
    agentRoot: "/srv/cardigan-agent",
    gid: 2001,
    machine: "cardigan-ci",
    identityFile: join(f.ssh, "ci.key"),
    knownHostsFile: join(f.ssh, "ci.known_hosts"),
    host: "cardigan-ci",
    port: 2222,
    user: "runner",
    hostKeyAlias: "cardigan-ci",
    agentNice: 10,
  });
  // The default execution is never modified.
  expect(base.agentRoot).toBe("/var/lib/cardigan-agent");
  const fromLocal = executorExecution(settings.executor, {
    mode: "local",
    dataDir: f.dataDir,
  });
  expect(fromLocal).toMatchObject({
    mode: "agent-ssh",
    dataDir: f.dataDir,
    agentRoot: "/srv/cardigan-agent",
  });
  expect(fromLocal).not.toHaveProperty("agentNice");
});

const shared = (projects: string) =>
  `项目 %s 的合并闸门无效：执行目标 cardigan-ci 被 2 个项目引用（${projects}），一个执行账号只能服务一个项目（Q-208），不会回退到本机；请给每个项目配置独立的执行账号或执行目标`;

test("Q-208: an executor referenced by two projects invalidates both with a Chinese reason, never falling back to local", async () => {
  const f = await fixture();
  await f.save({
    executors: { "cardigan-ci": ci },
    projects: {
      p: { checks, executor: "cardigan-ci" },
      q: { checks, executor: "cardigan-ci" },
    },
  });
  const config = await f.load();
  for (const project of ["p", "q"]) {
    const reason = shared("p、q").replace("%s", project);
    expect(config.forProject(project)).toEqual({ status: "invalid", reason });
    expect(config.errors).toContain(reason);
  }
});

test("Q-208: an unregistered project sharing the executor still blocks the registered one; local and other executors are unaffected", async () => {
  const f = await fixture();
  await f.save({
    executors: { "cardigan-ci": ci, other: ci },
    projects: {
      p: { checks, executor: "cardigan-ci" },
      ghost: { checks, executor: "cardigan-ci" },
      q: { checks, executor: "other" },
    },
  });
  const config = await f.load();
  expect(config.forProject("p")).toEqual({
    status: "invalid",
    reason: shared("p、ghost").replace("%s", "p"),
  });
  expect(config.forProject("q")).toMatchObject({
    status: "enabled",
    executor: { name: "other" },
  });
});

test("Q-208 regression: one project per executor, local and no executor keep loading", async () => {
  const f = await fixture();
  await f.save({
    executors: { "cardigan-ci": ci },
    projects: {
      p: { checks, executor: "cardigan-ci" },
      q: { checks, executor: "local" },
    },
  });
  let config = await f.load();
  expect(config.errors).toEqual([]);
  expect(config.forProject("p")).toMatchObject({
    status: "enabled",
    executor: { name: "cardigan-ci" },
  });
  expect(config.forProject("q")).not.toHaveProperty("executor");
  // Several projects on local (explicit or implicit) never count as sharing.
  await f.save({
    executors: { "cardigan-ci": ci },
    projects: { p: { checks, executor: "local" }, q: { checks } },
  });
  config = await f.load();
  expect(config.errors).toEqual([]);
  expect(config.forProject("p").status).toBe("enabled");
  expect(config.forProject("q").status).toBe("enabled");
});

test("D3: explicit SSH keeps legacy commands; incomplete GitHub fails before credential access", async () => {
  const f = await fixture();
  const load = async (entry: unknown) => {
    await f.save({
      executors: { ci: entry },
      projects: { p: { checks, executor: "ci" } },
    });
    return (await f.load()).forProject("p");
  };
  const legacy = await load(ci);
  const explicit = await load({ ...ci, type: "ssh" });
  if (
    legacy.status !== "enabled" ||
    !legacy.executor ||
    explicit.status !== "enabled" ||
    !explicit.executor
  )
    throw new Error("Missing executor");
  const base = { mode: "local" as const, dataDir: f.dataDir };
  expect(executorExecution(explicit.executor, base)).toEqual(
    executorExecution(legacy.executor, base),
  );
  expect(explicit.executor.type).toBe("ssh");
  expect(legacy.executor).not.toHaveProperty("type");
  expect(await load({ type: "invalid" })).toMatchObject({
    status: "invalid",
    reason: expect.stringContaining("type 必须是 ssh 或 github"),
  });
  expect(await load({ type: "github" })).toMatchObject({
    status: "invalid",
    reason: expect.stringContaining("GitHub 仓库或 workflow 路径无效"),
  });
  const executor = legacy.executor;
  expect(() =>
    executorExecution({ ...executor, type: "github" } as never, base),
  ).toThrow("不能通过 SSH");
});

test("D3: parses GitHub entries with private App key metadata, without reading key bytes or falling back to SSH", async () => {
  const f = await fixture();
  const github = {
    type: "github",
    repo: "fixture/project",
    workflow: ".github/workflows/check.yml",
    app_id: 1,
    installation_id: 2,
    private_key_file: "ssh/ci.key",
    bot_login: "fixture-app[bot]",
    max_concurrent: 2,
  };
  const load = async (override: Record<string, unknown> = {}) => {
    await f.save({
      executors: { github: { ...github, ...override } },
      projects: { p: { checks, executor: "github" }, q: { checks } },
    });
    return f.load();
  };
  const config = await load();
  expect(config.errors).toEqual([]);
  expect(config.forExecutor?.("github")).toMatchObject({
    type: "github",
    repo: github.repo,
  });
  expect(config.forExecutor?.("missing")).toBeUndefined();
  expect(config.forExecutor?.("github")).not.toHaveProperty("scopedChecks");
  expect(
    (await load({ scoped_checks: false })).forExecutor?.("github"),
  ).toEqual(config.forExecutor?.("github"));
  expect(
    (await load({ scoped_checks: true })).forExecutor?.("github"),
  ).toMatchObject({ scopedChecks: true });
  await f.save({ executors: { github }, projects: { p: { checks } } });
  const switched = await f.load();
  expect(switched.forProject("p")).not.toHaveProperty("executor");
  expect(switched.forExecutor?.("github")).toEqual(
    config.forExecutor?.("github"),
  );
  expect(config.forProject("p")).toMatchObject({
    status: "enabled",
    executor: {
      type: "github",
      repo: "fixture/project",
      appId: 1,
      installationId: 2,
      privateKeyFile: join(f.ssh, "ci.key"),
      maxConcurrent: 2,
      pollIntervalMs: 20_000,
      restBudgetPerHour: 2_000,
      waitStartMs: 900_000,
      queueWaitMs: 10_800_000,
      failureExcerptBytes: 4096,
      branchRetentionMs: 604800000,
    },
  });
  expect(
    (await load({ infra_flaky_rules: ["vitest_worker_exit_5_1"] })).forProject(
      "p",
    ),
  ).toMatchObject({
    status: "enabled",
    executor: { infraFlakyRules: ["vitest_worker_exit_5_1"] },
  });
  for (const override of [
    { scoped_checks: "true" },
    { scoped_checks: 1 },
    { repo: "https://evil/x" },
    { workflow: "../check.yml" },
    { workflow: ".github/workflows/../check.yml" },
    { bot_login: "human" },
    { app_id: 0 },
    { installation_id: 1.5 },
    { max_concurrent: 17 },
    { private_key_file: "../outside" },
    { host: "ssh.invalid" },
    { poll_interval_ms: 0 },
    { rest_budget_per_hour: 1.5 },
    { wait_start_ms: -1 },
    { queue_wait_ms: 0 },
    { queue_wait_ms: 1.5 },
    { queue_wait_ms: 2147483648 },
    { queue_wait_ms: "10800000" },
    { failure_excerpt_bytes: 4097 },
    { branch_retention_ms: 0 },
    { branch_retention_ms: 1.5 },
    { branch_retention_ms: "604800000" },
    { step_contract: { steps: ["install"] } },
    { step_contract: { steps: [], post_steps: [] } },
    { step_contract: "Run actions/checkout" },
  ]) {
    const invalid = await load(override);
    expect(invalid.forExecutor?.("github")).toBeUndefined();
    expect(invalid.forProject("p").status).toBe("invalid");
    expect(invalid.forProject("q").status).toBe("enabled");
    expect(JSON.stringify(invalid.errors)).not.toContain("ssh/ci.key");
  }
  expect(
    (
      await load({
        poll_interval_ms: 30_000,
        rest_budget_per_hour: 1000,
        wait_start_ms: 600_000,
        queue_wait_ms: 7_200_000,
        failure_excerpt_bytes: 1024,
        branch_retention_ms: 86400000,
      })
    ).forProject("p"),
  ).toMatchObject({
    executor: {
      pollIntervalMs: 30_000,
      restBudgetPerHour: 1000,
      waitStartMs: 600_000,
      queueWaitMs: 7_200_000,
      failureExcerptBytes: 1024,
      branchRetentionMs: 86400000,
    },
  });
  expect(config.forExecutor?.("github")).not.toHaveProperty("stepContract");
  expect(
    (
      await load({
        step_contract: {
          steps: [
            "Initialize containers",
            { uses: "actions/checkout" },
            "install",
            "build",
            "test",
            "lint",
            "deps",
            "e2e",
          ],
          post_steps: [{ uses: "actions/checkout" }, "Stop containers"],
        },
      })
    ).forProject("p"),
  ).toMatchObject({
    status: "enabled",
    executor: {
      stepContract: {
        steps: expect.arrayContaining([{ uses: "actions/checkout" }]),
        postSteps: [{ uses: "actions/checkout" }, { name: "Stop containers" }],
      },
    },
  });
  await chmod(join(f.ssh, "ci.key"), 0o644);
  expect((await load()).forProject("p").status).toBe("invalid");
});

test.each([[], ["vitest_worker_exit_5_1"]].map((lines) => ({ lines })))(
  "A1b: explicit reviewed log lines are preserved: %j",
  async ({ lines }) => {
    const f = await fixture();
    await f.save({
      executors: { ci: { ...ci, infra_flaky_rules: lines } },
      projects: { p: { checks, executor: "ci" } },
    });
    expect((await f.load()).forProject("p")).toMatchObject({
      status: "enabled",
      executor: { infraFlakyRules: lines },
    });
  },
);
test.each([
  "vitest_worker_exit_5_1",
  [""],
  ["FAIL\nassertion"],
  [" leading"],
  [42],
])("A1b: malformed log allowlists fail closed: %j", async (lines) => {
  const f = await fixture();
  await f.save({
    executors: { ci: { ...ci, infra_flaky_rules: lines } },
    projects: { p: { checks, executor: "ci" } },
  });
  expect((await f.load()).forProject("p")).toMatchObject({ status: "invalid" });
});

test.each(["infra_flaky_lines", "infra_flaky_rules"])(
  "Q-647/Q-649: arbitrary literal classes cannot be enabled via %s",
  async (field) => {
    const f = await fixture();
    await f.save({
      executors: {
        ci: {
          ...ci,
          [field]: [
            "[ERR_PNPM_META_FETCH_FAIL] GET https://registry.npmjs.org/p: fetch failed",
          ],
        },
      },
      projects: { p: { checks, executor: "ci" } },
    });
    expect((await f.load()).forProject("p")).toMatchObject({
      status: "invalid",
    });
  },
);
