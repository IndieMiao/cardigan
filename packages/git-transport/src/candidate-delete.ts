import {
  type CandidatePushRequest,
  candidatePushCommand,
} from "./candidate-push.js";

export type CandidateDeleteRequest = CandidatePushRequest;
/** Compare-and-delete the exact host-owned candidate; a reused ref must survive. */
export function candidateDeleteCommand(
  repository: string,
  input: CandidateDeleteRequest,
) {
  const command = candidatePushCommand(repository, input);
  const args = [...command.args];
  args.splice(
    args.indexOf("--porcelain") + 1,
    0,
    `--force-with-lease=${input.ref}:${input.sha}`,
  );
  args[args.length - 1] = `:${input.ref}`;
  return { ...command, args };
}
