import type { CardId, MergeCheckView, ProjectId } from "@cardigan/domain";
import type { Store, StoreTransactionContext } from "@cardigan/store";
import { GithubExecutorError, type GithubRun } from "./github-client.js";

export type ExternalGithubRun = NonNullable<MergeCheckView["external_run"]>;
export interface GithubDispatchIntent {
  readonly project: string;
  readonly card: string;
  readonly attempt: string;
  /** Digest of the complete trusted executor configuration and dispatch inputs. */
  readonly key: string;
  readonly startedAt: string;
  readonly executor?: string;
  readonly identity?: GithubRun;
  readonly phase: "reserved" | "dispatching";
  readonly externalRun?: ExternalGithubRun;
  readonly finished?: boolean;
  /** Persist before candidate publication; absent on older, unidentifiable intents. */
  readonly candidate?: {
    readonly repo: string;
    readonly ref: string;
    readonly sha: string;
    readonly delivery: string;
  };
  /** Permanent fence against dispatch/reuse once cleanup has begun. */
  readonly deleting?: boolean;
  readonly deleted?: boolean;
}
/** Durable system journal: reserve before IO, never redispatch an ambiguous intent. */
export class GithubDispatchJournal {
  constructor(private readonly store: Store) {}
  private current(
    tx: { events: Pick<StoreTransactionContext["events"], "listAfter"> },
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
      payload: JSON.parse(JSON.stringify(intent)),
      created_at: new Date().toISOString(),
    });
  }
  allAt(tx: {
    events: Pick<StoreTransactionContext["events"], "listAfter">;
    cards: Pick<StoreTransactionContext["cards"], "list">;
  }): GithubDispatchIntent[] {
    return this.store
      .listProjects()
      .flatMap((project) =>
        tx.cards
          .list(project.id)
          .flatMap((card) => this.current(tx, project.id, card.id)),
      );
  }
  unfinished(): GithubDispatchIntent[] {
    return this.all().filter((intent) => !intent.finished);
  }
  all(): GithubDispatchIntent[] {
    return this.store.uow.read((tx) => this.allAt(tx));
  }
  /** Fence under the same fresh transaction as eligibility checks. */
  beginCleanup(
    intent: GithubDispatchIntent,
    eligible: (tx: StoreTransactionContext) => boolean,
  ): boolean {
    return this.store.uow.run((tx) => {
      const current = this.current(tx, intent.project, intent.card).find(
        (value) => value.attempt === intent.attempt,
      );
      if (
        !current ||
        current.key !== intent.key ||
        !current.finished ||
        current.deleted ||
        !eligible(tx)
      )
        return false;
      if (!current.deleting) this.save(tx, { ...current, deleting: true });
      return true;
    });
  }
  completeCleanup(intent: GithubDispatchIntent): void {
    this.store.uow.run((tx) => {
      const current = this.current(tx, intent.project, intent.card).find(
        (value) => value.attempt === intent.attempt,
      );
      if (!current?.deleting || current.key !== intent.key)
        throw new GithubExecutorError("security");
      if (!current.deleted) this.save(tx, { ...current, deleted: true });
    });
  }
  /** Scope recovery to its exact card/attempt; never scan other cards to retry. */
  hasUnboundIntent(project: string, card: string, attempt: string): boolean {
    return this.store.uow.read((tx) =>
      this.current(tx, project, card).some(
        (intent) =>
          intent.attempt === attempt && !intent.finished && !intent.externalRun,
      ),
    );
  }
  claim(
    intent: GithubDispatchIntent,
    maxConcurrent?: number,
  ): {
    intent: GithubDispatchIntent;
    fresh: boolean;
  } {
    return this.store.uow.run((tx) => {
      const previous = this.current(tx, intent.project, intent.card);
      const same = previous.find((value) => value.attempt === intent.attempt);
      if (same) {
        if (
          same.deleting ||
          same.key !== intent.key ||
          (same.finished && !same.externalRun)
        )
          throw new GithubExecutorError("security");
        return { intent: same, fresh: false };
      }
      if (
        intent.candidate &&
        this.allAt(tx).some(
          (value) =>
            value.candidate?.repo === intent.candidate?.repo &&
            value.candidate?.ref === intent.candidate?.ref,
        )
      )
        throw new GithubExecutorError("security");
      if (previous.some((value) => !value.finished))
        throw new GithubExecutorError("card_busy");
      if (intent.executor && maxConcurrent !== undefined) {
        const count = this.allAt(tx).filter(
          (value) => !value.finished && value.executor === intent.executor,
        ).length;
        if (count >= maxConcurrent) throw new GithubExecutorError("card_busy");
      }
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
      if (
        !current ||
        current.deleting ||
        current.finished ||
        current.key !== intent.key
      )
        throw new GithubExecutorError("security");
      if (current.phase !== "reserved") return false;
      this.save(tx, { ...current, phase: "dispatching" });
      return true;
    });
  }
  bind(
    intent: GithubDispatchIntent,
    externalRun: ExternalGithubRun,
    identity?: GithubRun,
  ): void {
    this.store.uow.run((tx) => {
      const current = this.current(tx, intent.project, intent.card).find(
        (value) => value.attempt === intent.attempt,
      );
      if (
        current?.phase !== "dispatching" ||
        current.deleting ||
        current.key !== intent.key ||
        (current.externalRun &&
          JSON.stringify(current.externalRun) !== JSON.stringify(externalRun))
      )
        throw new GithubExecutorError("security");
      if (!current.externalRun || (!current.identity && identity))
        this.save(tx, {
          ...current,
          externalRun,
          ...(identity
            ? {
                identity: {
                  id: identity.id,
                  run_attempt: identity.run_attempt,
                  path: identity.path,
                  event: identity.event,
                  head_branch: identity.head_branch,
                  head_sha: identity.head_sha,
                  actor: { login: identity.actor.login },
                  display_title: identity.display_title,
                  html_url: identity.html_url,
                  created_at: identity.created_at,
                },
              }
            : {}),
        });
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
