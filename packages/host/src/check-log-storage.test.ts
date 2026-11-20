import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createMergeCheckLog } from "./merge-gate-log.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
async function setup() {
  const dataDir = await fs.mkdtemp(join(tmpdir(), "cg-check-storage-"));
  roots.push(dataDir);
  const writer = (attempt: string) =>
    createMergeCheckLog({ dataDir, attempt, project: "p" });
  return { writer, directory: join(dataDir, "merge-gate/logs/p") };
}
const passed = {
  status: "passed" as const,
  checks: [{ name: "test", status: "passed" as const }],
  cleanup_errors: [],
};
test("two completed attempts can unlink the same expired log without turning either check into a failure", async () => {
  const { writer, directory } = await setup();
  const [a, b] = await Promise.all([writer("a"), writer("b")]);
  for (let i = 0; i < 50; i++) {
    const p = join(directory, `old-${i}.log`);
    await fs.writeFile(p, "old", { mode: 0o600 });
    await fs.utimes(p, i + 1, i + 1);
  }
  const unlink = fs.unlink;
  const both = Promise.withResolvers<void>();
  let arrivals = 0;
  vi.spyOn(fs, "unlink").mockImplementation(async (p) => {
    if (String(p).endsWith("old-0.log")) {
      if (++arrivals === 2) both.resolve();
      await both.promise;
    }
    await unlink(p);
  });
  const saved = await Promise.all([a.finish(passed), b.finish(passed)]);
  expect(arrivals).toBe(2);
  for (const s of saved) expect(s.summary).toBe("检查全部通过");
  expect(await fs.readdir(directory)).toHaveLength(50);
});
test("a failed atomic replace retries locally with the whole original output", async () => {
  const { writer, directory } = await setup();
  const w = await writer("retry");
  w.append("test", "first step body\n");
  w.append("next", "next step body\n");
  const failure = Object.assign(new Error("private path"), { code: "EIO" });
  const rename = vi.spyOn(fs, "rename").mockRejectedValueOnce(failure);
  const result = await w.finish(passed);
  expect(rename).toHaveBeenCalledTimes(2);
  expect(result.summary).toBe("检查全部通过");
  const body = await fs.readFile(join(directory, result.log_ref), "utf8");
  expect(body).toContain("first step body");
  expect(body).toContain("next step body");
  expect(await fs.readdir(directory)).toEqual([result.log_ref]);
});
test("cleanup faults are diagnostic but unsafe destination permissions remain fatal", async () => {
  const { writer, directory } = await setup();
  const [a, b] = await Promise.all([writer("ok"), writer("unsafe")]);
  vi.spyOn(fs, "readdir").mockRejectedValueOnce(
    Object.assign(new Error("private path"), { code: "EACCES" }),
  );
  const result = await a.finish(passed);
  expect(result.status).toBe("passed");
  expect(result.summary).toContain("旧日志清理未完成");
  expect(result.summary).not.toContain("private path");
  await fs.chmod(join(directory, b.log_ref), 0o644);
  await expect(b.finish(passed)).rejects.toThrow("Unsafe");
});
