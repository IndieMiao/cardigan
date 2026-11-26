import { longOperationFenceStands, tryHoldLongOperation } from "@cardigan/host";
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
 * the row goes as soon as no step runs.
 */
export const MERGE_STEP_LINGER_MS = 250;

/**
 * Process-wide registration of running merge steps in the managed operation
 * registry. One row stands while at least one step of this process runs
 * (plus the linger): a restart decision that fences and reads the registry
 * in one transaction either sees the row and waits, or the step sees the
 * fence first and does not start. The row names the step that opened the
 * burst; with several steps in a row it names the first of them.
 */
class MergeStepRegistry {
  private readonly active = new Set<symbol>();
  private row: (() => void) | undefined;
  private linger: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private readonly store: Store,
    private readonly lingerMs: number,
  ) {}

  hold(step: MergeStepSubject, label: string): () => void {
    if (this.row) {
      // The row already stands, so any fence taken from now on sees it.
      if (longOperationFenceStands(this.store)) {
        if (!this.active.size) this.drop();
        throw new MergeStepDeferred(label);
      }
    } else {
      const row = tryHoldLongOperation(this.store, {
        kind: "merge_step",
        project_id: step.project_id,
        card_id: step.card_id ?? null,
        label,
      });
      if (!row) throw new MergeStepDeferred(label);
      this.row = row;
    }
    this.cancelLinger();
    const token = Symbol(label);
    this.active.add(token);
    return () => {
      if (!this.active.delete(token) || this.active.size) return;
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

  private cancelLinger() {
    if (this.linger === undefined) return;
    clearTimeout(this.linger);
    this.linger = undefined;
  }

  private drop() {
    this.cancelLinger();
    const row = this.row;
    this.row = undefined;
    row?.();
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
