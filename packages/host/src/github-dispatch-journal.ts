import type {
  CardId,
  DeliveryId,
  Event,
  MergeCheckView,
  ProjectId,
} from "@cardigan/domain";
import { latestMergeCheck, prechecks } from "@cardigan/domain";
import type {
  ReadRepositories,
  Store,
  StoreTransactionContext,
} from "@cardigan/store";
import { GithubExecutorError, type GithubRun } from "./github-client.js";
import { GithubRetryLater } from "./github-rate-limit.js";
import type { ProjectMergeGate } from "./merge-gate-config.js";
import { type ExecutionOwner, executionOwner } from "./process-identity.js";

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
  readonly phase: "reserved" | "publishing" | "dispatching";
  /** Diagnostic controller identity only; its exit does not prove Git writers stopped. */
  readonly publisher?: ExecutionOwner;
  readonly nextDiscoveryAt?: number;
  readonly discoveryDeadlineAt?: number;
  /** Unverified dispatch response ID; only a lookup hint until full binding. */
  readonly dispatchedRunId?: number;
  readonly externalRun?: ExternalGithubRun;
  readonly finished?: boolean;
  /** Business abandonment is not proof that a dispatched remote run stopped. */
  readonly abandoned?: "superseded" | "attempt_finished" | "executor_changed";
  readonly abandonmentReason?: string;
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
const projectedIntents = new WeakMap<
  readonly Event[],
  readonly GithubDispatchIntent[]
