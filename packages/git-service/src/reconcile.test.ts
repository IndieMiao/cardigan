/**
 * M4.3 reconciliation: what "missing" means (plan phase-1-m4 §3.6, v5).
 *
 * §3.6 decides a worktree is missing when the *directory* is gone, whatever Git
 * still has registered. The leftover registration is its own finding, so PM Ops
 * sees both "this Assignment lost its workspace" (with the id) and "the base
 * clone needs pruning". G11 (M4.T2) found the earlier rule only reported the
 * second one, without an assignment.
 */
import type { Assignment, Delivery, GitWorktree } from "@cardigan/domain";
import { expect, test } from "vitest";
import { reconcile, type WorktreeState } from "./reconcile.js";

const project_id = "p-fictional";
const root = "/srv/agent/worktrees/p-fictional";
const worktree = `${root}/A-1`;

const assignment = (overrides: Partial<Assignment> = {}): Assignment =>
  ({
    id: "A-1",
    scope: "work_item",
    work_item_id: "W-1",
    role_id: "coder",
    role_version: 1,
    status: "active",
    runtime_state: "not_provisioned",
    runtime_ref: null,
    machine_id: "local",
    mcp_token_id: "reserved",
    created_at: "2030-01-01T00:00:00.000Z",
    worktree_path: worktree,
    branch: "agent/C-1/W-1",
    ...overrides,
  }) as unknown as Assignment;

const delivery = (id: string, value: string): Delivery =>
  ({
    id,
    work_item_id: "W-1",
    run_id: "R-1",
    kind: "code",
    summary: "fixture",
    subject: { kind: "git_head", value },
    evidence: [],
    attachments: [],
    known_gaps: [],
    requested_verifiers: [],
    status: "accepted",
  }) as unknown as Delivery;

function state(overrides: Partial<WorktreeState> = {}): WorktreeState {
  return {
    project_id,
    worktrees_root: root,
    registered: [],
    directories: [],
    failed_clones: [],
    pinned: [],
    ...overrides,
  };
}

const registered = (path: string): GitWorktree =>
  ({ path, branch: "agent/C-1/W-1", head: "abc" }) as GitWorktree;

test("a directory that is gone is missing even while Git still lists it", () => {
  const findings = reconcile(
    state({ registered: [registered(worktree)] }),
    [assignment()],
    [delivery("D-1", "abc")],
  );
  // Both facts are reported, and the Assignment is named on the missing one.
  expect(findings).toContainEqual(
    expect.objectContaining({
      kind: "missing_worktree",
      assignment_id: "A-1",
      path: worktree,
    }),
  );
  expect(findings).toContainEqual(
    expect.objectContaining({ kind: "stale_registration", path: worktree }),
  );
  expect(findings.filter((f) => f.kind === "missing_worktree")).toHaveLength(1);
});

test("a missing directory with no registration is still missing", () => {
  const findings = reconcile(state(), [assignment()], []);
  expect(findings).toEqual([
    expect.objectContaining({ kind: "missing_worktree", assignment_id: "A-1" }),
  ]);
});

test("a directory that exists is not missing, registered or not", () => {
  for (const registeredWorktrees of [registered(worktree), undefined]) {
    const findings = reconcile(
      state({
        directories: [worktree],
        registered:
          registeredWorktrees === undefined ? [] : [registeredWorktrees],
      }),
      [assignment()],
      [],
    );
    expect(findings).toEqual([]);
  }
});

test("a released Assignment's gone directory is not reported as missing", () => {
  const findings = reconcile(
    state({ registered: [registered(worktree)] }),
    [assignment({ status: "released" })],
    [],
  );
  // The leftover registration is still reported; the release flow owns cleanup.
  expect(findings).toEqual([
    expect.objectContaining({ kind: "stale_registration", path: worktree }),
  ]);
});

test("two Assignments that lost their directories are named separately", () => {
  const second = `${root}/A-2`;
  const findings = reconcile(
    state({ registered: [registered(worktree), registered(second)] }),
    [
      assignment(),
      assignment({
        id: "A-2",
        worktree_path: second,
        branch: "agent/C-2/W-2",
      }),
    ],
    [],
  );
  expect(
    findings
      .filter((finding) => finding.kind === "missing_worktree")
      .map((finding) => finding.assignment_id)
      .sort(),
  ).toEqual(["A-1", "A-2"]);
});

test("orphans and failed clones keep their old reporting", () => {
  const orphan = `${root}/A-9`;
  const failed = "/srv/agent/repos/.clone-broken";
  const findings = reconcile(
    state({
      directories: [worktree, orphan],
      failed_clones: [failed],
    }),
    [assignment()],
    [],
  );
  expect(findings).toEqual([
    expect.objectContaining({ kind: "orphan_worktree", path: orphan }),
    expect.objectContaining({ kind: "failed_clone", path: failed }),
  ]);
});
