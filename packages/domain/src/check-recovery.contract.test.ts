import { expect, test } from "vitest";
import {
  type CheckRecoveryOutcome,
  canRecheckRecovery,
  sameCheckRecoveryOutcome,
} from "./check-recovery.js";
import { actor, human } from "./commands/test-fixtures.js";

const outcome: CheckRecoveryOutcome = {
  status: "manual_attention",
  reason: "unverified",
  processes: [],
};
test("only a same-project human/system can explicitly reactivate recovery", () => {
  expect(canRecheckRecovery(human, human.project_id)).toBe(true);
  expect(
    canRecheckRecovery(
      { kind: "system", project_id: human.project_id },
      human.project_id,
    ),
  ).toBe(true);
  expect(canRecheckRecovery(actor(), human.project_id)).toBe(false);
  expect(canRecheckRecovery(human, "other-project")).toBe(false);
});
test("invariant: repeated observations are not transitions, while changed diagnostics are", () => {
  expect(sameCheckRecoveryOutcome(undefined, outcome)).toBe(false);
  expect(
    sameCheckRecoveryOutcome(outcome, { ...outcome, evidence: "a".repeat(64) }),
  ).toBe(true);
  expect(
    sameCheckRecoveryOutcome(outcome, { ...outcome, stage: "target_identity" }),
  ).toBe(false);
  expect(
    sameCheckRecoveryOutcome(outcome, {
      status: "cleaned",
      reason: "complete",
      processes: [],
    }),
  ).toBe(false);
  const processes = [
    { pid: 12, state: "D", wchan: "exit_mm" },
    { pid: 13, state: "unknown", wchan: "unknown" },
  ];
  expect(
    sameCheckRecoveryOutcome(
      { ...outcome, processes },
      { ...outcome, processes: processes.toReversed() },
    ),
  ).toBe(true);
});
