import {
  type HeldLongOperation,
  longOperationFenceStands,
  tryHeldLongOperation,
} from "@cardigan/host";
import type { Store } from "@cardigan/store";
import { type MergeFailureStage, mergeStage } from "./merge-failure.js";

/**
 * C-799: a deployment or supervisor restart has fenced the start of managed
 * operations. The step did not start; nothing failed. The merge, batch or
 * push is planned again on a later pass (on this server or the next one).
 */
export class MergeStepDeferred extends Error {
  constructor(readonly label: string) {
    super(`合并步骤等待重启结束：${label}`);
  }
}

export interface MergeStepSubject {
  readonly project_id: string;
  /** The card whose timeline hears that a restart waits for this step. */
  readonly card_id?: string | null | undefined;
  /** Which card or batch, e.g. `合并 C-12` or `批次 MB-3（C-1、C-2）`. */
  readonly subject: string;
}

/**
 * How long the registration outlives the last merge step of a burst, so the
 * steps of one merge pass share one durable row instead of two synchronous
 * writes each. A restart waits at most this much longer; under a stop fence
 * the row goes as soon as no step runs. Also how long the row may keep
 * naming a step that already ended before it is renamed to a running one.
 */
export const MERGE_STEP_LINGER_MS = 250;

interface RunningStep {
  readonly project_id: string;
  readonly card_id: string | null;
  readonly label: string;
  readonly started_at: string;
}

/**
 * Process-wide registration of running merge steps in the managed operation
 * registry. One row stands while at least one step of this process runs
 * (plus the linger): a restart decision that fences and reads the registry
 * in one transaction either sees the row and waits, or the step sees the
 * fence first and does not start.
 *
 * The row names a running step, or one that ended at most
 * `MERGE_STEP_LINGER_MS` ago: once the named step has ended, the row is
 * renamed (one write) to the latest step still running after that delay, so
 * a waiting restart notes the card and step it actually waits for. Steps
 * shorter than the delay cost no write.
 */
class MergeStepRegistry {
  private readonly active = new Map<symbol, RunningStep>();
  private row: HeldLongOperation | undefined;
  /** The step the row names; it may have ended (then a rename is due). */
  private named: symbol | undefined;
  private linger: ReturnType<typeof setTimeout> | undefined;
  private rename: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private readonly store: Store,
    private readonly lingerMs: number,
  ) {}

  hold(step: MergeStepSubject, label: string): () => void {
    const token = Symbol(label);
    const running: RunningStep = {
      project_id: step.project_id,
      card_id: step.card_id ?? null,
      label,
      started_at: new Date().toISOString(),
    };
    if (this.row) {
      // The row already stands, so any fence taken from now on sees it.
      if (longOperationFenceStands(this.store)) {
        if (!this.active.size) this.drop();
        throw new MergeStepDeferred(label);
      }
    } else {
      const row = tryHeldLongOperation(this.store, {
        kind: "merge_step",
        project_id: running.project_id,
        card_id: running.card_id,
        label,
      });
      if (!row) throw new MergeStepDeferred(label);
      this.row = row;
      this.named = token;
    }
    this.cancelLinger();
    this.active.set(token, running);
    if (this.named !== token && !this.active.has(this.named as symbol))
      this.renameSoon();
    return () => {
      if (!this.active.delete(token)) return;
      if (this.active.size) {
        if (this.named === token) this.renameSoon();
        return;
      }
      // A waiting restart should not wait out the linger.
      if (this.lingerMs <= 0 || longOperationFenceStands(this.store))
        this.drop();
      else {
        this.linger = setTimeout(() => {
          this.linger = undefined;
          if (!this.active.size) this.drop();
        }, this.lingerMs);
        this.linger.unref?.();
      }
    };
  }

  private renameSoon() {
    if (this.lingerMs <= 0) return this.renameNow();
    if (this.rename !== undefined) return;
    this.rename = setTimeout(() => {
      this.rename = undefined;
      this.renameNow();
    }, this.lingerMs);
    this.rename.unref?.();
  }

  /** Name the latest step still running, if the named one ended. */
  private renameNow() {
    if (!this.row || (this.named && this.active.has(this.named))) return;
    const latest = [...this.active].at(-1);
    if (!latest) return;
    const [token, step] = latest;
    this.named = token;
    this.row.relabel(
      { project_id: step.project_id, card_id: step.card_id, label: step.label },
      step.started_at,
    );
  }

  private cancelLinger() {
    if (this.linger === undefined) return;
    clearTimeout(this.linger);
    this.linger = undefined;
  }

  private drop() {
    this.cancelLinger();
    if (this.rename !== undefined) clearTimeout(this.rename);
    this.rename = undefined;
    const row = this.row;
    this.row = undefined;
    this.named = undefined;
    row?.release();
  }
}

const registries = new WeakMap<Store, MergeStepRegistry>();

/**
 * Register one Git step of a merge as a managed long operation, so a
 * deployment or the supervisor self-upgrade waits (bounded) for it before
 * stopping the server. While their stop fence stands the step must not
 * start: `MergeStepDeferred`. Returns the idempotent release.
 */
export function holdMergeStep(
  store: Store,
  step: MergeStepSubject,
  stage: string,
): () => void {
  let registry = registries.get(store);
  if (!registry) {
    registry = new MergeStepRegistry(store, MERGE_STEP_LINGER_MS);
    registries.set(store, registry);
  }
  return registry.hold(step, `${step.subject} 的「${stage}」`);
}

/** `mergeStage` held as a managed operation; failures keep the stage tag. */
export async function mergeStep<T>(
  store: Store,
  step: MergeStepSubject,
  stage: MergeFailureStage,
  work: () => T | Promise<T>,
): Promise<T> {
  const release = holdMergeStep(store, step, stage);
  try {
    return await mergeStage(stage, work);
  } finally {
    release();
  }
}

/** `批次 MB-3（C-1、C-2）`; the member list is bounded for the 200-char label. */
export function batchSubject(batch: {
  readonly id: string;
  readonly members: readonly { readonly card_id: string }[];
}): string {
  const cards = batch.members.map((m) => m.card_id);
  const shown = cards.slice(0, 8).join("、");
  return `批次 ${batch.id}（${shown}${cards.length > 8 ? ` 等 ${cards.length} 张` : ""}）`;
}
