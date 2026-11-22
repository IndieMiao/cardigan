import type { CommandState } from "@cardigan/domain";
import type { Store } from "@cardigan/store";
import { vi } from "vitest";

/** SQLite counts actual row operations, including writes made by triggers. The
 * fixture has one connection doing writes, all through Store transactions. */
export async function measureWrites(store: Store, tick: () => unknown) {
  const query = store.database.prepare("SELECT total_changes() AS n");
  const count = () => Number(query.get()?.n);
  let previous = count();
  const writes: number[] = [];
  store.observe({
    transaction(kind) {
      if (kind !== "run") return;
      const current = count();
      writes.push(current - previous);
      previous = current;
    },
  });
  try {
    await tick();
    return writes;
  } finally {
    store.observe(undefined);
  }
}

/** Sample one unrelated slot in each real command snapshot. Preserve its
 * identity (and hence its indexes); do not preload the cold history. */
export async function measureHistoryTick(store: Store, tick: () => unknown) {
  const uow = store.uow;
  const sampled = new Map<CommandState["events"], () => void>();
  let visits = 0;
  let writing = false;
  const hook = vi.spyOn(store, "uow", "get").mockReturnValue({
    read: (op) =>
      uow.read((tx) =>
        op({
          ...tx,
          cachedCommandState(project, build) {
            const state = tx.cachedCommandState?.(project, build) ?? build();
            const { events } = state;
            if (!sampled.has(events)) {
              const index = events.findIndex(
                (event) => event.id === "history-1",
              );
              const original = Object.getOwnPropertyDescriptor(events, index);
              if (!original)
                throw new Error("Missing unrelated history sample");
              sampled.set(events, () =>
                Object.defineProperty(events, index, original),
              );
              Object.defineProperty(events, index, {
                get() {
                  if (writing) throw new Error("History visited inside writer");
                  visits++;
                  return original.value;
                },
              });
            }
            return state;
          },
        }),
      ),
    run: (op) =>
      uow.run((tx) => {
        writing = true;
        try {
          return op({
            ...tx,
            events: {
              ...tx.events,
              listStreams() {
                throw new Error("Project history loaded inside writer");
              },
            },
          });
        } finally {
          writing = false;
        }
      }),
  });
  try {
    const writes = await measureWrites(store, tick);
    if (!sampled.size) throw new Error("Tick did not read a command snapshot");
    return { writes, visits };
  } finally {
    hook.mockRestore();
    for (const restore of sampled.values()) restore();
  }
}
