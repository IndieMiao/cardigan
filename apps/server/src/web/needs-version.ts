import { createHash, randomUUID } from "node:crypto";
import {
  type Machine,
  needsYouReadPhase,
  type ProjectId,
  workerAgentToolsAction,
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
  /** C-599: the attachment tools command the current binding/release/route give. */
  currentToolsCommand?: (
    project: string,
    machine: Machine,
  ) => string | undefined,
): string {
  return store.uow.read((tx) => {
    const state =
      now !== undefined || currentBinding || currentToolsCommand
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
    // C-599: a tools notice's command is shown only while it is the current one.
    const toolsVisible =
      currentToolsCommand &&
      state?.human_actions.flatMap((h) => {
        if (h.status !== "open" || !h.terminal) return [];
        const tools = workerAgentToolsAction(state, h);
        const machine =
          tools && state.machines?.find((m) => m.id === tools.machine_id);
        return machine &&
          currentToolsCommand(project, machine) === h.terminal.command
          ? [h.id]
          : [];
      });
    return createHash("sha256")
      .update(
        JSON.stringify([
          project,
          store.snapshotVersion(project) ?? randomUUID(),
          context,
          visibleBindings,
          toolsVisible ?? null,
          now === undefined || !state
            ? null
            : needsYouReadPhase(state, now, runtimeGrace),
        ]),
      )
      .digest("hex");
  });
}