>();
function intentsFrom(
  events: readonly Event[],
): readonly GithubDispatchIntent[] {
  let result = projectedIntents.get(events);
  if (!result) {
    const latest = new Map<string, GithubDispatchIntent>();
    for (const e of events)
      if (e.type === "github_check_dispatch" && e.actor.kind === "system") {
        const value = e.payload as unknown as GithubDispatchIntent;
        latest.set(value.attempt, value);
      }
    result = [...latest.values()];
    projectedIntents.set(events, result);
  }
  return result;
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
    events: Pick<
      StoreTransactionContext["events"],
      "listAfter" | "listStreams"
    >;
    cards: Pick<StoreTransactionContext["cards"], "list">;
  }): GithubDispatchIntent[] {
    return this.store.listProjects().flatMap((project) => {
      const streams = tx.events.listStreams?.(project.id);
      return tx.cards
        .list(project.id)
        .flatMap((card) =>
          streams
            ? structuredClone(intentsFrom(streams.get(card.id) ?? []))
            : this.current(tx, project.id, card.id),
        );
    });
  }
  unfinished(): GithubDispatchIntent[] {
    return this.all().filter((intent) => !intent.finished);
  }
  all(): GithubDispatchIntent[] {
    return this.store.uow.read((tx) => this.allAt(tx));
  }
  /** Reconcile before admission, including projects that have switched away from GitHub. */
  reconcile(
    projects: readonly string[],
    settings: (project: string) => ProjectMergeGate,
  ): void {
    this.store.uow.run((tx) => {
      for (const intent of this.allAt(tx)) {
        if (
          !projects.includes(intent.project) ||
          intent.finished ||
          intent.abandoned
        )
          continue;
        const author = this.candidatePrecheck(tx, intent);
        const check = author ?? this.candidateCheck(tx, intent);
        if (!check) continue; // Unknown/mismatched identity never releases capacity.
        // Publishing survives restart: the controller may have orphaned a Git
        // writer. Only the original settled push may retire that IO fence.
        const project = intent.project as ProjectId;
        const card = tx.cards.get(project, intent.card as CardId);
        const events = tx.events.listAfter(project, intent.card as CardId, 0);
        const completion =
          !author && "completion_id" in check
            ? tx.deliveries.get(project, check.completion_id)
            : undefined;
        const latest = author
          ? prechecks(events)
              .filter((c) => c.assignment_id === author.assignment_id)
              .at(-1)
          : "completion_id" in check
            ? latestMergeCheck(
                events,
                intent.card as CardId,
                check.completion_id,
              )
            : undefined;
        const config = settings(intent.project);
        let abandoned: GithubDispatchIntent["abandoned"];
        if (
          card?.status === "done" ||
          card?.status === "cancelled" ||
          completion?.status === "superseded" ||
          (latest &&
            (latest.attempt_id !== intent.attempt ||
              ("recheck_requested" in latest && latest.recheck_requested)))
        )
          abandoned = "superseded";
        else if (latest && !["queued", "running"].includes(latest.status))
          abandoned = "attempt_finished";
        else if (
          config.status === "disabled" ||
          (config.status === "enabled" &&
            (config.executor?.type !== "github" ||
              config.executor.name !== intent.executor))
        )
          abandoned = "executor_changed";
        if (!abandoned) continue;
        this.save(tx, {
          ...intent,
          abandoned,
          abandonmentReason: `${author ? "Author precheck" : "Merge check"}: ${abandoned}; ${intent.phase === "reserved" && !intent.publisher && !intent.dispatchedRunId && !intent.externalRun && !intent.identity ? "no dispatch or unsettled publisher; reservation released" : "awaiting publisher settlement or verified remote terminal"}`,
          // Dispatch is fenced before any candidate IO. A reserved intent has
          // no remote writer; a POST/remote result of unknown status still counts.
          ...(intent.phase === "reserved" &&
          !intent.publisher &&
          !intent.dispatchedRunId &&
          !intent.externalRun &&
          !intent.identity
            ? { finished: true }
            : {}),
        });
      }
    });
  }
  /** Author candidates bind to the original trusted attempt and Assignment, not a Delivery. */
  candidatePrecheck(
    tx: Pick<ReadRepositories, "events" | "cards">,
    intent: GithubDispatchIntent,
  ) {
    const candidate = intent.candidate;
    if (
      !candidate ||
      !intent.executor ||
      candidate.ref !==
        `refs/heads/ci/${intent.card}/${candidate.delivery}/${intent.attempt}` ||
      !/^[a-f0-9]{40}$/u.test(candidate.sha)
    )
      return undefined;
    const project = intent.project as ProjectId;
    if (!tx.cards.get(project, intent.card as CardId)) return undefined;
    return prechecks(
      tx.events.listAfter(project, intent.card as CardId, 0),
    ).find(
      (check) =>
        check.attempt_id === intent.attempt &&
        check.card_id === intent.card &&
        check.assignment_id === candidate.delivery &&
        check.candidate_sha === candidate.sha &&
        check.executor?.type === "github" &&
        check.executor.name === intent.executor,
    );
  }
  /** Match the original trusted check, not merely a similarly named remote ref. */
  candidateCheck(
    tx: Pick<
      ReadRepositories,
      "events" | "cards" | "deliveries" | "work_items"
    >,
    intent: GithubDispatchIntent,
  ): MergeCheckView | undefined {
    const candidate = intent.candidate;
    if (
      !candidate ||
      !intent.executor ||
      candidate.ref !==
        `refs/heads/ci/${intent.card}/${candidate.delivery}/${intent.attempt}` ||
      !/^[a-f0-9]{40}$/u.test(candidate.sha)
    )
      return undefined;
    const project = intent.project as ProjectId;
    const card = tx.cards.get(project, intent.card as CardId);
    const completion = tx.deliveries.get(
      project,
      candidate.delivery as DeliveryId,
    );
    if (
      !card ||
      completion?.kind !== "card_completion" ||
      tx.work_items.get(project, completion.work_item_id)?.card_id !== card.id
    )
      return undefined;
    const check = latestMergeCheck(
      tx.events
        .listAfter(project, card.id, 0)
        .filter(
          (event) =>
            event.actor.kind === "system" &&
            event.actor.project_id === project &&
            (event.payload as Partial<MergeCheckView> | null)?.attempt_id ===
              intent.attempt,
        ),
      card.id,
      completion.id,
    );
    return check?.candidate_sha === candidate.sha &&
      check.executor?.type === "github" &&
      check.executor.name === intent.executor
      ? check
      : undefined;
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
          same.abandoned ||
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
  /** Recovery of abandoned work is read-only until its original run is verified. */
  recoverAbandoned(intent: GithubDispatchIntent): GithubDispatchIntent {
    return this.store.uow.read((tx) => {
      const current = this.current(tx, intent.project, intent.card).find(
        (value) => value.attempt === intent.attempt,
      );
      if (
        !current ||
        current.key !== intent.key ||
        !current.abandoned ||
        current.finished ||
        current.deleting ||
        current.phase !== "dispatching"
      )
        throw new GithubExecutorError("security");
      return current;
    });
  }
  /** Persist the existing maintenance cadence across controllers and restarts. */
  beginDiscovery(
    intent: GithubDispatchIntent,
    now: number,
    interval: number,
    dispatchedRunId?: number,
  ): void {
    this.store.uow.run((tx) => {
      const current = this.current(tx, intent.project, intent.card).find(
        (value) => value.attempt === intent.attempt,
      );
      if (
        !current ||
        current.key !== intent.key ||
        current.phase !== "dispatching" ||
        current.finished ||
        current.deleting
      )
        throw new GithubExecutorError("security");
      if (
        current.nextDiscoveryAt !== undefined &&
        now < current.nextDiscoveryAt
      )
        throw new GithubRetryLater(current.nextDiscoveryAt);
      if (
        current.dispatchedRunId !== undefined &&
        current.dispatchedRunId !== dispatchedRunId
      )
        throw new GithubExecutorError("security");
      this.save(tx, {
        ...current,
        nextDiscoveryAt: now + interval,
        ...(dispatchedRunId !== undefined ? { dispatchedRunId } : {}),
      });
    });
  }
  /** Only one publisher may cross the IO boundary; unfinished IO stays conservative. */
  beginPublication(intent: GithubDispatchIntent): boolean {
    return this.store.uow.run((tx) => {
      const current = this.current(tx, intent.project, intent.card).find(
        (value) => value.attempt === intent.attempt,
      );
      if (
        !current ||
        current.deleting ||
        current.abandoned ||
        current.finished ||
        current.key !== intent.key
      )
        throw new GithubExecutorError("security");
      if (current.phase !== "reserved") return false;
      const publisher = executionOwner(process.pid);
      if (!publisher) throw new GithubExecutorError("recovery_incomplete");
      this.save(tx, { ...current, phase: "publishing", publisher });
      return true;
    });
  }
  /** Called only by the publisher after its push has settled, before any POST. */
  beginDispatch(intent: GithubDispatchIntent, cancelled = false): boolean {
    return this.store.uow.run((tx) => {
      const current = this.current(tx, intent.project, intent.card).find(
        (value) => value.attempt === intent.attempt,
      );
      if (
        !current ||
        current.key !== intent.key ||
        current.deleting ||
        current.finished
      )
        throw new GithubExecutorError("security");
      if (current.phase !== "publishing") return false;
      const { publisher: _publisher, ...settled } = current;
      if (current.abandoned || cancelled) {
        this.save(tx, {
          ...settled,
          phase: "reserved",
          ...(current.abandoned ? { finished: true } : {}),
        });
        return false;
      }
      this.save(tx, { ...settled, phase: "dispatching" });
      return true;
    });
  }
  bind(
    intent: GithubDispatchIntent,
    externalRun: ExternalGithubRun,
    identity?: GithubRun,
  ): boolean {
    return this.store.uow.run((tx) => {
      const current = this.current(tx, intent.project, intent.card).find(
        (value) => value.attempt === intent.attempt,
      );
      if (
        current?.phase !== "dispatching" ||
        current.deleting ||
        (current.finished && !current.externalRun) ||
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
      return !current.abandoned;
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
