import { lstat, readdir, readFile, statfs } from "node:fs/promises";
import { join } from "node:path";
import type { Store } from "@cardigan/store";
import {
  DEFAULT_SWAP_HIGH_PERCENT,
  DEFAULT_TMP_HIGH_PERCENT,
} from "./deployment-config.js";

const HIGH = "host_memory_pressure";
const RECOVERED = "host_memory_pressure_recovered";
const TOP = 5;

export interface PressureUsage {
  /** Percent of the /tmp file system in use. */
  readonly tmp_percent: number;
  /** Percent of swap in use; 0 without swap. */
  readonly swap_percent: number;
}

export interface TmpEntry {
  readonly path: string;
  readonly owner: string;
  /** Allocated bytes; null when this account cannot read the whole tree. */
  readonly bytes: number | null;
}

export interface SwapProcess {
  readonly pid: number;
  readonly name: string;
  readonly owner: string;
  readonly bytes: number;
}

export interface PressureDetails {
  readonly tmp: readonly TmpEntry[];
  readonly tmp_used_bytes: number;
  readonly swap: readonly SwapProcess[];
}

export interface PressureProbe {
  usage(): Promise<PressureUsage>;
  details(): Promise<PressureDetails>;
}

async function owners(): Promise<Map<number, string>> {
  const names = new Map<number, string>();
  try {
    for (const line of (await readFile("/etc/passwd", "utf8")).split("\n")) {
      const [name, , uid] = line.split(":");
      if (name && uid && /^\d+$/u.test(uid)) names.set(Number(uid), name);
    }
  } catch {
    /* uid numbers stand in for names */
  }
  return names;
}

/** Allocated bytes of a tree, or null if unreadable or past the shared budget. */
async function treeBytes(
  path: string,
  budget: { nodes: number; deadline: number },
): Promise<number | null> {
  const top = await lstat(path);
  let total = top.blocks * 512;
  if (!top.isDirectory()) return total;
  const stack = [path];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return null;
    }
    for (const name of names) {
      if (--budget.nodes < 0 || Date.now() > budget.deadline) return null;
      try {
        const info = await lstat(join(dir, name));
        total += info.blocks * 512;
        if (info.isDirectory()) stack.push(join(dir, name));
      } catch {
        /* removed meanwhile */
      }
    }
  }
  return total;
}

/** Linux probe for the host account; it reads only metadata. */
export function linuxPressureProbe(tmp = "/tmp"): PressureProbe {
  const swapKb = async () => {
    const text = await readFile("/proc/meminfo", "utf8");
    const value = (key: string) =>
      Number(new RegExp(`^${key}:\\s+(\\d+) kB$`, "mu").exec(text)?.[1] ?? 0);
    return { total: value("SwapTotal"), free: value("SwapFree") };
  };
  return {
    async usage() {
      const fs = await statfs(tmp, { bigint: true });
      if (fs.blocks <= 0n || fs.bfree > fs.blocks)
        throw new Error("Invalid /tmp observation");
      const swap = await swapKb();
      return {
        tmp_percent: Number(((fs.blocks - fs.bfree) * 1000n) / fs.blocks) / 10,
        swap_percent:
          swap.total > 0
            ? Math.round(((swap.total - swap.free) * 1000) / swap.total) / 10
            : 0,
      };
    },
    async details() {
      const names = await owners();
      const owner = (uid: number) => names.get(uid) ?? String(uid);
      // Bounded: a slow, swapping host must not stall the supervisor loop.
      const budget = { nodes: 100_000, deadline: Date.now() + 2_000 };
      const tmpEntries: TmpEntry[] = [];
      for (const name of (await readdir(tmp)).slice(0, 4096)) {
        const path = join(tmp, name);
        try {
          const info = await lstat(path);
          tmpEntries.push({
            path,
            owner: owner(info.uid),
            bytes: await treeBytes(path, budget),
          });
        } catch {
          /* removed meanwhile */
        }
      }
      const fs = await statfs(tmp, { bigint: true });
      const swap: SwapProcess[] = [];
      for (const pid of await readdir("/proc")) {
        if (!/^\d+$/u.test(pid)) continue;
        try {
          const status = await readFile(`/proc/${pid}/status`, "utf8");
          const kb = Number(/^VmSwap:\s+(\d+) kB$/mu.exec(status)?.[1] ?? 0);
          if (kb <= 0) continue;
          swap.push({
            pid: Number(pid),
            name: /^Name:\s+(.*)$/mu.exec(status)?.[1] ?? "?",
            owner: owner(Number(/^Uid:\s+(\d+)/mu.exec(status)?.[1] ?? -1)),
            bytes: kb * 1024,
          });
        } catch {
          /* exited meanwhile */
        }
      }
      return {
        tmp: tmpEntries,
        tmp_used_bytes: Number((fs.blocks - fs.bfree) * BigInt(fs.bsize)),
        swap,
      };
    },
  };
}

