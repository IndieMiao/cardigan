import { readRunQueue } from "@cardigan/host";
import type { ReadRepositories, Store } from "@cardigan/store";

/** Execution, CLI and the capacity claim use the same queue projection. */
export function readWorkbenchQueue(store: Store, tx: ReadRepositories) {
  return readRunQueue(store, tx);
}
