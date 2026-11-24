import type {
  CardId,
  CommandState,
  Machine,
  NeedsYouSection,
  ProjectId,
} from "@cardigan/domain";
import { workerAgentToolsAction, workerHelperAction } from "@cardigan/domain";
import type { ProjectMergeGate } from "@cardigan/host";
import type { Store } from "@cardigan/store";
import { readCardDetailCached } from "./card-detail-cache.js";
import { cardSectionPayload } from "./card-sections.js";
import {
  type CardsCacheOptions,
  readCachedCardsPage,
  readCardsVersion,
} from "./cards-cache.js";
import {
  declaredCapabilities,
  readExecution,
  readExecutionRuns,
} from "./execution-state.js";
import { HttpRejection } from "./http.js";
import { readNeedsState } from "./needs-state.js";
import { readNeedsVersion } from "./needs-version.js";
import {
  type ExecutionContexts,
  InvalidQuery,
  needsYou,
  needsYouCounts,
  noticePage,
  projectState,
} from "./read.js";
import { readPagedCard } from "./timeline-state.js";

/**
 * C-644: the Workbench's heavy reads, as plain data. The same code runs in the
 * read worker (production) and inline on the Web thread (tests, in-memory
 * stores), so moving a route off the event loop never forks its behavior.
 * Every field must survive structured clone: no functions, no class instances.
 */
export type WorkbenchReadOp =
  | {
      readonly kind: "cards";
      readonly project: ProjectId;
      readonly url: string;
      readonly version: boolean;
      readonly cache: CardsCacheOptions;
    }
  | {
      readonly kind: "card";
      readonly project: ProjectId;
      readonly card: CardId;
      readonly url: string;
      readonly mergeGateStatus: ProjectMergeGate["status"];
      readonly now: string;
      /** C-688: the client's `If-None-Match`; a match answers `notModified`. */
      readonly ifNoneMatch?: string | undefined;
      /** C-688: the client accepts a gzip-encoded body. */
      readonly acceptGzip?: boolean | undefined;
    }
  | {
      readonly kind: "needs_version";
      readonly project: ProjectId;
      readonly context: string;
      readonly now: string;
      readonly readScope: string;
      readonly runtimeUnknownGraceMs?: number | undefined;
    }
  | {
      readonly kind: "needs";
      readonly project: ProjectId;
      readonly counts: boolean;
      readonly section?: NeedsYouSection | undefined;
      readonly now: string;
      readonly mergeGateStatus?: ProjectMergeGate["status"] | undefined;
      readonly projectSettings?: CommandState["project_settings"] | undefined;
      readonly hostOpsPatrolIntervalMs?: number | undefined;
      readonly hcSession?: string | undefined;
      readonly runtimeUnknownGraceMs?: number | undefined;
    }
  | {
      readonly kind: "notices";
      readonly project: ProjectId;
      readonly before?: string | undefined;
    }
  | {
      readonly kind: "execution";
      readonly project: ProjectId;
      readonly url: string;
      readonly now: string;
      readonly queueWarningMinutes: number;
      readonly contexts?: ExecutionContexts | undefined;
      readonly capabilityCatalog?:
        | readonly { readonly key: string; readonly os: readonly string[] }[]
        | undefined;
    }
  | {
      readonly kind: "execution_runs";
      readonly project: ProjectId;
      readonly assignment: string;
      readonly before?: string | undefined;
    }
  | {
      readonly kind: "precheck_attempt";
      readonly project: ProjectId;
      readonly attempt: string;
    }
  | {
      readonly kind: "merge_check_attempt";
      readonly project: ProjectId;
      readonly attempt: string;
    };

/** JSON routes answer `body` (already serialized); log lookups answer `value`. */
export interface WorkbenchReadResult {
  readonly body?: string;
  readonly value?: unknown;
  /** C-688: card detail validator; `notModified` answers carry no body. */
  readonly etag?: string;
  readonly notModified?: boolean;
  /** C-688: the body gzip-encoded (instead of `body`) for a client that accepts it. */
  readonly gzip?: Uint8Array;
  readonly timings: Readonly<Record<string, number>>;
}

/**
 * Host-side facts the Web thread owns (runtime worker files, release material,
 * check jobs). Only machines named by open helper or tools notices are asked.
 */
