import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { CHECK_OUTPUT_LIMIT, createMergeCheckLog } from "./merge-gate-log.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cg-gate-log-"));
  roots.push(root);
  return root;
}
const passed = {
  status: "passed" as const,
  checks: [
    { name: "test", status: "passed" as const, exit_code: 0, duration_ms: 1 },
  ],
  cleanup_errors: [],
};
test("logs redact configured values across chunks and retained edges before writing private files", async () => {
  const dataDir = await fixture(),
    secret = "private-env-value:abc/xyz";
  const log = await createMergeCheckLog({
    dataDir,
    project: "p",
    attempt: "attempt-1",
    env: { API_KEY: secret },
  });
  const path = join(dataDir, "merge-gate/logs/p", log.log_ref);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect((await stat(join(dataDir, "merge-gate/logs/p"))).mode & 0o777).toBe(
    0o700,
  );
  log.append(
    "test",
    `start\n${"x".repeat(CHECK_OUTPUT_LIMIT / 2 - 40)}${secret.slice(0, 8)}`,
  );
  log.append(
    "test",
    secret.slice(8) +
      "x".repeat(CHECK_OUTPUT_LIMIT) +
      encodeURIComponent(secret) +
      "\n" +
      Buffer.from(secret).toString("base64") +
      "\nend\n",
  );
  await log.finish(passed);
  const text = await readFile(path, "utf8");
  for (const value of [
    secret,
    encodeURIComponent(secret),
    Buffer.from(secret).toString("base64"),
  ])
    expect(text).not.toContain(value);
  expect(text).toContain("[REDACTED]");
  expect(text).toContain("[中间输出已截断]");
  expect(text).toContain("start\n");
  expect(text).toContain("\nend\n");
  expect(Buffer.byteLength(text)).toBeLessThan(CHECK_OUTPUT_LIMIT + 200);
  await expect(
    createMergeCheckLog({ dataDir, project: "p", attempt: "attempt-1" }),
  ).rejects.toMatchObject({ code: "EEXIST" });
});
test("failure summaries take error lines from the last 40 lines, stay within 20 lines and redact metadata", async () => {
  const dataDir = await fixture(),
    secret = "example-sensitive-token";
  const log = await createMergeCheckLog({
    dataDir,
    project: "p",
    attempt: "failed",
    env: { SECRET: secret },
  });
  log.append(
    "test",
    "FAIL too old\n" +
      Array.from({ length: 50 }, (_, n) => `Error ${n}: ${secret}`).join("\n") +
      "\nAuthorization: Bearer opaque-value\n-----BEGIN PRIVATE KEY-----\nprivate-key-bytes\n-----END PRIVATE KEY-----\n",
  );
  const result = await log.finish({
    status: "failed",
    checks: [
      { name: "test", status: "failed", exit_code: 1, duration_ms: 10 },
      { name: "later", status: "not_run" },
    ],
    cleanup_errors: [secret],
    reason: secret,
  });
  expect(result.summary.split("\n").length).toBeLessThanOrEqual(20);
  expect(result.summary).toContain("退出码 1");
  expect(result.summary).not.toContain("too old");
  expect(JSON.stringify(result)).not.toContain(secret);
  const text = await readFile(
    join(dataDir, "merge-gate/logs/p", result.log_ref),
    "utf8",
  );
  for (const value of [secret, "opaque-value", "private-key-bytes"])
    expect(text).not.toContain(value);
  expect(text).toContain("later");
  expect(text).toContain("清理提示");
  expect(text).toContain("未输出内容");
});
test("retention removes only old project logs, and unsafe paths or links are rejected", async () => {
  const dataDir = await fixture();
  for (const project of ["p", "q"]) {
    const initial = await createMergeCheckLog({
      dataDir,
      project,
      attempt: "initial",
    });
    await initial.finish(passed);
  }
  const directory = join(dataDir, "merge-gate/logs/p");
  for (let n = 0; n < 51; n++) {
    const file = join(directory, `old-${String(n).padStart(2, "0")}.log`);
    await writeFile(file, "old", { mode: 0o600 });
    await utimes(file, n + 1, n + 1);
  }
  const latest = await createMergeCheckLog({
    dataDir,
    project: "p",
    attempt: "latest",
  });
  await latest.finish(passed);
  const names = await readdir(directory);
  expect(names).toHaveLength(50);
  expect(names).not.toContain("old-00.log");
  expect(names).toContain("latest.log");
  expect(await readdir(join(dataDir, "merge-gate/logs/q"))).toEqual([
    "initial.log",
  ]);
  await expect(
    createMergeCheckLog({ dataDir, project: "../p", attempt: "x" }),
  ).rejects.toThrow();
  const target = join(dataDir, "keep");
  await writeFile(target, "keep");
  await symlink(target, join(directory, "linked.log"));
  await expect(
    createMergeCheckLog({ dataDir, project: "p", attempt: "linked" }),
  ).rejects.toThrow();
  expect(await readFile(target, "utf8")).toBe("keep");
  await chmod(directory, 0o777);
  await expect(
    createMergeCheckLog({ dataDir, project: "p", attempt: "unsafe" }),
  ).rejects.toThrow(/private/);
});

test("short env values do not corrupt output; the eight-byte boundary and multibyte values are redacted", async () => {
  const dataDir = await fixture();
  const log = await createMergeCheckLog({
    dataDir,
    project: "p",
    attempt: "short-env",
    env: {
      CI: "1",
      MODE: "a",
      SHORT: "abcdefg",
      EMPTY: "",
      ASCII: "abcdefgh",
      UNICODE: "中文值",
    },
  });
  log.append("test", "FAIL a command returned 1\nabcdefg\nabcdefgh\n中文值\n");
  const result = await log.finish({
    status: "failed",
    checks: [{ name: "test", status: "failed", exit_code: 1 }],
    cleanup_errors: [],
  });
  const text = await readFile(
    join(dataDir, "merge-gate/logs/p", log.log_ref),
    "utf8",
  );
  expect(text).toContain(
    "FAIL a command returned 1\nabcdefg\n[REDACTED]\n[REDACTED]\n",
  );
  expect(result.summary).toContain("FAIL a command returned 1");
  expect(text).not.toContain("abcdefgh");
  expect(text).not.toContain("中文值");
});
test.each([
  [
    "interrupted",
    "临时工作区建好之前已取消",
    [],
    "合并检查已取消：临时工作区建好之前已取消",
  ],
  [
    "failed",
    "Temporary checkout failed",
    ["Could not remove temporary worktree registration"],
    "合并检查未通过：Temporary checkout failed",
  ],
] as const)(
  "%s results before any check summarise as cancellation or failure",
  async (status, reason, cleanup_errors, summary) => {
    const dataDir = await fixture();
    const log = await createMergeCheckLog({
      dataDir,
      project: "p",
      attempt: status,
    });
    const result = await log.finish({
      status,
      checks: [{ name: "test", status: "not_run" }],
      cleanup_errors: [...cleanup_errors],
      reason,
    });
    expect(result.summary).toBe(summary);
    const text = await readFile(
      join(dataDir, "merge-gate/logs/p", result.log_ref),
      "utf8",
    );
    expect(text).toContain(`\n${summary}\n`);
    if (cleanup_errors.length)
      expect(text).toContain(
        "\n清理提示：\nCould not remove temporary worktree registration\n",
      );
    else expect(text).not.toContain("清理提示");
  },
);
