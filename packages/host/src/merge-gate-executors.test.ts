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
