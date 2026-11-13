import type {
  Assignment,
  AssignmentId,
  Runtime,
  RuntimeRef,
} from "@cardigan/domain";
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

test("hundreds of cleaned owners skip runtime and token revocation, including after restart", async () => {
  f.store.uow.run((tx) => {
    for (let i = 0; i < 600; i++) {
      const id = `A-${1000 + i}` as AssignmentId;
      tx.assignments.put(f.project_id, {
        ...owner,
        id,
        runtime_ref: { ...ownerRef(), terminal_ref: `t-${id}` },
      });
    }
  });
  const token = issue();
  const status = vi.fn(async () => absent);
  const release = vi.fn(async () => absent);
  const revoke = vi.spyOn(f.store, "revokeToken");
  const loop = executor(status, release);
  await loop.tick();
  expect(status).toHaveBeenCalledTimes(601);
  expect(f.store.verifyToken(token.token)).toBeUndefined();
  status.mockClear();
  revoke.mockClear();
  await loop.tick();
  await executor(status, release).tick();
  expect(status).not.toHaveBeenCalled();
  expect(release).not.toHaveBeenCalled();
  expect(revoke).not.toHaveBeenCalled();
});

test.each(["result", "throw"])(
  "failed cleanup retries next sweep (%s)",
  async (mode) => {
    const token = issue();
    const status = vi.fn(async () => unavailable);
    const release = vi
      .fn<Runtime["release"]>()
      .mockImplementationOnce(async () => {
        if (mode === "throw") throw new Error("connection lost");
        return unavailable;
      })
      .mockResolvedValue(absent);
    const loop = executor(status, release);
    await loop.tick();
    expect(saved().runtime_ref).toEqual(owner.runtime_ref);
    expect(f.store.verifyToken(token.token)).toBeUndefined();
    await loop.tick();
    expect(release).toHaveBeenCalledTimes(2);
    expect(saved().runtime_ref).toBeNull();
    await loop.tick();
    expect(status).toHaveBeenCalledTimes(2);
  },
);

test("a successful release without proof of absence is still checked next sweep", async () => {
  const status = vi
    .fn<Runtime["status"]>()
    .mockResolvedValueOnce(alive)
    .mockResolvedValue(absent);
  const release = vi.fn(async () => ({ ok: true as const, value: undefined }));
  const loop = executor(status, release);
  await loop.tick();
  expect(saved().runtime_ref).toEqual(owner.runtime_ref);
  await loop.tick();
  expect(saved().runtime_ref).toBeNull();
  await loop.tick();
  expect(status).toHaveBeenCalledTimes(2);
  expect(release).toHaveBeenCalledOnce();
});

test("late tokens are revoked after terminal cleanup; active and newly released owners stay distinct", async () => {
  const status = vi.fn(async () => absent);
  const loop = executor(status);
  await loop.tick();
  const other = Store.open({ dataDir: f.dataDir });
  try {
    const late = issue(owner, other);
    const next = m4Scenario(f).coder;
    f.startRun(next);
    f.endRun(next);
    const active = issue(next);
    await loop.tick();
    expect(f.store.verifyToken(late.token)).toBeUndefined();
    expect(f.store.verifyToken(active.token)).toBeDefined();
    expect(status).toHaveBeenCalledOnce();
    f.apply((s, a, p) =>
      releaseAssignment(s, a, { assignment_id: next.id }, p),
    );
    await loop.tick();
    expect(status).toHaveBeenCalledTimes(2);
    expect(f.store.verifyToken(active.token)).toBeUndefined();
  } finally {
    other.close();
  }
});

test("rollback cannot remember terminal cleanup; a fresh executor retries", async () => {
  const status = vi.fn(async () => absent);
  f.store.database.exec(`CREATE TRIGGER reject_cleanup BEFORE INSERT ON events
    WHEN json_extract(NEW.doc, '$.type') = 'assignment_terminal_cleaned'
    BEGIN SELECT RAISE(ABORT, 'rollback cleanup'); END`);
  await expect(executor(status).tick()).rejects.toThrow("rollback cleanup");
  expect(saved().runtime_ref).toEqual(owner.runtime_ref);
  f.store.database.exec("DROP TRIGGER reject_cleanup");
  await executor(status).tick();
  expect(status).toHaveBeenCalledTimes(2);
  expect(saved().runtime_ref).toBeNull();
});

test("an observation cannot clear a replacement reference written during runtime IO", async () => {
  const newer: RuntimeRef = { ...ownerRef(), terminal_ref: "t-newer" };
  const status = vi
    .fn<Runtime["status"]>()
    .mockImplementationOnce(async () => {
      f.store.uow.run((tx) =>
        tx.assignments.put(f.project_id, { ...owner, runtime_ref: newer }),
      );
      return absent;
    })
    .mockResolvedValue(absent);
  const loop = executor(status);
  await loop.tick();
  expect(saved().runtime_ref).toEqual(newer);
  await loop.tick();
  expect(status).toHaveBeenLastCalledWith(newer);
  expect(saved().runtime_ref).toBeNull();
});
