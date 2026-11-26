import type { CardId, DeliveryId, ProjectId } from "@cardigan/domain";
import { latestMergeCheck, prechecks } from "@cardigan/domain";
import type { CandidateDeleteRequest } from "@cardigan/git-transport";
import { candidateDeleteCommand } from "@cardigan/git-transport";
import type { ReadRepositories, Store } from "@cardigan/store";
import {
  type GithubDispatchIntent,
  GithubDispatchJournal,
} from "./github-dispatch-journal.js";
import { GITHUB_POLL_DEFAULTS } from "./github-rate-limit.js";
import type { GithubMergeGateExecutor } from "./merge-gate-executors.js";

/** Only durable, identified host candidates are collectible. Unknown remote refs stay untouched. */
export class GithubBranchCleaner {
  private work: Promise<void> | undefined;
  private next = 0;
  constructor(
    private readonly options: {
      store: Store;
      config: GithubMergeGateExecutor;
      token: () => Promise<string>;
      remove: (
        project: string,
        request: CandidateDeleteRequest,
      ) => Promise<boolean>;
      now?: () => number;
      onError?: () => void;
    },
  ) {}
  tick(projects: readonly string[]): Promise<void> {
    if (this.work) return this.work;
    const now = this.options.now?.() ?? Date.now();
    if (now < this.next) return Promise.resolve();
    this.next =
      now +
      (this.options.config.pollIntervalMs ??
        GITHUB_POLL_DEFAULTS.pollIntervalMs);
    this.work = this.cycle(projects, now).finally(() => {
      this.work = undefined;
    });
    return this.work;
  }
  private eligible(
    tx: Pick<
      ReadRepositories,
      "cards" | "deliveries" | "work_items" | "events"
    >,
    intent: GithubDispatchIntent,
    now: number,
    // Only reuse within this read transaction. beginCleanup takes a fresh view
    // after token/IO awaits and repeats all ownership and lifecycle checks.
    snapshot?: readonly GithubDispatchIntent[],
  ): boolean {
    const { config } = this.options;
    const candidate = intent.candidate;
    if (
      !candidate ||
      !intent.finished ||
      intent.deleted ||
      intent.executor !== config.name ||
      candidate.repo !== config.repo ||
      candidate.ref !==
        `refs/heads/ci/${intent.card}/${candidate.delivery}/${intent.attempt}`
    )
      return false;
    const journal = new GithubDispatchJournal(this.options.store);
    if (intent.abandoned && intent.phase === "reserved") {
      if (
        intent.externalRun ||
        intent.identity ||
        (!journal.candidateCheck(tx, intent) &&
          !journal.candidatePrecheck(tx, intent))
      )
        return false;
    } else {
      if (!intent.identity || !intent.externalRun) return false;
      const fields = intent.identity.display_title.split("/");
      if (
        fields.length !== 7 ||
        fields[0] !== "cardigan" ||
        fields[1] !== intent.card ||
        fields[2] !== candidate.delivery ||
        fields[3] !== intent.attempt ||
        !["merge_check", "precheck"].includes(fields[4] ?? "") ||
        fields[5] !== candidate.sha ||
        intent.identity.id !== intent.externalRun.run_id
      )
        return false;
    }
    // Includes every project/executor sharing this repository, not just this maintenance pass.
    const all = snapshot ?? journal.allAt(tx);
    if (
      all.some(
        (other) =>
          !other.finished &&
          !other.candidate &&
          other.card === intent.card &&
          other.attempt === intent.attempt,
      )
    )
      return false;
    // C-796: every newest intent with this candidate, retired ones included.
    const owners = journal.candidateOwnersAt(tx, candidate);
    if (owners.length !== 1 || owners[0]?.key !== intent.key) return false;
    const project = intent.project as ProjectId;
    const card = tx.cards.get(project, intent.card as CardId);
    const author = journal.candidatePrecheck(tx, intent);
    if (author) {
      if (!card) return false;
      if (intent.abandoned || ["done", "cancelled"].includes(card.status))
        return true;
      const latest = prechecks(tx.events.listAfter(project, card.id, 0))
        .filter((c) => c.assignment_id === author.assignment_id)
        .at(-1);
      return (
        latest !== undefined &&
        latest.attempt_id !== intent.attempt &&
        now - Date.parse(intent.startedAt) >=
          (config.branchRetentionMs ?? GITHUB_POLL_DEFAULTS.branchRetentionMs)
      );
    }
    const completion = tx.deliveries.get(
      project,
      candidate.delivery as DeliveryId,
    );
    const item =
      completion && tx.work_items.get(project, completion.work_item_id);
    if (
      !card ||
      !completion ||
      completion.kind !== "card_completion" ||
      item?.card_id !== card.id
    )
      return false;
    // Abandoned reservations have no remote run; the durable dispatch fence
    // and exact candidate lease permit immediate cleanup of their own ref.
    if (intent.abandoned) return true;
    if (
      card.status === "done" ||
      card.status === "cancelled" ||
      completion.status === "superseded"
    )
      return true;
    // A completed older attempt is an orphan only after retention and a newer attempt exists.
    const latest = latestMergeCheck(
      tx.events.listAfter(project, card.id, 0),
      card.id,
      completion.id,
    );
    const started = Date.parse(intent.startedAt);
    return (
      Number.isFinite(started) &&
      now - started >=
        (config.branchRetentionMs ?? GITHUB_POLL_DEFAULTS.branchRetentionMs) &&
      latest !== undefined &&
      latest.attempt_id !== intent.attempt
    );
  }
  private async cycle(projects: readonly string[], now: number): Promise<void> {
    const journal = new GithubDispatchJournal(this.options.store);
    try {
      const candidates = this.options.store.uow.read((tx) => {
        const all = journal.allAt(tx);
        return all.filter((intent) => {
          if (!projects.includes(intent.project)) return false;
          try {
            return this.eligible(tx, intent, now, all);
          } catch {
            this.report();
            return false;
          }
        });
      });
      for (const intent of candidates) {
        try {
          const candidate = intent.candidate;
          if (!candidate) continue;
          const request = { ...candidate, token: await this.options.token() };
          // Validate before fencing. No secret-bearing errors escape this boundary.
          candidateDeleteCommand("/unused", request);
          if (
            !journal.beginCleanup(intent, (tx) =>
              this.eligible(tx, intent, now),
            )
          )
            continue;
          if (!(await this.options.remove(intent.project, request)))
            throw new Error("cleanup failed");
          journal.completeCleanup(intent);
        } catch {
          this.report();
        }
      }
    } catch {
      this.report();
    }
  }
  private report() {
    try {
      this.options.onError?.();
    } catch {
      /* Diagnostic only. */
    }
  }
}