export interface HostFactsRequest {
  readonly project: ProjectId;
  readonly machines: readonly string[];
  readonly purpose: "needs" | "needs_version";
}
export interface HostMachineFacts {
  /** `currentBinding(project, machine)`; needs only. */
  readonly binding?: string | null;
  /** `currentUpgradeCommand(project, machine, binding)`; needs only. */
  readonly upgrade?: string | undefined;
  /** `currentBinding(project, machine, "manual-upgrade")`; version only. */
  readonly manual?: string | null;
  /** `currentToolsCommand(project, machine)`. */
  readonly tools?: string | undefined;
}
export type HostFacts = Readonly<Record<string, HostMachineFacts>>;
export type HostFactsReader = (request: HostFactsRequest) => Promise<HostFacts>;

/** Serializable rejection; the Web thread rethrows it as an HttpRejection. */
export interface WorkbenchReadError {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export function toReadError(error: unknown): WorkbenchReadError | undefined {
  if (error instanceof HttpRejection)
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
      headers: error.headers,
    };
  if (error instanceof InvalidQuery)
    return { status: 400, code: "validation_failed", message: error.message };
  return undefined;
}

export function fromReadError(error: WorkbenchReadError): HttpRejection {
  return new HttpRejection(
    error.status,
    error.code,
    error.message,
    error.details,
    error.headers ?? {},
  );
}

/** Machines a needs-you read may ask host facts for (a superset is harmless). */
export function hostFactMachines(state: CommandState): string[] {
  const ids = new Set<string>();
  for (const action of state.human_actions) {
    if (action.status !== "open" || !action.terminal) continue;
    if (action.helper_upgrade?.machine_id)
      ids.add(action.helper_upgrade.machine_id);
    if (action.requested_by !== "system" || action.card_id) continue;
    const helper = workerHelperAction(state, action);
    if (helper?.machine_id) ids.add(helper.machine_id);
    const tools = workerAgentToolsAction(state, action);
    if (tools?.machine_id) ids.add(tools.machine_id);
  }
  return [...ids].sort();
}

async function hostFacts(
  state: CommandState,
  project: ProjectId,
  purpose: HostFactsRequest["purpose"],
  host: HostFactsReader | undefined,
): Promise<HostFacts> {
  const machines = hostFactMachines(state);
  if (!host || !machines.length) return {};
  return host({ project, machines, purpose });
}

/** Mirrors MachineChecks.currentBinding's own guard on the record it is given. */
const bound = (machine: Machine | undefined): machine is Machine =>
  !!machine && machine.herdr_machine === machine.id;

