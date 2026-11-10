import type {
  AssignmentId,
  ProjectId,
  Runtime,
  RuntimeRef,
} from "@cardigan/domain";
import type { StoreTransactionContext } from "@cardigan/store";

const exited = (result: Awaited<ReturnType<Runtime["status"]>> | undefined) =>
  result?.ok
    ? result.value.process === "exited"
    : result?.error.code === "runtime_not_found";

/** Shared automatic-stop primitive: recheck eligibility, stop, independently prove exit. */
export async function stopRunRuntime(
  runtime: Runtime,
  ref: RuntimeRef | null,
  mayStop: () => boolean,
) {
  const observe = () =>
    ref ? runtime.status(ref).catch(() => undefined) : undefined;
  const before = await observe();
  if (!mayStop()) return "withdrawn" as const;
  if (!ref || exited(before)) return "exited" as const;
  await runtime.release(ref, { force: true }).catch(() => undefined);
  return exited(await observe())
    ? ("exited" as const)
    : ("unconfirmed" as const);
}

/** Call in the same transaction as cancellation, only after proving terminal exit. */
export function revokeStoppedRunTokens(
  tx: StoreTransactionContext,
  project: ProjectId,
  assignment: AssignmentId,
) {
  for (const token of tx.tokensForAssignment(project, assignment))
    if (token.revoked_at === null && !tx.revokeToken(token.id))
      throw new Error("Stopped Run token revocation failed");
}
