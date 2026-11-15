import {
  type Runtime,
  type RuntimeRef,
  runtimeExitMatches,
} from "@cardigan/domain";

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
