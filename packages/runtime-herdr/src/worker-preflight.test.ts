import { expect, test } from "vitest";
import { fixture } from "../../../test-support/worker-capabilities.js";
import {
  type WorkerPathObservation,
  type WorkerPreflight,
  workerPreflight,
} from "./worker-preflight.js";

test("unknown mount, ownership, space, paths and credentials fail closed without path disclosure", () => {
  const { manifest, requirements } = fixture();
  const actual: WorkerPathObservation = {
    kind: "generated",
    path: "/fixture/work",
    realpath: "/fixture/work",
    mount: "/fixture",
    volume: "fixture-volume",
    uid: 501,
    common_dir: "/fixture/repo/.git",
    assignment: "A-1",
    sha: "a".repeat(40),
    dirty: true,
    mounted: true,
    acl_safe: true,
    free_bytes: 100,
    root_free_bytes: 100,
    project_private: true,
    lock_verified: true,
  };
  const {
    mounted: _m,
    acl_safe: _a,
    free_bytes: _f,
    root_free_bytes: _r,
    project_private: _p,
    lock_verified: _l,
    ...expected
  } = actual;
  const config: WorkerPreflight = {
    requirements,
    paths: [expected],
    minimum_free_bytes: { root: 10, work: 20 },
    credentials: [
      {
        category: "harness",
        owner_role: "coder",
        credential_ref: "harness-login",
        scope: "model-use",
        available: true,
      },
    ],
  };
  expect(workerPreflight(config, manifest, [actual])).toEqual({
    ready: true,
    blockers: [],
  });
  for (const mutation of [
    { mounted: false },
    { volume: "changed" },
    { uid: 0 },
    { acl_safe: false },
    { free_bytes: 19 },
    { root_free_bytes: 9 },
    { realpath: "/another" },
    { project_private: false },
    { lock_verified: false },
  ]) {
    expect(
      workerPreflight(config, manifest, [{ ...actual, ...mutation }]),
    ).toEqual({ ready: false, blockers: ["path:0"] });
  }
  const credential = config.credentials[0];
  if (credential) credential.available = null;
  expect(workerPreflight(config, manifest, [actual]).blockers).toEqual([
    "credential:0",
  ]);
  config.minimum_free_bytes.work = Number.NaN;
  expect(workerPreflight(config, manifest, []).blockers).toContain(
    "space_thresholds",
  );
});
