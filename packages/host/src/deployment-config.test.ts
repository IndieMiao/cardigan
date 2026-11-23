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
test("evidence attention defaults to the approved ten minutes and accepts only bounded positive milliseconds", () => {
  expect(parseDeploymentConfig(config).evidence_wait_timeout_ms).toBe(600000);
  expect(
    parseDeploymentConfig({ ...config, evidence_wait_timeout_ms: 42 })
      .evidence_wait_timeout_ms,
  ).toBe(42);
  for (const value of [0, -1, 0.5, null, "600000", NaN, Infinity, 2147483648])
    expect(() =>
      parseDeploymentConfig({ ...config, evidence_wait_timeout_ms: value }),
    ).toThrow();
});
test("server logs are opt-in and require a complete, finite retention budget", () => {
  expect(parseDeploymentConfig(config).server_log_max_bytes).toBeUndefined();
  expect(
    parseDeploymentConfig({
      ...config,
      server_log_max_bytes: 16,
      server_log_max_files: 2,
    }),
  ).toMatchObject({ server_log_max_bytes: 16, server_log_max_files: 2 });
  for (const value of [
    0,
    -1,
    1.5,
    Infinity,
    NaN,
    "16",
    null,
    undefined,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    for (const key of ["server_log_max_bytes", "server_log_max_files"])
      expect(() =>
        parseDeploymentConfig({
          ...config,
          server_log_max_bytes: 16,
          server_log_max_files: 2,
          [key]: value,
        }),
      ).toThrow();
  }
  expect(() =>
    parseDeploymentConfig({
      ...config,
      server_log_max_bytes: Number.MAX_SAFE_INTEGER,
      server_log_max_files: 2,
    }),
  ).toThrow();
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

test("capacity wait reminder has a configurable default and never accepts invalid timeouts", () => {
  expect(parseDeploymentConfig(config).capacity_wait_timeout_ms).toBe(600000);
  expect(
    parseDeploymentConfig({ ...config, capacity_wait_timeout_ms: 42 })
      .capacity_wait_timeout_ms,
  ).toBe(42);
  for (const value of [0, -1, 1.5, NaN, Infinity, "42", null, 2147483648])
    expect(() =>
      parseDeploymentConfig({ ...config, capacity_wait_timeout_ms: value }),
    ).toThrow();
});

test("C-609: batching and operation waits default to 5 and 15 minutes; 0 turns each off", () => {
  expect(parseDeploymentConfig(config)).toMatchObject({
    batch_window_ms: 300000,
    operation_wait_timeout_ms: 900000,
  });
  expect(
    parseDeploymentConfig({
      ...config,
      batch_window_ms: 0,
      operation_wait_timeout_ms: 0,
    }),
  ).toMatchObject({ batch_window_ms: 0, operation_wait_timeout_ms: 0 });
  for (const key of ["batch_window_ms", "operation_wait_timeout_ms"])
    for (const value of [-1, 1.5, NaN, Infinity, "42", null, 2147483648])
      expect(() =>
        parseDeploymentConfig({ ...config, [key]: value }),
      ).toThrow();
});

test("disk warning uses a strict private percent, defaulting to 15", () => {
  expect(parseDeploymentConfig(config).disk_low_percent).toBe(15);
  expect(
    parseDeploymentConfig({ ...config, disk_low_percent: 20 }).disk_low_percent,
  ).toBe(20);
  for (const disk_low_percent of [0, 101, -1, null, "15", 2.5])
    expect(() =>
      parseDeploymentConfig({ ...config, disk_low_percent }),
    ).toThrow();
});
