import { cardCriticalPathLengths } from "./card-dependencies.js";
import { refreshCardDependencies } from "./commands/card-dependencies.js";
import type { CommandPorts, CommandState } from "./commands/core.js";
import {
  decisionHistory,
  remindDecisionFollowups,
} from "./commands/decision-followup.js";
import { refreshCancelledHumanActions } from "./commands/human-action-lifecycle.js";
import { mergeQueue } from "./commands/merge-batch.js";
import { recordMergeCheckBlockers } from "./commands/merge-check-blockers.js";
import { recordAutomaticMergeWaits } from "./commands/merge-observation.js";
import { beginMergePush } from "./commands/merge-push.js";
import { notices } from "./commands/notices.js";
import { maintainPmCoordination } from "./commands/pm-coordination.js";
import { pmRecoveryEligible } from "./commands/pm-recovery.js";
import { projectPreferences } from "./commands/preferences.js";
import { listNeedsYou, projectSnapshot } from "./commands/queries.js";
import { deploymentAuditedVersion } from "./commands/standing-deployment.js";
import { standingPmStallEvents } from "./commands/standing-pm-stall.js";
import { stoppedByHuman } from "./commands/stop-state.js";
import { resumeWorkWaits } from "./commands/work-waits.js";
import {
  categoryAuthorization,
  categoryDelegated,
} from "./decision-authorization.js";
import type { Actor } from "./entities.js";
import { extMessageItems } from "./ext-message.js";
import { hostOpsPending, pendingHostOpsActions } from "./host-ops.js";
import { mergeBatches } from "./merge-batch.js";
import type { IdAllocator } from "./ports.js";
import { delegationCategories } from "./preferences.js";
import { remoteWorkerLosses } from "./remote-worker-loss.js";
import { sessionMaintenanceBasis } from "./session-maintenance.js";

/** One shadow comparison; `path` locates the first difference, never values. */
export interface HotShadowCheck {
  readonly name: string;
  readonly equal: boolean;
  readonly path?: string;
}

/** Fresh, deterministic ids so both runs of a reducer allocate identically. */
function shadowIds(): IdAllocator {
  const counters = new Map<string, number>();
  const next = (key: string) => {
    const value = (counters.get(key) ?? 0) + 1;
    counters.set(key, value);
    return value;
  };
  return {
    next: (project, kind) =>
      `${kind}-shadow-${next(`${project}:${kind}`)}` as never,
    nextTimelineEntryId: (project, card) =>
      `${card}#shadow-${next(`${project}:${card}:timeline`)}` as never,
    nextEventId: () => `shadow-event-${next("event")}` as never,
    nextEventSequence: (project, card) =>
      1_000_000_000 + next(`${project}:${card ?? ""}:seq`),
    nextAttachmentId: (project) =>
      `attachment-shadow-${next(`${project}:attachment`)}` as never,
  };
}

/** Distinct push destinations named by queued merge pushes (project stream). */
function mergePushDestinations(state: CommandState) {
  const seen = new Map<
    string,
    { target: string; branch: string; base_branch?: string }
  >();
  for (const e of state.events) {
    if (e.card_id || e.type !== "merge_push_queued") continue;
    const p = e.payload as {
      target?: unknown;
      branch?: unknown;
      base_branch?: unknown;
    } | null;
    if (typeof p?.target !== "string" || typeof p.branch !== "string") continue;
    const destination = {
      target: p.target,
      branch: p.branch,
      ...(typeof p.base_branch === "string"
        ? { base_branch: p.base_branch }
        : {}),
    };
    seen.set(JSON.stringify(destination), destination);
  }
  return [...seen.values()];
}

/** First differing JSON path; values are never reported. */
export function firstDifference(
  a: unknown,
  b: unknown,
  path = "$",
): string | undefined {
  if (Object.is(a, b)) return undefined;
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null ||
    Array.isArray(a) !== Array.isArray(b)
  )
    return path;
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const found = firstDifference(a[i], b[i], `${path}[${i}]`);
      if (found) return found;
    }
    return undefined;
  }
  if (a instanceof Map || b instanceof Map)
    return firstDifference(
      a instanceof Map ? [...a] : a,
      b instanceof Map ? [...b] : b,
      path,
    );
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of [...keys].sort()) {
    const found = firstDifference(
      (a as Record<string, unknown>)[key],
      (b as Record<string, unknown>)[key],
      `${path}.${key}`,
    );
    if (found) return found;
  }
  return undefined;
}

