#!/usr/bin/env node
// Fixed read-only worker entry. Input is selected by the trusted controller,
// outside the project. This report alone never grants remote-start authority.
import { sampleWorkerCapabilities, sampleWorkerPaths, workerPreflight, redactWorkerManifest, workerCombination } from "../packages/runtime-herdr/dist/index.js";

try {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 65536) throw new Error();
  }
  const request = JSON.parse(input);
  const manifest = sampleWorkerCapabilities({ ...request.environment, ...request.native });
  // These observations are collected in actual-account B1 by the operator;
  // they cannot be inferred from executable presence or a tool --version.
  for (const id of ["noninteractive", "native-dependencies", "rosetta"]) {
    const state = value => typeof value === "boolean" ? value : null;
    manifest.capabilities[id] = { installed: state(request.manual?.[id]?.installed), configured: state(request.manual?.[id]?.configured),
      version: null, arch: null, path: null, resolved_path: null, last_verified: null };
  }
  for (const [id, capability] of Object.entries(manifest.capabilities))
    capability.last_verified = request.verifications?.[id] ?? null;
  let observations = [];
  try { observations = sampleWorkerPaths(request.native, { paths: request.config.paths, ...request.workspace }); } catch { /* unknown blocks all paths */ }
  const result = workerPreflight(request.config, manifest, observations);
  process.stdout.write(JSON.stringify({ ...result, combination: workerCombination(manifest, request.config.requirements.combination), manifest: redactWorkerManifest(manifest) }) + "\n");
  process.exitCode = result.ready ? 0 : 1;
} catch {
  process.stdout.write(JSON.stringify({ ready: false, blockers: ["worker_observation_unavailable"] }) + "\n");
  process.exitCode = 1;
}