const size = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)}G`
    : `${Math.max(1, Math.round(bytes / 1024 ** 2))}M`;

/** The notice names the largest /tmp entries and swap users with owners. */
export function pressureNotice(
  usage: PressureUsage,
  thresholds: { tmp: number; swap: number },
  details: PressureDetails,
): string {
  const measured = details.tmp
    .filter((e): e is TmpEntry & { bytes: number } => e.bytes !== null)
    .sort((a, b) => b.bytes - a.bytes);
  const unreadable = details.tmp.filter((e) => e.bytes === null);
  const byOwner = new Map<string, number>();
  for (const e of unreadable)
    byOwner.set(e.owner, (byOwner.get(e.owner) ?? 0) + 1);
  const rest = Math.max(
    0,
    details.tmp_used_bytes - measured.reduce((sum, e) => sum + e.bytes, 0),
  );
  const parts = [
    `主机 /tmp 已用 ${usage.tmp_percent}%（阈值 ${thresholds.tmp}%），swap 已用 ${usage.swap_percent}%（阈值 ${thresholds.swap}%）。`,
  ];
  if (measured.length > 0)
    parts.push(
      `/tmp 占用最大：${measured
        .slice(0, TOP)
        .map((e) => `${e.path} ${size(e.bytes)}（${e.owner}）`)
        .join("、")}。`,
    );
  if (unreadable.length > 0)
    parts.push(
      `无法读取或未计完 ${unreadable.length} 项（${[...byOwner]
        .sort((a, b) => b[1] - a[1])
        .map(([o, n]) => `${o} ${n} 项`)
        .join("、")}），约 ${size(rest)}：${unreadable
        .slice(0, TOP)
        .map((e) => e.path)
        .join("、")}${unreadable.length > TOP ? " 等" : ""}。`,
    );
  const swap = [...details.swap].sort((a, b) => b.bytes - a.bytes);
  if (swap.length > 0)
    parts.push(
      `swap 占用最大：${swap
        .slice(0, TOP)
        .map((p) => `${p.name} ${size(p.bytes)}（${p.owner}，PID ${p.pid}）`)
        .join("、")}。`,
    );
  return parts.join("");
}

/** One nonblocking notice per episode over either threshold, also across restarts. */
export class HostMemoryPressureMonitor {
  private next = 0;
  private lastHigh?: boolean;
  private readonly thresholds: { tmp: number; swap: number };

  constructor(
    private readonly store: Store,
    thresholds: { tmp?: number | undefined; swap?: number | undefined } = {},
    private readonly probe: PressureProbe = linuxPressureProbe(),
    /** First sample time; the supervisor waits a minute after start. */
    firstPollAt = 0,
  ) {
    this.next = firstPollAt;
    this.thresholds = {
      tmp: thresholds.tmp ?? DEFAULT_TMP_HIGH_PERCENT,
      swap: thresholds.swap ?? DEFAULT_SWAP_HIGH_PERCENT,
    };
  }

  async poll(now = Date.now()) {
    if (now < this.next) return;
    this.next = now + 60_000;
    const usage = await this.probe.usage();
    const high =
      usage.tmp_percent > this.thresholds.tmp ||
      usage.swap_percent > this.thresholds.swap;
    if (high === this.lastHigh) return;
    const recorded = () =>
      (
        this.store.database
          .prepare(`SELECT type FROM events WHERE project_id = 'cardigan'
        AND card_id IS NULL AND type IN (?, ?) AND json_extract(doc, '$.actor.kind') = 'system'
        ORDER BY seq DESC LIMIT 1`)
          .get(HIGH, RECOVERED) as { type: string } | undefined
      )?.type === HIGH;
    if (recorded() === high) {
      this.lastHigh = high;
      return;
    }
    // The scan runs outside the write transaction; only the append is locked.
    const details = high ? await this.probe.details() : undefined;
    this.store.uow.run((tx) => {
      if (recorded() === high) return;
      tx.events.append("cardigan", {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence("cardigan"),
        type: high ? HIGH : RECOVERED,
        actor: { kind: "system", project_id: "cardigan" },
        created_at: new Date(now).toISOString(),
        payload: {
          tmp_used_percent: usage.tmp_percent,
          swap_used_percent: usage.swap_percent,
          tmp_threshold_percent: this.thresholds.tmp,
          swap_threshold_percent: this.thresholds.swap,
          ...(details
            ? { notice: pressureNotice(usage, this.thresholds, details) }
            : {}),
        },
      });
    });
    this.lastHigh = high;
  }
}