export async function runWorkbenchRead(
  store: Store,
  op: WorkbenchReadOp,
  host?: HostFactsReader,
): Promise<WorkbenchReadResult> {
  const timings: Record<string, number> = {};
  const json = (body: unknown): WorkbenchReadResult => ({
    body: JSON.stringify(body),
    timings,
  });
  switch (op.kind) {
    case "cards": {
      const url = new URL(op.url);
      return json(
        op.version
          ? readCardsVersion(store, op.project, url, op.cache)
          : readCachedCardsPage(store, op.project, url, op.cache),
      );
    }
    case "card": {
      const url = new URL(op.url);
      const at = url.searchParams.get("at");
      const answer = readCardDetailCached(store, op, () => {
        const detail = readPagedCard(store, op.project, op.card, url, {
          recordTiming: (stage, ms) => {
            timings[stage] = ms;
          },
          mergeGateStatus: op.mergeGateStatus,
          now: op.now,
          ...(at ? { timelineAnchor: at } : {}),
        });
        if (detail === undefined)
          throw new HttpRejection(
            404,
            "not_found",
            `card ${op.card} not found`,
          );
        return {
          project_id: op.project,
          ...cardSectionPayload(detail, url.searchParams.get("section")),
        };
      });
      return {
        ...(answer.body === undefined ? {} : { body: answer.body }),
        ...(answer.gzip === undefined ? {} : { gzip: answer.gzip }),
        etag: answer.etag,
        notModified: answer.notModified,
        timings,
      };
    }
    case "needs_version": {
      const state = projectState(store, op.project);
      const facts = await hostFacts(state, op.project, "needs_version", host);
      return json({
        project_id: op.project,
        at: op.now,
        read_scope: op.readScope,
        revision: readNeedsVersion(
          store,
          op.project,
          op.context,
          op.now,
          op.runtimeUnknownGraceMs,
          (_project, machine) =>
            bound(machine) ? (facts[machine.id]?.manual ?? null) : null,
          (_project, machine) => facts[machine.id]?.tools,
        ),
      });
    }
    case "needs": {
      const source = readNeedsState(store, op.project);
      const state = op.projectSettings
        ? { ...source, project_settings: op.projectSettings }
        : source;
      if (op.counts)
        return json({
          project_id: op.project,
          ...needsYouCounts(
            state,
            op.now,
            op.mergeGateStatus,
            op.runtimeUnknownGraceMs,
          ),
        });
      const facts = await hostFacts(state, op.project, "needs", host);
      return json({
        project_id: op.project,
        ...needsYou(
          state,
          op.now,
          op.mergeGateStatus,
          op.hostOpsPatrolIntervalMs,
          op.hcSession,
          op.runtimeUnknownGraceMs,
          op.section,
          (_project, machine, binding) => {
            const known = facts[machine.id];
            return bound(machine) && known?.binding === binding
              ? known.upgrade
              : undefined;
          },
          (_project, machine) => facts[machine.id]?.tools,
        ),
      });
    }
    case "notices":
      return json(noticePage(readNeedsState(store, op.project), op.before));
    case "execution":
      return json(
        readExecution(
          store,
          op.project,
          new URL(op.url),
          op.now,
          op.queueWarningMinutes,
          op.contexts,
          declaredCapabilities(
            op.capabilityCatalog ? () => op.capabilityCatalog ?? [] : undefined,
          ),
        ),
      );
    case "execution_runs": {
      const page = readExecutionRuns(
        store,
        op.project,
        op.assignment,
        op.before,
      );
      if (!page) throw new HttpRejection(404, "not_found", "Assignment 不存在");
      return json({ project_id: op.project, ...page });
    }
    case "precheck_attempt":
      return { value: precheckHeader(store, op.project, op.attempt), timings };
    case "merge_check_attempt":
      return {
        value: hasMergeCheckAttempt(store, op.project, op.attempt),
        timings,
      };
  }
}

/** The log header for a known author precheck, or `null` when unknown here. */
function precheckHeader(
  store: Store,
  project: ProjectId,
  attempt: string,
): string | null {
  const event = projectState(store, project)
    .events.filter((event) => {
      const payload = event.payload;
      return (
        event.card_id &&
        event.actor.kind === "system" &&
        event.actor.project_id === project &&
        ["precheck_queued", "precheck_started", "precheck_finished"].includes(
          event.type,
        ) &&
        payload !== null &&
        typeof payload === "object" &&
        "attempt_id" in payload &&
        payload.attempt_id === attempt &&
        "card_id" in payload &&
        payload.card_id === event.card_id &&
        "head_sha" in payload &&
        typeof payload.head_sha === "string" &&
        /^[a-f0-9]{40}$/u.test(payload.head_sha)
      );
    })
    .sort((a, b) => b.seq - a.seq)[0];
  if (!event) return null;
  const payload = event.payload as { head_sha: string };
  return `作者预检查\n被检提交：${payload.head_sha}\n更新时间：${event.created_at}\n\n`;
}

function hasMergeCheckAttempt(
  store: Store,
  project: ProjectId,
  attempt: string,
): boolean {
  return projectState(store, project).events.some((event) => {
    const payload = event.payload;
    if (
      !event.card_id &&
      event.actor.kind === "system" &&
      event.type.startsWith("merge_batch_check_") &&
      (payload as { check?: { attempt_id?: string } } | null)?.check
        ?.attempt_id === attempt
    )
      return true;
    return (
      event.card_id &&
      event.actor.project_id === project &&
      [
        "merge_check_queued",
        "merge_check_started",
        "merge_check_finished",
        "merge_check_requeued",
      ].includes(event.type) &&
      payload !== null &&
      typeof payload === "object" &&
      "attempt_id" in payload &&
      payload.attempt_id === attempt
    );
  });
}
