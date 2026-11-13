import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  loadDeploymentConfig,
  parseDeploymentConfig,
} from "./deployment-config.js";

const config = {
  initial_release: "/example/release",
  initial_sha: "a".repeat(40),
  ready_timeout_ms: 1000,
  stop_timeout_ms: 1000,
  build_timeout_ms: 1000,
  poll_interval_ms: 1000,
};
test("bootstrap deployment defaults on; timings are explicit host policy", () => {
  expect(parseDeploymentConfig(config).enabled).toBe(true);
  expect(parseDeploymentConfig({ ...config, enabled: false }).enabled).toBe(
    false,
  );
  for (const patch of [
    { command: "restart" },
    { branch: "unreviewed" },
    { ready_timeout_ms: 0 },
    { stop_timeout_ms: undefined },
    { initial_sha: "main" },
    { initial_release: "relative" },
  ])
    expect(() => parseDeploymentConfig({ ...config, ...patch })).toThrow();
});
test("only a private host config is accepted; errors cannot echo config secrets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cg-deployment-config-"));
  try {
    const path = join(dir, "self-deploy.yaml");
    await writeFile(path, JSON.stringify(config), { mode: 0o600 });
    expect((await loadDeploymentConfig(dir)).enabled).toBe(true);
    await chmod(path, 0o644);
    await expect(loadDeploymentConfig(dir)).rejects.toThrow("无法安全读取");
    await rm(path);
    await writeFile(join(dir, "source"), "token: never-disclose-this\n", {
      mode: 0o600,
    });
    await symlink(join(dir, "source"), path);
    await expect(loadDeploymentConfig(dir)).rejects.not.toThrow(
      "never-disclose-this",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
