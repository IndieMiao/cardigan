import type {
  CardId,
  DeliveryId,
  Event,
  MergeCheckView,
  ProjectId,
  TimelineEntryId,
} from "@cardigan/domain";
import { latestMergeCheck, mergeBatches, prechecks } from "@cardigan/domain";
import type {
  ReadRepositories,
  Store,
  StoreTransactionContext,
} from "@cardigan/store";
import { CheckExecutorSuspended } from "./checkout-deadline.js";
import { GithubExecutorError, type GithubRun } from "./github-client.js";
import {
  GithubRetryLater,
  type MaintenanceRetry,
} from "./github-rate-limit.js";
import type { ProjectMergeGate } from "./merge-gate-config.js";
import { type ExecutionOwner, executionOwner } from "./process-identity.js";

export type ExternalGithubRun = NonNullable<MergeCheckView["external_run"]>;
export interface RetryBinding {
  readonly current?: MaintenanceRetry;
  save(retry: MaintenanceRetry | undefined): void;
}
export interface GithubDispatchIntent {
  readonly maintenanceRetry?: MaintenanceRetry | undefined;
  readonly project: string;
  readonly card: string;
  readonly attempt: string;
  /** Digest of the complete trusted executor configuration and dispatch inputs. */
  readonly key: string;
  readonly startedAt: string;
  readonly executor?: string;
  readonly identity?: GithubRun;
  readonly phase: "reserved" | "publishing" | "dispatching";
  /** A confirmed undispatched hold releases admission only, never execution identity. */
  readonly admission_suspended?: boolean;
  /** Diagnostic controller identity only; its exit does not prove Git writers stopped. */
  readonly publisher?: ExecutionOwner;
  readonly nextDiscoveryAt?: number;
  readonly discoveryDeadlineAt?: number;
  /** Unverified dispatch response ID; only a lookup hint until full binding. */
  readonly dispatchedRunId?: number;
  /** Only the validated response ID permits ignoring the provider's run title. */
  readonly boundByDispatchId?: boolean;
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
  constructor(
    private readonly store: Store,
    /** Host-only isolated probe stream; workflow identity remains card=probe. */
    private readonly probeCard?: CardId,
  ) {}
  /** One visible progress entry per attempt; events retain the observation history. */
  progress(
    project: ProjectId,
    card: CardId,
    attempt: string,
    summary: string,
    at: string,
  ): void {
    this.store.uow.run((tx) => {
      const intent = this.current(tx, project, card).find(
        (value) => value.attempt === attempt,
      );
      if (!intent?.externalRun || intent.finished || intent.abandoned) return;
      const previous = tx.events
        .listAfter(project, card, 0)
        .findLast(
          (event) =>
            event.type === "github_check_progress" &&
            event.actor.kind === "system" &&
            (event.payload as { attempt?: string }).attempt === attempt,
        );
      const old = previous?.payload as
        | { summary?: string; entry?: TimelineEntryId }
        | undefined;
      if (old?.summary === summary) return;
      const entry = old?.entry ?? tx.ids.nextTimelineEntryId(project, card);
      const seq = tx.ids.nextEventSequence(project, card);
      tx.events.append(project, {
        id: tx.ids.nextEventId(),
        seq,
        card_id: card,
        type: "github_check_progress",
        actor: { kind: "system", project_id: project },
        payload: { attempt, summary, entry },
        created_at: at,
      });
      tx.timeline.put(project, {
        id: entry,
        short_id: entry,
        card_id: card,
        event_seq: seq,
        type: "system",
        author: "system",
        refs: [],
        mentions: [],
        retracted: false,
        created_at: at,
        body: `检查 ${attempt}：${summary}`,
      });
    });
  }
  private current(
    tx: { events: Pick<StoreTransactionContext["events"], "listAfter"> },
    project: string,
    card: string,
  ): GithubDispatchIntent[] {
    const latest = new Map<string, GithubDispatchIntent>();
    for (const event of tx.events.listAfter(
      project as ProjectId,
      this.probeCard ?? (card as CardId),
      0,
    )) {
      if (
        event.type !==
          (this.probeCard
            ? "github_probe_dispatch"
            : "github_check_dispatch") ||
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
      card = this.probeCard ?? (intent.card as CardId);
    tx.events.append(project, {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(project, card),
      card_id: card,
      actor: { kind: "system", project_id: project },
      type: this.probeCard ? "github_probe_dispatch" : "github_check_dispatch",
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
      const streams = this.probeCard
        ? undefined
        : tx.events.listStreams?.(project.id);
      return tx.cards
        .list(project.id)
        .filter((card) => !this.probeCard || card.id === this.probeCard)
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
  private unstarted(intent: GithubDispatchIntent): boolean {
    return (
      intent.phase === "reserved" &&
      intent.publisher === undefined &&
      intent.dispatchedRunId === undefined &&
      intent.nextDiscoveryAt === undefined &&
      intent.externalRun === undefined &&
      intent.identity === undefined
    );
  }
  private admissionIntents(
    tx: StoreTransactionContext,
    intents = this.allAt(tx),
  ): GithubDispatchIntent[] {
    return intents.map((intent) => {
      if (
        !intent.finished &&
        !intent.admission_suspended &&
        this.unstarted(intent) &&
        tx.cards.get(intent.project as ProjectId, intent.card as CardId)?.hold
      ) {
        const paused = { ...intent, admission_suspended: true };
        this.save(tx, paused);
        return paused;
      }
      return intent;
    });
  }
  /** Scheduling projection; unknown IO remains in the admission count. */
  admitted(): GithubDispatchIntent[] {
    return this.store.uow.run((tx) =>
      this.admissionIntents(tx).filter(
        (intent) =>
          !intent.finished &&
          !(intent.admission_suspended && this.unstarted(intent)),
      ),
    );
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
        const batch =
          "batch_id" in check && check.batch_id
            ? mergeBatches(tx.events.listAfter(project, undefined, 0)).find(
                (b) => b.id === check.batch_id,
              )
            : undefined;
        const latest = batch
          ? batch.check
          : author
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
          (batch &&
            ["aborted", "resolved", "published"].includes(batch.status)) ||
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
    const batchCheck = tx.events
      .listAfter(project, undefined, 0)
      .filter(
        (e) =>
          e.actor.kind === "system" && e.type.startsWith("merge_batch_check_"),
      )
      .map((e) => (e.payload as unknown as { check: MergeCheckView }).check)
      .findLast(
        (c) =>
          c?.attempt_id === intent.attempt && c.completion_id === completion.id,
      );
    if (batchCheck)
      return batchCheck.candidate_sha === candidate.sha &&
        batchCheck.executor?.type === "github" &&
        batchCheck.executor.name === intent.executor
        ? batchCheck
        : undefined;
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
  finishUnpublishedProbe(intent: GithubDispatchIntent): void {
    this.store.uow.run((tx) => {
      const current = this.current(tx, intent.project, intent.card).find(
        (value) => value.attempt === intent.attempt,
      );
      // Reserved means publication has not begun, or its original writer has
      // settled without crossing POST. Publishing/ambiguous dispatch stay held.
      if (
        !this.probeCard ||
        !current ||
        current.key !== intent.key ||
        current.phase !== "reserved" ||
        current.publisher ||
        current.externalRun ||
        current.identity ||
        current.dispatchedRunId
      )
        throw new GithubExecutorError("security");
      if (!current.finished) this.save(tx, { ...current, finished: true });
    });
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
    const result = this.store.uow.run((tx) => {
      const all = this.admissionIntents(tx);
      const previous = all.filter(
        (v) => v.project === intent.project && v.card === intent.card,
      );
      const same = previous.find((value) => value.attempt === intent.attempt);
      const capacity = (exclude?: GithubDispatchIntent) => {
        if (!intent.executor || maxConcurrent === undefined) return true;
        // Probe and check streams share the executor's admission limit.
        const checks = new GithubDispatchJournal(this.store).admissionIntents(
          tx,
        );
        const probes = this.store.listProjects().flatMap((project) =>
          tx.cards.list(project.id).flatMap((card) => {
            const journal = new GithubDispatchJournal(this.store, card.id);
            return journal.admissionIntents(
              tx,
              journal.current(tx, project.id, card.id),
            );
          }),
        );
        return (
          [...checks, ...probes].filter(
            (value) =>
              !value.finished &&
              value.executor === intent.executor &&
              value.key !== exclude?.key &&
              !(value.admission_suspended && this.unstarted(value)),
          ).length < maxConcurrent
        );
      };
      if (same) {
        if (
          same.deleting ||
          same.abandoned ||
          same.key !== intent.key ||
          (same.finished && !same.externalRun)
        )
          throw new GithubExecutorError("security");
        if (this.unstarted(same)) {
          if (
            tx.cards.get(intent.project as ProjectId, intent.card as CardId)
              ?.hold ||
            !capacity(same)
          )
            return undefined;
          if (
            !same.admission_suspended &&
            same.startedAt === intent.startedAt &&
            same.discoveryDeadlineAt === intent.discoveryDeadlineAt
          )
            return { intent: same, fresh: false };
          const { admission_suspended: _paused, ...rest } = same;
          const resumed = {
            ...rest,
            startedAt: intent.startedAt,
            ...(intent.discoveryDeadlineAt === undefined
              ? {}
              : { discoveryDeadlineAt: intent.discoveryDeadlineAt }),
          };
          this.save(tx, resumed);
          return { intent: resumed, fresh: false };
        }
        return { intent: same, fresh: false };
      }
      if (
        tx.cards.get(intent.project as ProjectId, intent.card as CardId)?.hold
      )
        return undefined;
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
      if (!capacity()) throw new GithubExecutorError("card_busy");
      this.save(tx, intent);
      return { intent, fresh: true };
    });
    if (!result) throw new CheckExecutorSuspended();
    return result;
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
  /** Only update investigation state on the exact, still-live reservation. Never finish it. */
  retryBinding(intent: GithubDispatchIntent): RetryBinding {
    let expected = intent.maintenanceRetry;
    return {
      ...(intent.maintenanceRetry ? { current: intent.maintenanceRetry } : {}),
      save: (retry) =>
        this.store.uow.run((tx) => {
          const current = this.current(tx, intent.project, intent.card).find(
            (v) => v.attempt === intent.attempt,
          );
          if (
            !current ||
            current.key !== intent.key ||
            current.finished ||
            current.deleting ||
            current.phase !== "dispatching" ||
            current.externalRun?.run_id !== intent.externalRun?.run_id
          )
            return;
          const { maintenanceRetry: old, ...rest } = current;
          if (
            old?.retryAt !== expected?.retryAt ||
            old?.reason !== expected?.reason
          )
            return;
          expected = retry;
          this.save(tx, retry ? { ...rest, maintenanceRetry: retry } : rest);
        }),
    };
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
    const result = this.store.uow.run((tx) => {
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
      if (!this.unstarted(current)) return false;
      if (
        tx.cards.get(intent.project as ProjectId, intent.card as CardId)?.hold
      ) {
        if (this.unstarted(current))
          this.save(tx, { ...current, admission_suspended: true });
        return "held" as const;
      }
      if (current.admission_suspended) return "held" as const;
      if (
        current.startedAt !== intent.startedAt ||
        current.discoveryDeadlineAt !== intent.discoveryDeadlineAt
      )
        return false;
      const publisher = executionOwner(process.pid);
      if (!publisher) throw new GithubExecutorError("recovery_incomplete");
      this.save(tx, { ...current, phase: "publishing", publisher });
      return true;
    });
    if (result === "held") throw new CheckExecutorSuspended();
    return result;
  }
  /** Called only by the publisher after its push has settled, before any POST. */
  beginDispatch(intent: GithubDispatchIntent, cancelled = false): boolean {
    const result = this.store.uow.run((tx) => {
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
      const held = !!tx.cards.get(
        intent.project as ProjectId,
        intent.card as CardId,
      )?.hold;
      if (current.abandoned || cancelled || held) {
        this.save(tx, {
          ...settled,
          phase: "reserved",
          ...(held && this.unstarted({ ...settled, phase: "reserved" })
            ? { admission_suspended: true }
            : {}),
          ...(current.abandoned ? { finished: true } : {}),
        });
        return held ? ("held" as const) : false;
      }
      this.save(tx, { ...settled, phase: "dispatching" });
      return true;
    });
    if (result === "held") throw new CheckExecutorSuspended();
    return result;
  }
  bind(
    intent: GithubDispatchIntent,
    externalRun: ExternalGithubRun,
    identity?: GithubRun,
    boundByDispatchId = false,
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
        (boundByDispatchId && current.dispatchedRunId !== externalRun.run_id) ||
        (current.externalRun &&
          JSON.stringify(current.externalRun) !== JSON.stringify(externalRun))
      )
        throw new GithubExecutorError("security");
      if (!current.externalRun || (!current.identity && identity))
        this.save(tx, {
          ...current,
          maintenanceRetry: undefined,
          externalRun,
          ...(boundByDispatchId ? { boundByDispatchId: true } : {}),
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
