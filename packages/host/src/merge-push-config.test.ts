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
import { loadMergeGateConfig } from "./merge-gate-config.js";
import {
  parseMergePushConfig,
  validateMergePushConfig,
} from "./merge-push-config.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cg-push-config-"));
  roots.push(root);
  const dataDir = join(root, "data"),
    keys = join(dataDir, "keys"),
    configDir = join(root, "config");
  for (const path of [dataDir, keys, configDir])
    await mkdir(path, { mode: 0o700 });
  for (const name of ["key", "known"])
    await writeFile(join(keys, name), "fictional-not-a-key", { mode: 0o600 });
  const push = {
    remote: "git@example.invalid:team/project.git",
    key_file: "keys/key",
    known_hosts_file: "keys/known",
  };
  const save = (value: unknown) =>
    writeFile(
      join(configDir, "merge-gate.yaml"),
      JSON.stringify({
        projects: {
          p: { checks: [{ name: "test", run: "true" }], push: value },
        },
      }),
      { mode: 0o600 },
    );
  const load = () =>
    loadMergeGateConfig({
      configDir,
      dataDir,
      projectIds: ["p"],
      baseBranches: { p: "release" },
    });
  return { root, dataDir, keys, configDir, push, save, load };
}
test("valid push paths are metadata-checked and the default branch follows the registered baseline", async () => {
  const f = await fixture();
  await f.save(f.push);
  const config = await f.load();
  expect(config.errors).toEqual([]);
  expect(config.forProject("p")).toMatchObject({
    status: "enabled",
    push: [
      {
        remote: f.push.remote,
        branch: "release",
        baseBranch: "release",
        keyFile: join(f.keys, "key"),
        knownHostsFile: join(f.keys, "known"),
        target: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    ],
  });
  expect(config.forProject("other")).toEqual({ status: "disabled" });
});
test.each(["keys/link", "../escape", "/absolute/key", "keys/missing"])(
  "unsafe credential %s blocks the configured project in Chinese",
  async (key) => {
    const f = await fixture();
    await symlink(join(f.keys, "key"), join(f.keys, "link"));
    await f.save({ ...f.push, key_file: key });
    const config = await f.load();
    expect(config.forProject("p").status).toBe("invalid");
    expect(config.errors.join(" ")).toContain("push 凭据无效");
    expect(config.errors.join(" ")).not.toContain("fictional-not-a-key");
  },
);
test.each(["file", "directory", "ancestor-link"])(
  "changed permissions/ancestors fail at both configuration and execution time: %s",
  async (kind) => {
    const f = await fixture();
    const parsed = await parseMergePushConfig(f.push, f.dataDir);
    if (kind === "file") await chmod(join(f.keys, "known"), 0o644);
    if (kind === "directory") await chmod(f.keys, 0o750);
    if (kind === "ancestor-link") {
      await rm(f.keys, { recursive: true });
      await symlink(f.configDir, f.keys);
    }
    await f.save(f.push);
    expect((await f.load()).forProject("p").status).toBe("invalid");
    await expect(validateMergePushConfig(parsed, f.dataDir)).rejects.toThrow(
      /凭据无效/,
    );
  },
);
test.each([
  { remote: "https://user:secret@example.invalid/repo" },
  { remote: "ext::command" },
  { remote: "ssh://user:secret@example.invalid/repo" },
  { branch: "main:other" },
  { branch: "-all" },
  { branch: "main.lock" },
  { extra: true },
])(
  "invalid remote/branch/fields never echo raw configuration: %j",
  async (patch) => {
    const f = await fixture();
    await f.save({ ...f.push, ...patch });
    const config = await f.load();
    expect(config.forProject("p").status).toBe("invalid");
    expect(config.errors.join(" ")).not.toContain("secret");
  },
);
test("local file transport needs no key; a branch override remains explicit", async () => {
  const f = await fixture();
  await f.save({
    remote: "file:///fixture/remote.git",
    branch: "topic/release",
  });
  expect((await f.load()).forProject("p")).toMatchObject({
    status: "enabled",
    push: [{ branch: "topic/release", baseBranch: "release" }],
  });
});
test("a push list routes each central baseline branch to its own remote branch", async () => {
  const f = await fixture();
  const single = await parseMergePushConfig(f.push, f.dataDir, "release");
  await f.save([
    f.push,
    { ...f.push, base_branch: "integration/farm" },
    { ...f.push, base_branch: "hotfix", branch: "deploy/hotfix" },
  ]);
  const config = await f.load();
  expect(config.errors).toEqual([]);
  const enabled = config.forProject("p");
  if (enabled.status !== "enabled") throw new Error("Expected enabled");
  expect(enabled.push?.map((r) => [r.baseBranch, r.branch, r.remote])).toEqual([
    ["release", "release", f.push.remote],
    // Without `branch` a route pushes to the remote branch of the same name.
    ["integration/farm", "integration/farm", f.push.remote],
    ["hotfix", "deploy/hotfix", f.push.remote],
  ]);
  // The registered baseline keeps the target of a single-object config, so
  // its existing push history continues.
  expect(enabled.push?.[0]?.target).toBe(single.target);
  expect(new Set(enabled.push?.map((r) => r.target)).size).toBe(3);
});
test.each([
  ["duplicate base branch", [{}, { branch: "other" }], "同一个 base_branch"],
  [
    "two routes to one remote branch",
    [{}, { base_branch: "other", branch: "release" }],
    "同一远程分支",
  ],
  ["empty list", [], "不能为空"],
  ["invalid base branch", [{ base_branch: "a..b" }], "base_branch"],
])("push list rejects %s", async (_name, patches, message) => {
  const f = await fixture();
  await f.save(
    (patches as Record<string, unknown>[]).map((p) => ({ ...f.push, ...p })),
  );
  const config = await f.load();
  expect(config.forProject("p").status).toBe("invalid");
  expect(config.errors.join(" ")).toContain(message);
});
