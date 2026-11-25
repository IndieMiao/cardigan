import { setImmediate as yieldToLoop } from "node:timers/promises";
import type { Store } from "@cardigan/store";

/**
 * C-649: after a restart, decode every project's event history into the
 * shared command-event log in short read slices, yielding between them, so
 * the first command or loop tick does not pay for it in one long pause.
 * Best effort: a closed or busy store leaves the rest to the first reader.
 */
export async function warmCommandEvents(
  store: Pick<Store, "listProjects" | "warmCommandEvents">,
  rows = 50_000,
): Promise<void> {
  try {
    for (const { id } of store.listProjects()) {
      while (!store.warmCommandEvents(id, rows)) await yieldToLoop();
      await yieldToLoop();
    }
  } catch {
    // The first loadCommandState decodes whatever is left.
  }
}
