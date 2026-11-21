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
