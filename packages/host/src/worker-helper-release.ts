import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Machine } from "@cardigan/domain";

/** The protocol the deployed release announces (`PUBLICATION_PROTOCOL`). */
export const workerPublicationProtocol = 3;
/**
 * C-666: launch admission still starts at protocol 2. A protocol-2 worker is
 * only admitted when it runs exactly `previousWorkerHelperRelease`; any other
 * helper bytes remain a digest mismatch.
 */
export const minimumWorkerPublicationProtocol = 2;
/** C-666: the first protocol whose worker-git.py answers the `usage` report. */
export const workerUsageProtocol = 3;
/**
 * C-666: SHA-256 of the release before the usage report (protocol 2). Only
 * the usage report is missing from it; Git, publication and launch are the
 * same, so a worker still running it is not held from dispatch.
 * `test-support/worker-git-v2.py` is that release's worker-git.py.
 */
export const previousWorkerHelperRelease = Object.freeze({
  protocol: 2,
  digests: Object.freeze({
    "worker-files.py":
      "a63ab830368b1fae01a581da85f61ac995eabc35da72b164cd411f406d9e209e",
    "worker-git.py":
      "929f712639aa4a4cfc79fc5770b547c9c00749f4af1286417234e2dd399f2bbb",
    "worker-primitives.py":
      "3d4a0d80df21020d2bf7f172d991d2fcdaea829ca472c03b243de595300fe67d",
  }),
});
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
