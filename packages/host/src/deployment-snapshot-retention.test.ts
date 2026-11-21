import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { previewDeploymentSnapshots } from "./deployment-snapshot-retention.js";

test("snapshot preview reports only old automatic files; protects latest N, last per local day, and the recovery backup", async () => {
  const root = await mkdtemp(join(tmpdir(), "cg-snapshot-plan-"));
  const name = (day: number, hour: number) =>
    `database-00000000-0000-4000-8000-${String(day * 100 + hour).padStart(12, "0")}.bak`;
  const now = new Date(2026, 10, 20, 18);
  const backup = async (day: number, hour: number) => {
    const path = join(root, name(day, hour)),
      time = new Date(2026, 10, day, hour);
    await writeFile(path, "backup", { mode: 0o600 });
    await utimes(path, time, time);
  };
  try {
    for (const day of [13, 14, 19, 20])
      for (const hour of [1, 2, 3]) await backup(day, hour);
    await backup(21, 1); // A future timestamp cannot displace a known recent snapshot.
    for (const sub of ["backup-manual", "backups"]) {
      await mkdir(join(root, sub));
      await writeFile(join(root, sub, name(1, 1)), "manual", { mode: 0o600 });
    }
    await symlink(
      join(root, "backup-manual", name(1, 1)),
      join(root, name(1, 1)),
    );
    await writeFile(join(root, "database-manual.bak"), "manual", {
      mode: 0o600,
    });
    const report = await previewDeploymentSnapshots(root, name(13, 1), { now });
    // Five newest: all three on the 20th and two on the 19th. The last on the 14th is protected separately.
    expect(report.candidates.map((f) => f.name)).toEqual([
      name(19, 1),
      name(14, 2),
      name(14, 1),
      name(13, 3),
      name(13, 2),
    ]);
    expect(report.total_bytes).toBe(30);
    expect(await readFile(join(root, name(13, 2)), "utf8")).toBe("backup");
    const custom = await previewDeploymentSnapshots(root, undefined, {
      now,
      latest: 1,
      days: 1,
    });
    expect(custom.candidates).toHaveLength(11);
    await expect(
      previewDeploymentSnapshots(root, undefined, { latest: -1 }),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
