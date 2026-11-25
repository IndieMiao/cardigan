import { type Assignment, CheckHeadFailure } from "@cardigan/domain";
import { expect, test, vi } from "vitest";
import type { CentralProject, CentralRepositoryService } from "./central.js";
import { GitDeliveryVerifier } from "./delivery.js";
import { RepositoryLockTimeoutError } from "./lock.js";

const head = "a".repeat(40);
const project: CentralProject = {
  project_id: "P",
  source_repo: "/synthetic/source",
  base_branch: "main",
};
const assignment = {
  id: "A-1",
  status: "active",
  machine_id: "local",
  scope: "work_item",
  branch: "agent/c632",
  worktree_path: "/synthetic/worktree",
} as Assignment;

function central(overrides: Record<string, unknown> = {}) {
  const git = {
    readRef: vi.fn(async (_repo: string, _ref: string) => undefined),
    fetchBranchTip: vi.fn(async () => head),
    isAncestor: vi.fn(async () => false),
    compareAndSwapRef: vi.fn(async () => {}),
    ...overrides,
  };
  const service = {
    git,
    ensureCentral: vi.fn(async () => "/synthetic/central.git"),
    agentSource: vi.fn(async () => ({
      address: { kind: "host-local", path: "/synthetic/agent" },
    })),
    validateSource: vi.fn(),
    createRef: vi.fn(async () => {}),
  };
  return {
    service,
    verifier: new GitDeliveryVerifier(
      service as unknown as CentralRepositoryService,
      project,
    ),
  };
}
const failure = (error: unknown) =>
  expect.objectContaining({ name: "CheckHeadFailure", ...(error as object) });

test("reads and pins the recorded branch HEAD", async () => {
  const { verifier, service } = central();
  expect(await verifier.head(assignment)).toBe(head);
  expect(service.git.compareAndSwapRef).toHaveBeenCalledWith(
    "/synthetic/central.git",
    "refs/cardigan/incoming/A-1",
    head,
    null,
  );
  expect(service.createRef).toHaveBeenCalledWith(
    "/synthetic/central.git",
    `refs/cardigan/prechecks/A-1/${head}`,
    head,
  );
});

test.each([
  [
    "a remote ref absent on the worker is a missing branch",
    {
      fetchBranchTip: vi.fn(async () => {
        throw Object.assign(new Error("Git command failed"), {
          stderr: "fatal: couldn't find remote ref refs/heads/agent/c632",
        });
      }),
    },
    "branch_missing",
  ],
  [
    "a transport failure is a fetch failure",
    {
      fetchBranchTip: vi.fn(async () => {
        throw new Error("ssh: connect to host example.invalid: refused");
      }),
    },
    "fetch_failed",
  ],
  [
    "an empty fetched ref is a missing branch",
    {
      fetchBranchTip: vi.fn(async () => {
        throw new CheckHeadFailure("branch_missing");
      }),
    },
    "branch_missing",
  ],
  [
    "a non-commit HEAD is an object mismatch",
    {
      fetchBranchTip: vi.fn(async () => {
        throw new CheckHeadFailure("object_mismatch");
      }),
    },
    "object_mismatch",
  ],
  [
    "an unreadable central ref is a repository failure",
    {
      readRef: vi.fn(async (_repo: string, ref: string) => {
        if (ref.startsWith("refs/cardigan/incoming/"))
          throw new Error("fatal: bad object");
        return undefined;
      }),
    },
    "repository_failed",
  ],
])("%s", async (_name, overrides, reason) => {
  const { verifier, service } = central(overrides);
  await expect(verifier.head(assignment)).rejects.toEqual(failure({ reason }));
  expect(service.createRef).not.toHaveBeenCalled();
});

test("ownership and setup failures are classified; lock timeouts pass through unchanged", async () => {
  await expect(
    central().verifier.head({ ...assignment, status: "released" }),
  ).rejects.toEqual(failure({ reason: "ownership_mismatch" }));
  const source = central();
  source.service.agentSource.mockRejectedValueOnce(
    new Error("Worker source is not configured"),
  );
  await expect(source.verifier.head(assignment)).rejects.toEqual(
    failure({ reason: "environment_unavailable" }),
  );
  const changed = central();
  changed.service.validateSource.mockImplementationOnce(() => {
    throw new Error("Workspace target configuration changed");
  });
  await expect(changed.verifier.head(assignment)).rejects.toEqual(
    failure({ reason: "environment_unavailable" }),
  );
  const busy = central();
  const timeout = new RepositoryLockTimeoutError(1);
  busy.service.ensureCentral.mockRejectedValueOnce(timeout);
  await expect(busy.verifier.head(assignment)).rejects.toBe(timeout);
});
