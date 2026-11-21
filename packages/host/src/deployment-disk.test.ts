import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { DeploymentDiskMonitor } from "./deployment-disk.js";

test("strict threshold, durable deduplication and rearm after recovery, never authorize cleanup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cg-disk-"));
  const store = Store.open({ dataDir: dir, dbPath: ":memory:" });
  const usage = { blocks: 1000n, bavail: 150n };
  const sample = vi.fn(async () => usage);
  const create = () => new DeploymentDiskMonitor(store, dir, undefined, sample);
  const types = () =>
    store.uow.read((tx) =>
      tx.events
        .listAfter("cardigan", undefined, 0)
        .map((e) => e.type)
        .filter((t) => t.startsWith("host_disk_space_")),
    );
  try {
    store.createProject({ id: "cardigan" });
    const monitor = create();
    await monitor.poll(0);
    await monitor.poll(1);
    expect(sample).toHaveBeenCalledTimes(1);
    expect(types()).toEqual([]);
    usage.bavail = 149n;
    await monitor.poll(60_000);
    await create().poll(60_001);
    expect(types()).toEqual(["host_disk_space_low"]);
    usage.blocks = 0n;
    await expect(monitor.poll(120_000)).rejects.toThrow();
    usage.blocks = 1000n;
    await monitor.poll(180_000);
    expect(types()).toEqual(["host_disk_space_low"]);
    usage.bavail = 150n;
    await monitor.poll(240_000);
    usage.bavail = 0n;
    await create().poll(240_001);
    expect(types()).toEqual([
      "host_disk_space_low",
      "host_disk_space_recovered",
      "host_disk_space_low",
    ]);
    expect(store.uow.read((tx) => tx.human_actions.list("cardigan"))).toEqual(
      [],
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
