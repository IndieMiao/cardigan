import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { Store } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import {
  HostMemoryPressureMonitor,
  linuxPressureProbe,
  type PressureDetails,
  type PressureUsage,
  pressureNotice,
} from "./host-memory-pressure.js";

const G = 1024 ** 3;
const details: PressureDetails = {
  tmp_used_bytes: 14 * G,
  tmp: [
    { path: "/tmp/small", owner: "agent", bytes: 0.2 * G },
    { path: "/tmp/cr-x", owner: "agent", bytes: null },
    { path: "/tmp/build", owner: "agent", bytes: 3 * G },
    { path: "/tmp/zl-cache", owner: "zhang", bytes: 1.8 * G },
    { path: "/tmp/root-only", owner: "root", bytes: null },
  ],
  swap: [
    { pid: 11, name: "node", owner: "agent", bytes: 0.5 * G },
    { pid: 12, name: "vite", owner: "agent", bytes: 1.5 * G },
  ],
};

test("notice lists the largest /tmp entries, unreadable ones by owner and swap users", () => {
  const notice = pressureNotice(
    { tmp_percent: 73.7, swap_percent: 99.7 },
    { tmp: 70, swap: 80 },
    details,
  );
  expect(notice).toContain(
    "主机 /tmp 已用 73.7%（阈值 70%），swap 已用 99.7%（阈值 80%）。",
  );
  expect(notice).toContain(
    "/tmp 占用最大：/tmp/build 3.0G（agent）、/tmp/zl-cache 1.8G（zhang）、/tmp/small 205M（agent）。",
  );
  // The remainder of the measured total is attributed to what could not be read.
  expect(notice).toContain(
    "无法读取或未计完 2 项（agent 1 项、root 1 项），约 9.0G：/tmp/cr-x、/tmp/root-only。",
  );
  expect(notice).toContain(
    "swap 占用最大：vite 1.5G（agent，PID 12）、node 512M（agent，PID 11）。",
  );
});

test("one notice per episode over either threshold, durable across restarts, rearmed after recovery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cg-pressure-"));
  const store = Store.open({ dataDir: dir, dbPath: ":memory:" });
  let usage: PressureUsage = { tmp_percent: 70, swap_percent: 80 };
  const probe = {
    usage: vi.fn(async () => usage),
    details: vi.fn(async () => details),
  };
  const create = () => new HostMemoryPressureMonitor(store, {}, probe);
  const events = () =>
    store.uow.read((tx) =>
      tx.events
        .listAfter("cardigan", undefined, 0)
        .filter((e) => e.type.startsWith("host_memory_pressure")),
    );
  try {
    store.createProject({ id: "cardigan" });
    const monitor = create();
    await monitor.poll(0);
    await monitor.poll(1);
    expect(probe.usage).toHaveBeenCalledTimes(1);
    // Exactly at the thresholds is not over them.
    expect(events()).toEqual([]);
    usage = { tmp_percent: 70.1, swap_percent: 10 };
    await monitor.poll(60_000);
    await create().poll(60_001);
    expect(events().map((e) => e.type)).toEqual(["host_memory_pressure"]);
    expect(events()[0]?.payload).toMatchObject({
      tmp_used_percent: 70.1,
      tmp_threshold_percent: 70,
      swap_threshold_percent: 80,
    });
    expect(String(events()[0]?.payload.notice)).toContain("/tmp/build");
    usage = { tmp_percent: 10, swap_percent: 10 };
    await monitor.poll(120_000);
    usage = { tmp_percent: 10, swap_percent: 80.5 };
    await create().poll(120_001);
    expect(events().map((e) => e.type)).toEqual([
      "host_memory_pressure",
      "host_memory_pressure_recovered",
      "host_memory_pressure",
    ]);
    expect(probe.details).toHaveBeenCalledTimes(2);
    // Configured thresholds replace the defaults.
    usage = { tmp_percent: 85, swap_percent: 85 };
    const custom = new HostMemoryPressureMonitor(
      store,
      { tmp: 90, swap: 90 },
      probe,
    );
    await custom.poll(180_000);
    expect(events().at(-1)?.type).toBe("host_memory_pressure_recovered");
    expect(store.uow.read((tx) => tx.human_actions.list("cardigan"))).toEqual(
      [],
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "linux")(
  "linux probe measures a real directory with owners and reads swap from /proc",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "cg-pressure-probe-"));
    try {
      await mkdir(join(dir, "big"));
      await writeFile(join(dir, "big", "data"), Buffer.alloc(256 * 1024, 1));
      await writeFile(join(dir, "small"), "x");
      const probe = linuxPressureProbe(dir);
      const usage = await probe.usage();
      expect(usage.tmp_percent).toBeGreaterThanOrEqual(0);
      expect(usage.tmp_percent).toBeLessThanOrEqual(100);
      expect(usage.swap_percent).toBeGreaterThanOrEqual(0);
      const found = await probe.details();
      const big = found.tmp.find((e) => e.path === join(dir, "big"));
      expect(big?.owner).toBe(userInfo().username);
      expect(big?.bytes).toBeGreaterThanOrEqual(256 * 1024);
      expect(found.tmp_used_bytes).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
