import { CommandDraft, type CommandState } from "./commands/core.js";
import { hasActivePmOps } from "./commands/delegation.js";
import {
  DEFAULT_RUNTIME_UNKNOWN_GRACE_MS,
  runtimeUnknownDeferred,
} from "./commands/runtime-incident.js";
import { systemRuleAttention } from "./commands/system-rules.js";
import { reviewLimitAttention } from "./review-limit-attention.js";

/** Discrete clock-dependent membership, reusing existing rules and thresholds.
 * Elapsed display values are rebased separately; they are not cache lifetimes.
 */
export function needsYouReadPhase(
  state: CommandState,
  now: string,
  runtimeGrace = DEFAULT_RUNTIME_UNKNOWN_GRACE_MS,
): string {
  const draft = new CommandDraft(
    state,
    { kind: "human", project_id: state.project_id },
    "list_needs_you",
  );
  return JSON.stringify([
    reviewLimitAttention(state, now).map(
      ({ waited_ms: _age, ...item }) => item,
    ),
    systemRuleAttention(draft, now)
      .filter((f) => !f.assignment_id && !hasActivePmOps(draft))
      .map(({ waited_ms: _age, ...item }) => item),
    state.assignments
      .filter((a) => a.status === "active" && a.runtime_state === "unknown")
      .map((a) => [
        a.id,
        runtimeUnknownDeferred(state.events, a, now, runtimeGrace),
      ]),
  ]);
}
