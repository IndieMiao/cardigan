import type { Store } from "@cardigan/store";
import type {
  GithubBudgetState,
  GithubBudgetStorage,
} from "./github-rate-limit.js";

/** Host-only global audit stream, keyed by executor across projects and process generations. */
export class GithubBudgetJournal implements GithubBudgetStorage {
  constructor(
    private readonly store: Store,
    private readonly executor: string,
  ) {}
  update<T>(operation: (state: GithubBudgetState) => T): T {
    return this.store.uow.run((tx) => {
      const row = this.store.database
        .prepare(`SELECT doc FROM global_events
        WHERE type = 'github_rest_budget' AND json_extract(doc, '$.payload.executor') = ?
        ORDER BY seq DESC LIMIT 1`)
        .get(this.executor);
      const payload = row ? JSON.parse(String(row.doc)).payload : undefined;
      const state: GithubBudgetState = payload
        ? {
            window: payload.window,
            used: payload.used,
            blockedUntil: payload.blockedUntil,
          }
        : { window: 0, used: 0, blockedUntil: 0 };
      if (
        ![state.window, state.used, state.blockedUntil].every(
          (value) => Number.isSafeInteger(value) && value >= 0,
        )
      )
        throw new Error("Invalid GitHub budget journal");
      const before = JSON.stringify(state);
      const result = operation(state);
      if (JSON.stringify(state) !== before)
        tx.global_events.append({
          id: tx.global_ids.nextEventId(),
          seq: tx.global_ids.nextEventSequence(),
          actor: { kind: "system" },
          type: "github_rest_budget",
          payload: { executor: this.executor, ...state },
          created_at: new Date().toISOString(),
        });
      return result;
    });
  }
}
