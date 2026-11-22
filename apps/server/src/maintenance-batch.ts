/** A cursor holds identifiers, not stale authority. Callers re-read the owner
 * before acting. Always finish an admitted IO/transaction; never race it with
 * a detached timeout. A fresh sweep retries failed and newly created entries. */
export class MaintenanceBatch<K, T> {
  private readonly pages = new Map<K, T[]>();
  has(key: K) {
    return this.pages.has(key);
  }
  async run(key: K, list: () => T[], visit: (id: T) => Promise<void>) {
    const page = this.pages.get(key) ?? list().reverse();
    this.pages.set(key, page);
    const until = performance.now() + 250;
    try {
      for (let n = 0; page.length && n < 16; n++) {
        await visit(page.pop() as T);
        if (performance.now() >= until) break;
      }
    } finally {
      if (!page.length) this.pages.delete(key);
    }
  }
}

/** One project per timer tick; incomplete pages join the back of this cycle. */
export function projectCycle<T>(
  list: () => T[],
  visit: (key: T) => Promise<void>,
  more: (key: T) => boolean,
) {
  let queue: T[] = [];
  return {
    continueSoon: () => queue.length > 0,
    tick: async () => {
      if (!queue.length) queue = list();
      const key = queue.shift();
      if (key === undefined) return;
      await visit(key);
      if (more(key)) queue.push(key);
    },
  };
}
