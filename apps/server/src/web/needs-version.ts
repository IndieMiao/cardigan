import { createHash, randomUUID } from "node:crypto";
import {
  type Machine,
  needsYouReadPhase,
  type ProjectId,
} from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import type { Store } from "@cardigan/store";

/** Incremental source and discrete clock membership; no full page, TTL or write authority. */
export function readNeedsVersion(
  store: Store,
  project: ProjectId,
  context: string,
  now?: string,
  runtimeGrace?: number,
  currentBinding?: (
    project: string,
    machine: Machine | undefined,
  ) => string | null,
): string {
  return store.uow.read((tx) => {
    const state =
      now !== undefined || currentBinding
        ? loadCommandState(tx, project)
        : undefined;
    // A private binding can change without a SQLite revision. Invalidate cached
    // commands on the next poll; process/release changes already have a boot epoch.
    const visibleBindings =
      currentBinding &&
      state?.human_actions.flatMap((h) =>
        h.status === "open" &&
        h.terminal &&
        h.helper_upgrade?.binding &&
        currentBinding(
          project,
          state.machines?.find((m) => m.id === h.helper_upgrade?.machine_id),
        ) === h.helper_upgrade.binding
          ? [h.id]
          : [],
      );
    return createHash("sha256")
      .update(
        JSON.stringify([
          project,
          store.snapshotVersion(project) ?? randomUUID(),
          context,
          visibleBindings,
          now === undefined || !state
            ? null
            : needsYouReadPhase(state, now, runtimeGrace),
        ]),
      )
      .digest("hex");
  });
}
