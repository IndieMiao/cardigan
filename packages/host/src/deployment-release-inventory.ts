import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { requireHostDirectory } from "./deployment-config.js";
import { type Item, localCommand, scan } from "./deployment-retention-io.js";

interface Input {
  root: string;
  uid: number | undefined;
  keep: string[];
  latest: number;
}
const namePattern =
  /^release-[a-f0-9]{40}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
async function catalog(input: Input) {
  await requireHostDirectory(input.root);
  const root = await lstat(input.root, { bigint: true });
  if (
    input.uid === undefined ||
    root.uid !== BigInt(input.uid) ||
    root.mode & 0o077n
  )
    throw new Error("Unsafe release root");
  const skipped: string[] = [],
    namespace: Record<string, string> = {},
    valid = [];
  for (const name of await readdir(input.root)) {
    if (!namePattern.test(name)) continue;
    try {
      const st = await lstat(join(input.root, name), { bigint: true });
      if (
        !st.isDirectory() ||
        st.uid !== root.uid ||
        st.mode & 0o077n ||
        st.dev !== root.dev
      )
        throw new Error("Unverified release");
      namespace[name] = `${st.dev}:${st.ino}`;
      valid.push({ name, mtime: st.mtimeNs });
    } catch {
      skipped.push(name);
    }
  }
  // Match the helper's reverse (mtime_ns, name) ordering, including ties.
  valid.sort((a, b) =>
    a.mtime === b.mtime
      ? a.name < b.name
        ? 1
        : -1
      : a.mtime < b.mtime
        ? 1
        : -1,
  );
  const names = valid
    .slice(input.latest)
    .map((v) => v.name)
    .filter((n) => !input.keep.includes(n));
  return { namespace, names, skipped };
}

/** Read-only background work. A single helper sees only one tree and times out independently.
 * The supervisor never awaits a tree walk; a deployment between polls cannot promote an
 * unobserved tree. At handoff reclassify latest, state refs and namespace against this tick. */
export class ReleaseSurvey {
  private job?: {
    scope: string;
    done: boolean;
    skipped: Set<string>;
    items: Map<string, Item>;
  };
  constructor(
    private readonly observe = async (input: Input, name: string) => {
      const result = await scan(
        localCommand("releases"),
        { ...input, names: [name] },
        "release",
        new Set([name]),
        60_000,
      );
      return result.candidates[0];
    },
  ) {}
  async poll(scope: string, input: Input) {
    if (this.job && !this.job.done) return;
    const current = await catalog(input);
    if (this.job?.scope === scope) {
      const { items, skipped } = this.job;
      delete this.job;
      const candidates: Item[] = [];
      for (const name of current.names) {
        const i = items.get(name);
        if (
          !skipped.has(name) &&
          i &&
          current.namespace[name] === `${i.device}:${i.inode}`
        )
          candidates.push(i);
        else current.skipped.push(name);
      }
      return {
        ...current,
        candidates,
        skipped: [...new Set([...skipped, ...current.skipped])],
      };
    }
    delete this.job;
    if (!current.names.length) return { ...current, candidates: [] };
    const job = {
      scope,
      done: false,
      skipped: new Set(current.skipped),
      items: new Map<string, Item>(),
    };
    this.job = job;
    const collect = async () => {
      for (const name of current.names) {
        try {
          const item = await this.observe(input, name);
          if (
            item &&
            current.namespace[name] === `${item.device}:${item.inode}`
          )
            job.items.set(name, item);
          else job.skipped.add(name);
        } catch {
          job.skipped.add(name);
        }
      }
      job.done = true;
    };
    void collect();
  }
}
