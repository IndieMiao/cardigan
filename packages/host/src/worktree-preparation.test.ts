import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  runtimeTargetBinding,
  worktreePreparationFingerprint,
} from "./runtime-target-fingerprint.js";
import type { RuntimeWorker } from "./runtime-workers-config.js";
import {
  observedWorktreePreparation,
  readWorktreePreparation,
  recordWorktreePreparation,
} from "./worktree-preparation.js";

let store: Store, dataDir: string, env: NodeJS.ProcessEnv;
const now = "2026-01-01T00:00:00.000Z";
const day = 86_400_000;
const at = (ms: number) => new Date(Date.parse(now) + ms).toISOString();

function worker(
  patch: Partial<RuntimeWorker["execution"]> = {},
  generation = "one",
): RuntimeWorker {
  return {
    project_id: "fixture",
    machine_id: "worker-a",
    os: "darwin",
    arch: "arm64",
    session: "fixture",
    generation,
    allow_remote_launch: true,
    execution: {
      mode: "agent-ssh",
      dataDir,
      agentRoot: "/independent-worker",
      gid: 1001,
      machine: "fixture-worker",
      identityFile: "/host-only/key",
      knownHostsFile: "/host-only/known",
      path: "/usr/bin:/bin",
      publication: {
        header_max_bytes: 8192,
        file_max_bytes: 1048576,
        batch_max_bytes: 2097152,
        timeout_ms: 2000,
      },
      fileHelper: {
        python: "/usr/bin/python3",
        path: "/opt/w/worker-files.py",
      },
      gitHelper: { python: "/usr/bin/python3", path: "/opt/w/worker-git.py" },
      ...patch,
    },
  };
}
// The launch resolves exactly this execution from the private configuration.
const resolved = (w: RuntimeWorker) => ({
  ...w.execution,
  target: runtimeTargetBinding(w),
});
function launchStarted(
  execution: ReturnType<typeof resolved>,
  when = now,
  ref = "A-1/R-1",
) {
  return store.uow.run((tx) =>
    recordWorktreePreparation(store, tx, "fixture", execution, ref, when),
  );
}
const evidence = () =>
  observedWorktreePreparation(store)("fixture", "worker-a");
