import {
  type WorkerManifest,
  type WorkerRequirements,
  workerCombination,
} from "../packages/runtime-herdr/src/worker-capabilities.js";

export function fixture() {
  const requirements: WorkerRequirements = {
    uid: 501,
    os: "darwin",
    arch: "arm64",
    combination: "a".repeat(64),
    harness: "harness",
    tools: { harness: { version: "1.2.3", arch: "arm64" } },
    desktop: false,
  };
  const manifest: WorkerManifest = {
    os: "darwin",
    product_version: "26.1",
    build: "25B1",
    kernel: "25.1.0",
    arch: "arm64",
    uid: 501,
    sampled_at: "2026-11-14T00:00:00Z",
    source: "fixture",
    capabilities: {},
  };
  for (const [id, version] of Object.entries({
    node: "24.1.0",
    pnpm: "11.7.0",
    git: "2.50.0",
    python: "3.13.0",
    hc: "0.1.18",
    harness: "1.2.3",
    "hc-signature": "verified",
    noninteractive: "verified",
    "native-dependencies": "verified",
  })) {
    manifest.capabilities[id] = {
      installed: true,
      configured: true,
      version,
      arch: "arm64",
      path: `/private/account/bin/${id}`,
      resolved_path: `/private/account/tools/${id}`,
      last_verified: {
        at: manifest.sampled_at,
        uid: 501,
        combination: requirements.combination,
        evidence: "fixture-evidence",
      },
    };
  }
  const combination = workerCombination(manifest, requirements.combination);
  for (const capability of Object.values(manifest.capabilities))
    if (capability.last_verified)
      capability.last_verified.combination = combination;
  return { manifest, requirements };
}
