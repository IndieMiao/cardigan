import type { DeliveryVerifier } from "@cardigan/domain";
import type { CentralProject, MergeOutcome } from "@cardigan/git-service";
import type { GitBinding } from "./git.js";

/**
 * M4.4 test support: a Git binding that accepts everything.
 *
 * Only tests whose subject is not Git may use it. Production never imports this
 * file — the "accepting" stub deliberately lives outside `packages/*\/src`.
 */
export const acceptingVerifier: DeliveryVerifier = {
  verify: async () => ({ ok: true, value: [] }),
};

export function stubGit(
  overrides: Partial<GitBinding> & {
    readonly project?: CentralProject;
  } = {},
): GitBinding {
  const project = overrides.project;
  const binding: GitBinding = {
    projectOf: () => project,
    verifierFor: () => acceptingVerifier,
    pinDelivery: async () => undefined,
    sync: async () => "up_to_date",
    merge: async (): Promise<MergeOutcome> => ({ status: "stale" }),
    backup: async () => undefined,
    reconcile: async () => [],
    removeWorktree: async () => {
      throw new Error("stub Git cannot remove a worktree");
    },
    diffWorktree: async () => {
      throw new Error("stub Git cannot diff a worktree");
    },
    ...overrides,
  };
  return binding;
}
