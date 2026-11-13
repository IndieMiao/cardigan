import type { CardId, Clock, DomainError, ProjectId } from "@cardigan/domain";

/**
 * C-112: the merge and merge-check loops skip cards whose plan does not
 * validate. Report each skip with its reason once, and again only when the
 * reason changes, so a card that waits for hours does not flood the log.
 */
export class MergeSkipLog {
  private readonly last = new Map<string, string>();
  constructor(
    private readonly loop: string,
    private readonly report: (message: string) => void,
    private readonly clock: Clock = { now: () => new Date().toISOString() },
  ) {}
  /** A card whose plan did not validate this pass. */
  skipped(project_id: ProjectId, card_id: CardId, error: DomainError): void {
    const key = `${project_id}/${card_id}`;
    const reason = `${error.code}: ${error.message}`;
    if (this.last.get(key) === reason) return;
    try {
      this.report(
        `[${this.clock.now()}] ${this.loop} skipped ${project_id}/${card_id}: ${reason}`,
      );
    } catch {
      // Logging must never stop the loop; an undelivered reason is retried.
      return;
    }
    this.last.set(key, reason);
  }
  /** The card's plan validated, so a later skip is news again. */
  ready(project_id: ProjectId, card_id: CardId): void {
    this.last.delete(`${project_id}/${card_id}`);
  }
  /** Forget cards of this project that are no longer awaiting merge. */
  retain(project_id: ProjectId, awaiting: ReadonlySet<CardId>): void {
    const prefix = `${project_id}/`;
    for (const key of this.last.keys())
      if (
        key.startsWith(prefix) &&
        !awaiting.has(key.slice(prefix.length) as CardId)
      )
        this.last.delete(key);
  }
}
