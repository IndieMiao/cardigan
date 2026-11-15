import type { CardId, MergeCheckView, ProjectId } from "@cardigan/domain";
import type { Store, StoreTransactionContext } from "@cardigan/store";
import { GithubExecutorError } from "./github-client.js";

export type ExternalGithubRun = NonNullable<MergeCheckView["external_run"]>;
export interface GithubDispatchIntent {
  readonly project: string;
  readonly card: string;
  readonly attempt: string;
  /** Digest of the complete trusted executor configuration and dispatch inputs. */
  readonly key: string;
  readonly startedAt: string;
  readonly phase: "reserved" | "dispatching";
  readonly externalRun?: ExternalGithubRun;
  readonly finished?: boolean;
}
/** Durable system journal: reserve before IO, never redispatch an ambiguous intent. */
export class GithubDispatchJournal {
  constructor(private readonly store: Store) {}
  private current(
    tx: StoreTransactionContext,
    project: string,
    card: string,
  ): GithubDispatchIntent[] {
    const latest = new Map<string, GithubDispatchIntent>();
    for (const event of tx.events.listAfter(
      project as ProjectId,
      card as CardId,
      0,
    )) {
      if (
        event.type !== "github_check_dispatch" ||
        event.actor.kind !== "system"
      )
        continue;
      const value = event.payload as unknown as GithubDispatchIntent;
      latest.set(value.attempt, value);
    }
    return [...latest.values()];
  }
  private save(tx: StoreTransactionContext, intent: GithubDispatchIntent) {
    const project = intent.project as ProjectId,
      card = intent.card as CardId;
    tx.events.append(project, {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(project, card),
      card_id: card,
      actor: { kind: "system", project_id: project },
      type: "github_check_dispatch",
      payload: { ...intent },
      created_at: new Date().toISOString(),
    });
  }
  claim(intent: GithubDispatchIntent): {
    intent: GithubDispatchIntent;
    fresh: boolean;
  } {
    return this.store.uow.run((tx) => {
      const previous = this.current(tx, intent.project, intent.card);
      const same = previous.find((value) => value.attempt === intent.attempt);
      if (same) {
        if (same.key !== intent.key || same.finished)
          throw new GithubExecutorError("security");
        return { intent: same, fresh: false };
      }
      if (previous.some((value) => !value.finished))
        throw new GithubExecutorError("card_busy");
      this.save(tx, intent);
      return { intent, fresh: true };
    });
  }
  /** Commit the at-most-once POST boundary; concurrent/restarted callers can only search afterward. */
  beginDispatch(intent: GithubDispatchIntent): boolean {
    return this.store.uow.run((tx) => {
      const current = this.current(tx, intent.project, intent.card).find(
        (value) => value.attempt === intent.attempt,
      );
      if (!current || current.finished || current.key !== intent.key)
        throw new GithubExecutorError("security");
      if (current.phase !== "reserved") return false;
      this.save(tx, { ...current, phase: "dispatching" });
      return true;
    });
  }
  bind(intent: GithubDispatchIntent, externalRun: ExternalGithubRun): void {
    this.store.uow.run((tx) => {
      const current = this.current(tx, intent.project, intent.card).find(
        (value) => value.attempt === intent.attempt,
      );
      if (
        !current ||
        current.finished ||
        current.phase !== "dispatching" ||
        current.key !== intent.key ||
        (current.externalRun &&
          JSON.stringify(current.externalRun) !== JSON.stringify(externalRun))
      )
        throw new GithubExecutorError("security");
      if (!current.externalRun) this.save(tx, { ...current, externalRun });
    });
  }
  /** D4 calls only after the bound remote run is confirmed terminal, not on a local timeout. */
  finish(intent: GithubDispatchIntent): void {
    this.store.uow.run((tx) => {
      const current = this.current(tx, intent.project, intent.card).find(
        (value) => value.attempt === intent.attempt,
      );
      if (!current || current.key !== intent.key || !current.externalRun)
        throw new GithubExecutorError("security");
      if (!current.finished) this.save(tx, { ...current, finished: true });
    });
  }
}
