import type { Event } from "./entities.js";

/**
 * C-796: the host's GitHub dispatch journal records (merge checks and author
 * prechecks, and the isolated probe stream). Each save appends the whole
 * intent again, so a stream holds many records per attempt and the journal
 * reads only the newest system record of each attempt.
 */
export const DISPATCH_RECORD_TYPES: ReadonlySet<string> = new Set([
  "github_check_dispatch",
  "github_probe_dispatch",
]);

/**
 * C-796: what a dormant dispatch record keeps of its payload, so readers can
 * pick each attempt's newest record, match a candidate ref or find a GitHub
 * run id without decoding it. Event rows are never updated, so a head never
 * goes stale.
 */
export interface DispatchHead {
  /** The journal reads system records only. */
  readonly system: boolean;
  readonly attempt: unknown;
  /** `String(externalRun.run_id)` when the record names an external run. */
  readonly run_id?: string;
  readonly finished: boolean;
  readonly repo?: unknown;
  readonly ref?: unknown;
}

/** Sentinel for "this entry takes no part" in `newestOfType` keys. */
export const SKIP_ENTRY: unique symbol = Symbol("skip-entry");

type Payload = {
  readonly attempt?: unknown;
  readonly finished?: unknown;
  readonly externalRun?: { readonly run_id?: unknown } | null;
  readonly candidate?: { readonly repo?: unknown; readonly ref?: unknown };
};

/** The head of a decoded dispatch record (see `DispatchHead`). */
export function dispatchHead(event: Event): DispatchHead {
  const p = (
    event.payload && typeof event.payload === "object" ? event.payload : {}
  ) as Payload;
  const run = p.externalRun;
  const candidate =
    p.candidate && typeof p.candidate === "object" ? p.candidate : undefined;
  return {
    system: event.actor.kind === "system",
    attempt: p.attempt,
    ...(run === undefined ? {} : { run_id: String(run?.run_id) }),
    finished: p.finished === true,
    ...(candidate ? { repo: candidate.repo, ref: candidate.ref } : {}),
  };
}
