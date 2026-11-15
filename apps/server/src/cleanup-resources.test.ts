import type { Assignment, Runtime, RuntimeRef } from "@cardigan/domain";
import { releaseAssignment } from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CleanupExecutor } from "./cleanup-loop.js";
import { ServerGit } from "./git.js";
import { type M4Fixture, m4Fixture, m4Scenario } from "./m4-fixtures.js";

let f: M4Fixture;
let owner: Assignment;
const absent = {
  ok: false as const,
  error: { code: "runtime_not_found" as const, message: "gone" },
};
const unavailable = {
  ok: false as const,
  error: { code: "runtime_unavailable" as const, message: "retry" },
};
const alive = {
  ok: true as const,
  value: { process: "alive" as const, agent: "idle" as const, observed_seq: 1 },
};
const issue = (a = owner, store = f.store) =>
  store.issueToken({
    project_id: f.project_id,
    assignment_id: a.id,
    role: { role_version: 1, allowed_tools: [] },
  });
const saved = () => {
  const a = f.state().assignments.find((a) => a.id === owner.id);
  if (!a) throw new Error("missing fixture Assignment");
  return a;
};
const ownerRef = () => {
  if (!owner.runtime_ref) throw new Error("missing fixture terminal");
  return owner.runtime_ref;
};
const executor = (
  status: Runtime["status"],
  release: Runtime["release"] = async () => absent,
) =>
  new CleanupExecutor({
    store: f.store,
    git: new ServerGit({ store: f.store, dataDir: f.dataDir }),
    runtime: { status, release } as Runtime,
  });

beforeEach(() => {
  f = m4Fixture();
  owner = m4Scenario(f).coder;
  f.startRun(owner);
  f.endRun(owner);
  owner = f.apply((s, a, p) =>
    releaseAssignment(s, a, { assignment_id: owner.id }, p),
  );
});
afterEach(() => f.close());

test("missing terminals retain cleanup ownership across sweeps and restart", async () => {
  const token = issue();
  const status = vi.fn(async () => absent);
  const loop = executor(status);
  await loop.tick();
  await loop.tick();
  await executor(status).tick();
  expect(saved().runtime_ref).toEqual(owner.runtime_ref);
  expect(status).toHaveBeenCalledTimes(2);
  expect(f.store.verifyToken(token.token)).toBeUndefined();
  expect(f.state().human_actions).toHaveLength(1);
});

test.each(["result", "throw"])(
  "failed release preserves original identity (%s)",
  async (mode) => {
    const release = vi.fn<Runtime["release"]>(async () => {
      if (mode === "throw") throw new Error("connection lost");
      return unavailable;
    });
    const loop = executor(async () => unavailable, release);
    await loop.tick();
    await loop.tick();
    expect(release).toHaveBeenCalledTimes(2);
    expect(saved().runtime_ref).toEqual(owner.runtime_ref);
  },
);

test("release success never proves descendant exit or clears the original target", async () => {
  const release = vi.fn(async () => ({ ok: true as const, value: undefined }));
  const loop = executor(async () => alive, release);
  await loop.tick();
  await loop.tick();
  expect(saved().runtime_ref).toEqual(owner.runtime_ref);
  expect(release).toHaveBeenCalledOnce();
  expect(f.state().human_actions).toHaveLength(1);
});

test("another connection's late tokens are revoked while unknown ownership remains", async () => {
  const loop = executor(async () => absent);
  await loop.tick();
  const other = Store.open({ dataDir: f.dataDir });
  try {
    const late = issue(owner, other);
    await loop.tick();
    expect(f.store.verifyToken(late.token)).toBeUndefined();
    expect(saved().runtime_ref).toEqual(owner.runtime_ref);
  } finally {
    other.close();
  }
});

test("late observations never clear a replacement target", async () => {
  const newer: RuntimeRef = { ...ownerRef(), terminal_ref: "t-newer" };
  const status = vi.fn(async () => {
    f.store.uow.run((tx) =>
      tx.assignments.put(f.project_id, { ...owner, runtime_ref: newer }),
    );
    return absent;
  });
  const loop = executor(status);
  await loop.tick();
  expect(saved().runtime_ref).toEqual(newer);
  await loop.tick();
  expect(status).toHaveBeenLastCalledWith(newer);
});
