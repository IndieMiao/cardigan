import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Machine } from "@cardigan/domain";

export const workerPublicationProtocol = 2;
export const helpers = [
  "worker-files.py",
  "worker-git.py",
  "worker-primitives.py",
] as const;
// A release is immutable for the lifetime of the controller process.
let digests: Readonly<Record<string, string>> | undefined;
export function workerHelperDigests() {
  digests ??= Object.freeze(
    Object.fromEntries(
      helpers.map((name) => [
        name,
        createHash("sha256")
          .update(
            readFileSync(new URL(`../../../deploy/${name}`, import.meta.url)),
          )
          .digest("hex"),
      ]),
    ),
  );
  return digests;
}
export const digestMismatch = "worker helper 与当前部署的 SHA-256 不一致";
export const protocolMismatch = (installed: number) =>
  `worker helper 落后（已装 ${installed}，需要 ${workerPublicationProtocol}）` as const;
export function helperMismatch(reason: string) {
  return (
    reason === digestMismatch ||
    /^worker helper 落后（已装 [0-9]+，需要 [0-9]+）$/u.test(reason)
  );
}
/**
 * AGENTS.md: an incompatible helper change must raise the publication
 * protocol. A same-protocol helper with a different digest is therefore
 * compatible: it is upgraded, but never stops dispatch (C-608).
 */
export const softHelperMismatch = (reason: string) => reason === digestMismatch;
export interface SplitCheck {
  readonly blockers: readonly string[];
  readonly warnings?: readonly string[];
  readonly launch_enabled: boolean;
}
/** Move non-blocking findings out of blockers. */
export function splitHelperWarnings<T extends SplitCheck>(
  check: T,
): T & { warnings: readonly string[] } {
  const soft = check.blockers.filter(softHelperMismatch);
  return {
    ...check,
    blockers: check.blockers.filter((b) => !softHelperMismatch(b)),
    warnings: [...new Set([...(check.warnings ?? []), ...soft])],
  };
}
export const hasHelperMismatch = (check: SplitCheck) =>
  [...check.blockers, ...(check.warnings ?? [])].some(helperMismatch);

/** Capability evidence identifies the probed platform as well as the private runtime binding.
 * Keep this separate from the persisted runtime_ref fingerprint used to address live terminals. */
export function observationFingerprint(
  binding: string | undefined,
  platform: Pick<Machine, "os" | "arch">,
) {
  if (!binding) return undefined;
  return createHash("sha256")
    .update(
      JSON.stringify([
        binding,
        platform.os,
        platform.arch,
        workerPublicationProtocol,
        workerHelperDigests(),
      ]),
    )
    .digest("hex");
}
