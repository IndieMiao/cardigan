/**
 * P2a-12 C: an unreachable merge-check executor is an incomplete scan. Its
 * open findings stay open with their first-seen time until a successful
 * listing confirms they are gone.
 */
import type { ReconcileFinding } from "@cardigan/git-service";
import { afterEach, expect, test } from "vitest";
import type { ReconcileGit } from "./git.js";
import { type M4Fixture, m4Fixture } from "./m4-fixtures.js";
import { ReconcileExecutor } from "./reconcile-loop.js";

const fixtures: M4Fixture[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});

const remote = "cardigan-ci:/srv/cardigan-agent/checks/p-m4";
const orphan: ReconcileFinding = {
  kind: "orphan_worktree",
  detail: "Executor cardigan-ci: Worktree exists but no Assignment owns it",
  path: `${remote}/old/worktree`,
};
const localOrphan: ReconcileFinding = {
  kind: "orphan_worktree",
  detail: "Worktree exists but no Assignment owns it",
  path: "/var/lib/cardigan-agent/checks/p-m4/x/worktree",
};
const unreachable: ReconcileFinding = {
  kind: "executor_unreachable",
  detail: "Merge check executor cardigan-ci is unreachable",
  path: remote,
};

test("an SSH outage keeps open remote findings and their first-seen time; recovery resolves only what a listing confirms", async () => {
  let now = "2030-01-01T10:00:00.000Z";
  const f = m4Fixture({ clock: { now: () => now } });
  fixtures.push(f);
  let pass: readonly ReconcileFinding[] = [orphan, localOrphan];
  const git = {
    projectOf: (id: string) => ({
      project_id: id,
      source_repo: "/unused",
      base_branch: "main",
    }),
    reconcile: async () => pass,
  } as unknown as ReconcileGit;
  const executor = new ReconcileExecutor({
    store: f.store,
    git,
    clock: { now: () => now },
  });
  const open = () =>
    Object.fromEntries(
      f.store
        .listReconcileFindings(f.project_id, { openOnly: true })
        .map((x) => [`${x.kind}:${x.path}`, x.first_seen_at]),
    );
  const events = () =>
    f.store.uow.read((tx) =>
      tx.events
        .listAfter(f.project_id, undefined, 0)
        .filter((e) => e.type === "reconcile_finding")
        .map((e) => (e.payload as { kind: string; path?: string }).path),
    );

  await executor.tick(f.project_id);
  expect(open()).toEqual({
    [`orphan_worktree:${orphan.path}`]: "2030-01-01T10:00:00.000Z",
    [`orphan_worktree:${localOrphan.path}`]: "2030-01-01T10:00:00.000Z",
  });

  // Outage: the remote scan is unknown, the local scan still resolves.
  now = "2030-01-01T10:10:00.000Z";
  pass = [unreachable];
  await executor.tick(f.project_id);
  expect(open()).toEqual({
    [`orphan_worktree:${orphan.path}`]: "2030-01-01T10:00:00.000Z",
    [`executor_unreachable:${remote}`]: "2030-01-01T10:10:00.000Z",
  });

  // Recovery with the same directory: not re-opened, first seen unchanged.
  now = "2030-01-01T10:20:00.000Z";
  pass = [orphan];
  await executor.tick(f.project_id);
  expect(open()).toEqual({
    [`orphan_worktree:${orphan.path}`]: "2030-01-01T10:00:00.000Z",
  });
  expect(events()).toEqual([orphan.path, localOrphan.path, remote]);

  // A successful listing without the directory resolves it.
  now = "2030-01-01T10:30:00.000Z";
  pass = [];
  await executor.tick(f.project_id);
  expect(open()).toEqual({});
});

test("a partial worker inventory neither clears findings nor restarts earlier probes", async () => {
  const f = m4Fixture();
  fixtures.push(f);
  f.store.recordReconcileFindings(f.project_id, [orphan]);
  const observed: number[] = [];
  const executor = new ReconcileExecutor({
    store: f.store,
    git: {
      projectOf: () => ({
        project_id: f.project_id,
        source_repo: "/unused",
        base_branch: "main",
      }),
      async *reconcilePages() {
        observed.push(1);
        yield;
        observed.push(2);
        yield;
        return [];
      },
    } as unknown as ReconcileGit,
  });
  for (const n of [1, 2]) {
    await executor.tick(f.project_id, true);
    expect(observed.length).toBe(n);
    expect(executor.pending(f.project_id)).toBe(true);
    expect(
      f.store.listReconcileFindings(f.project_id, { openOnly: true }),
    ).toHaveLength(1);
  }
  await executor.tick(f.project_id, true);
  expect(executor.pending(f.project_id)).toBe(false);
  expect(
    f.store.listReconcileFindings(f.project_id, { openOnly: true }),
  ).toEqual([]);
});