/** Normalize errors and other class instances to comparable plain data. */
function settle(run: () => unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(run(), (_k, v) => normalize(v)));
  } catch (error) {
    return {
      thrown: error instanceof Error ? error.message : String(error),
    };
  }
}
function normalize(value: unknown) {
  if (value instanceof Map) return [...value];
  if (value instanceof Set) return [...value];
  return value;
}

/**
 * C-639 shadow comparison: the same pure rules and projections over the
 * whole-history state and the hot state. Covers the cross-card readers found
 * in the audit (dependencies, merge blockers, host-ops fences, Needs You,
 * notices, decision follow-ups, external messages, PM coordination).
 */
export function compareHotState(
  full: CommandState,
  hot: CommandState,
  options: { readonly now: string },
): HotShadowCheck[] {
  const system: Actor = { kind: "system", project_id: full.project_id };
  const human: Actor = { kind: "human", project_id: full.project_id };
  const clock = { now: () => options.now };
  const ports = (): CommandPorts => ({ clock, ids: shadowIds() });
  const checks: [string, (s: CommandState) => unknown][] = [
    [
      "refresh_card_dependencies",
      (s) => refreshCardDependencies(s, system, ports()),
    ],
    [
      "record_merge_check_blockers",
      (s) => recordMergeCheckBlockers(s, system, {}, ports()),
    ],
    [
      "record_automatic_merge_waits",
      (s) => recordAutomaticMergeWaits(s, system, {}, ports()),
    ],
    [
      "maintain_pm_coordination",
      (s) => maintainPmCoordination(s, system, ports()),
    ],
    [
      "remind_decision_followups",
      (s) => remindDecisionFollowups(s, system, ports()),
    ],
    [
      "refresh_cancelled_human_actions",
      (s) => refreshCancelledHumanActions(s, system, ports()),
    ],
    ["resume_work_waits", (s) => resumeWorkWaits(s, system, {}, ports())],
    ["project_snapshot", (s) => projectSnapshot(s, human)],
    ["list_needs_you", (s) => listNeedsYou(s, human, clock)],
    ["notices", (s) => notices(s)],
    ["ext_message_items", (s) => extMessageItems(s, s.project_id)],
    ["decision_history", (s) => decisionHistory(s)],
    ["critical_path", (s) => cardCriticalPathLengths(s)],
    ["pending_host_ops", (s) => pendingHostOpsActions(s.events)],
    [
      "host_ops_fences",
      (s) => s.assignments.map((a) => [a.id, hostOpsPending(s.events, a.id)]),
    ],
    // C-649: the categories the system-stream retention must not change.
    ["project_preferences", (s) => projectPreferences(s)],
    [
      "delegation",
      (s) =>
        delegationCategories.map((c) => [
          c,
          categoryDelegated(projectPreferences(s), s.events, c),
          categoryAuthorization(s.events, c)?.id,
        ]),
    ],
    [
      "deployment_audits",
      (s) =>
        s.roles.map((r) => [
          r.role_id,
          r.role_version,
          deploymentAuditedVersion(s, r.role_id, r.role_version),
        ]),
    ],
    [
      "standing_runs",
      (s) =>
        s.assignments
          .filter((a) => a.scope === "standing")
          .map((a) => [
            a.id,
            pmRecoveryEligible(s, a),
            stoppedByHuman(s.events, a.id),
            standingPmStallEvents(s, a.id).map((e) => e.id),
            sessionMaintenanceBasis(s, a),
          ]),
    ],
    ["remote_worker_losses", (s) => remoteWorkerLosses(s.events)],
    ["merge_queue", (s) => [mergeQueue(s), mergeBatches(s.events)]],
    [
      "merge_push",
      (s) =>
        mergePushDestinations(full).map((destination) =>
          beginMergePush(
            s,
            system,
            { ...destination, attempt_id: "shadow-attempt" },
            ports(),
          ),
        ),
    ],
  ];
  return checks.map(([name, run]) => {
    const path = firstDifference(
      settle(() => run(full)),
      settle(() => run(hot)),
    );
    return path === undefined
      ? { name, equal: true }
      : { name, equal: false, path };
  });
}