const read = (w: RuntimeWorker, when = now) =>
  readWorktreePreparation(env, when, observedWorktreePreparation(store))(w);

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "worktree-preparation-"));
  // No private attestation file: only the host's own observation can admit.
  env = { CARDIGAN_CONFIG_DIR: join(dataDir, "absent-config") };
  store = Store.open({ dataDir });
  store.createProject({ id: "fixture", name: "Synthetic preparation" });
  store.uow.run((tx) =>
    tx.machines.put("fixture", {
      id: "worker-a",
      label: "Synthetic",
      herdr_machine: "fixture-worker",
      os: "darwin",
      arch: "arm64",
      tags: [],
      max_assignments: 4,
      status: "online",
      last_seen: now,
    }),
  );
});
afterEach(async () => {
  store.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("a started host preparation records the attestation fields and renews them", () => {
  const w = worker();
  expect(read(w)).not.toBe("verified");
  expect(launchStarted(resolved(w))).toBe(true);
  expect(evidence()).toEqual({
    project_id: "fixture",
    machine_id: "worker-a",
    target_fingerprint: runtimeTargetBinding(w).fingerprint,
    preparation_fingerprint: worktreePreparationFingerprint(w),
    os: "darwin",
    arch: "arm64",
    verified_at: now,
    expires_at: at(30 * day),
    evidence_ref: "A-1/R-1",
  });
  expect(read(w)).toBe("verified");
  expect(read(w, at(30 * day - 1))).toBe("verified");
  expect(read(w, at(30 * day))).toBe("expired");
  // Evidence never predates its own observation.
  expect(read(w, at(-1))).not.toBe("verified");
  // Each later real preparation renews the one row in place.
  launchStarted(
    resolved(worker({ preparationEvidenceTtlMs: day })),
    at(40 * day),
    "A-2/R-9",
  );
  expect(evidence()).toMatchObject({
    verified_at: at(40 * day),
    expires_at: at(41 * day),
    evidence_ref: "A-2/R-9",
  });
  expect(read(w, at(40 * day))).toBe("verified");
  // Scoped to exactly this project and worker.
  const other = { ...w, machine_id: "worker-b" };
  expect(read(other, at(40 * day))).not.toBe("verified");
  expect(read({ ...w, project_id: "other" }, at(40 * day))).not.toBe(
    "verified",
  );
});

test("a PATH or env edit is reported, then the next real preparation re-binds and renews (sensen Android PATH)", () => {
  const before = worker();
  launchStarted(resolved(before));
  const android = worker({
    path: "/usr/bin:/bin:/opt/android-sdk/platform-tools",
    env: { ANDROID_HOME: "/opt/android-sdk" },
  });
  // The launch identity changes, which is what made the manual record invalid.
  expect(runtimeTargetBinding(android).fingerprint).not.toBe(
    runtimeTargetBinding(before).fingerprint,
  );
  // Not silently invalid, and the unverified new configuration is not admitted.
  expect(read(android)).toBe("stale");
  expect(read(android, at(30 * day))).toBe("expired");
  // The next real preparation re-binds to the current fingerprint and renews.
  launchStarted(resolved(android), at(29 * day));
  expect(evidence()).toMatchObject({
    target_fingerprint: runtimeTargetBinding(android).fingerprint,
    expires_at: at(59 * day),
  });
  expect(read(android, at(58 * day))).toBe("verified");
});

test.each([
  ["generation", worker({}, "two")],
  ["session", { ...worker(), session: "other" }],
  [
    "git helper",
    worker({ gitHelper: { python: "/usr/bin/python3", path: "/opt/x.py" } }),
  ],
  ["agent root", worker({ agentRoot: "/elsewhere" })],
  ["account", worker({ user: "other" })],
  ["os", { ...worker(), os: "linux" as const }],
  ["arch", { ...worker(), arch: "x64" }],
  ["missing helper", worker({ fileHelper: undefined })],
])("a %s change still revokes observed evidence", (_, changed) => {
  launchStarted(resolved(worker()));
  expect(read(worker())).toBe("verified");
  expect(read(changed)).toBe("invalid");
});

test("evidence cannot be produced without a binding derived from the private configuration", () => {
  const w = worker();
  const good = resolved(w);
  for (const forged of [
    // A self-reported or stale fingerprint.
    { ...good, target: { ...good.target, fingerprint: "f".repeat(64) } },
    // A binding for another project or the local machine.
    {
      ...good,
      target: runtimeTargetBinding({ ...w, project_id: "other" }),
    },
    { ...good, target: runtimeTargetBinding({ ...w, machine_id: "local" }) },
    // A worker missing from the machine registry.
    { ...good, target: runtimeTargetBinding({ ...w, machine_id: "worker-b" }) },
    // No host Git helper means the host never prepared the worktree.
    { ...good, gitHelper: undefined },
  ]) {
    expect(launchStarted(forged)).toBe(false);
    expect(evidence()).toBeUndefined();
  }
  expect(launchStarted(good, "2026-01-01")).toBe(false);
  expect(evidence()).toBeUndefined();
  expect(read(w)).not.toBe("verified");
});

test("a row not written by a matching host observation never admits", () => {
  const w = worker();
  const insert = (patch: Record<string, string>) => {
    const row = {
      target_fingerprint: "e".repeat(64),
      preparation_fingerprint: "e".repeat(64),
      os: "darwin",
      arch: "arm64",
      verified_at: now,
      expires_at: at(day),
      evidence_ref: "forged",
      ...patch,
    };
    store.database
      .prepare(
        "INSERT OR REPLACE INTO worktree_preparation_evidence VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(
        "fixture",
        "worker-a",
        row.target_fingerprint,
        row.preparation_fingerprint,
        row.os,
        row.arch,
        row.verified_at,
        row.expires_at,
        row.evidence_ref,
      );
  };
  insert({});
  expect(read(w)).toBe("invalid");
  const target_fingerprint = runtimeTargetBinding(w).fingerprint;
  for (const patch of [
    { verified_at: "2026-01-01" },
    { expires_at: now },
    { evidence_ref: " " },
  ]) {
    insert({ target_fingerprint, ...patch });
    expect(read(w)).toBe("invalid");
  }
  insert({ target_fingerprint });
  expect(read(w)).toBe("verified");
});
