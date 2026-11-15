import {
  type Runtime,
  type RuntimeRef,
  runtimeExitMatches,
} from "@cardigan/domain";

export class RuntimeExitUnconfirmed extends Error {
  readonly code = "runtime_exit_unconfirmed";
}

/** The preparation retry wrapper preserves the original error as its cause. */
export function isRuntimeExitUnconfirmed(error: unknown): boolean {
  const e = error as { code?: unknown; cause?: unknown } | null;
  return (
    !!e &&
    (e.code === "runtime_exit_unconfirmed" ||
      (e.cause !== undefined &&
        e.cause !== error &&
        isRuntimeExitUnconfirmed(e.cause)))
  );
}

/** Never infer descendant exit from terminal status or a successful kill/rm. */
export async function confirmRuntimeExit(
  runtime: Runtime,
  ref: RuntimeRef | null,
): Promise<boolean> {
  if (!ref || !runtime.verifyExit) return false;
  try {
    const proof = await runtime.verifyExit(ref);
    return proof.ok && runtimeExitMatches(proof.value, ref);
  } catch {
    return false;
  }
}
