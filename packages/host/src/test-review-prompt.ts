import { type CommandState, testReviewForAssignment } from "@cardigan/domain";
import { testReviewPrompt } from "@cardigan/roles";

/** Every start/wake entry uses the same fresh scope, including retry sends. */
export function testReviewRunPrompt(
  state: CommandState,
  assignmentId: string,
  runId: string,
): string | undefined {
  const owner = state.assignments.find((a) => a.id === assignmentId);
  if (owner?.scope !== "work_item" || owner.role_id !== "independent_reviewer")
    return;
  const run = state.runs.find(
    (r) => r.id === runId && r.assignment_id === owner.id,
  );
  const proof = testReviewForAssignment(state, owner.id);
  if (
    run?.test_review &&
    JSON.stringify(run.test_review) !== JSON.stringify(proof)
  )
    throw new Error(
      "Incremental review scope expired; start a full review Run",
    );
  return testReviewPrompt(proof);
}
