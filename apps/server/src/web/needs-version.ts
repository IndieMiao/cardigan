import { createHash, randomUUID } from "node:crypto";
import {
  type Machine,
  needsYouReadPhase,
  type ProjectId,
  workerAgentToolsAction,
} from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import type { Store } from "@cardigan/store";

/**
 * C-634: request-clock span over which an unchanged project reuses its clock
 * phase. Data changes always recompute it; only a purely time-driven
 * membership change (a wait passing its threshold) may surface this much later.
 */
export const NEEDS_PHASE_REFRESH_MS = 10_000;

const phases = new WeakMap<
  Store,
  Map<string, { key: string; at: number; phase: string }>
>();

/** Incremental source and discrete clock membership; no full page or write authority. */
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
    const version = store.snapshotVersion(project);
    return createHash("sha256")
      .update(
        JSON.stringify([
          project,
          version ?? randomUUID(),
          context,
          visibleBindings,
          toolsVisible ?? null,
          now === undefined || !state
            ? null
            : needsClockPhase(
                store,
                project,
                version && JSON.stringify([version, runtimeGrace ?? null]),
                now,
                () => needsYouReadPhase(state, now, runtimeGrace),
              ),
        ]),
      )
      .digest("hex");
  });
}

/** The phase only moves with data (the snapshot version) or with the clock. */
export function needsClockPhase(
  store: Store,
  project: ProjectId,
  version: string | undefined,
  now: string,
  compute: () => string,
): string {
  const at = Date.parse(now);
  if (version === undefined || !Number.isFinite(at)) return compute();
  let byProject = phases.get(store);
  if (!byProject) {
    byProject = new Map();
    phases.set(store, byProject);
  }
  const cached = byProject.get(project);
  if (
    cached?.key === version &&
    at >= cached.at &&
    at - cached.at < NEEDS_PHASE_REFRESH_MS
  )
    return cached.phase;
  const phase = compute();
  byProject.set(project, { key: version, at, phase });
  return phase;
}
