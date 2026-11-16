// Linux-only experiment accounting. No runtime API or production process scan.
import { readFileSync } from "node:fs";
export function helperAccounting() {
  const children = new Map();
  function sample(pid) {
    try {
      const text = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = text.slice(text.lastIndexOf(") ") + 2).split(" ");
      return {
        state: fields[0],
        start: fields[19],
        ticks: Number(fields[11]) + Number(fields[12]),
        rss_pages: Number(fields[21]),
      };
    } catch {
      return undefined;
    }
  }
  return {
    track(child) {
      if (!child.pid) return;
      const initial = sample(child.pid);
      if (initial) children.set(child.pid, initial.start);
    },
    snapshot() {
      const samples = new Map();
      for (const [pid, start] of children) {
        const current = sample(pid);
        if (current?.start === start) samples.set(pid, current);
      }
      return samples;
    },
    delta(before, hz) {
      const after = this.snapshot();
      return {
        live_helpers: [...after.values()].filter((value) => value.state !== "Z")
          .length,
        exited_unreaped_helpers: [...after.values()].filter(
          (value) => value.state === "Z",
        ).length,
        unreaped_helper_cpu_ms:
          ([...after].reduce(
            (sum, [pid, value]) =>
              sum + value.ticks - (before.get(pid)?.ticks ?? 0),
            0,
          ) *
            1000) /
          hz,
        live_helper_rss_pages: [...after.values()].reduce(
          (sum, value) => sum + value.rss_pages,
          0,
        ),
        child_cpu_resolution_ms: 1000 / hz,
      };
    },
  };
}
