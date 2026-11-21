/** Public diagnostic vocabulary shared by the workflow and host. No runner-supplied text. */
const ssh = (remote: boolean) =>
  ({
    file: "apps/server/src/merge-checks.test.ts",
    name: `SSH checkout entry failure retries only configured remote executors (remote=${remote})`,
    signature: "vitest-5000ms",
  }) as const;
export const checkFlakeCases = {
  ssh_local: ssh(false),
  ssh_remote: ssh(true),
  corepack: {
    file: "packages/roles/src/test-worker-limit.test.ts",
    name: "root scripts, filtered scripts and direct bin invocation inherit the guard",
    signature: "corepack-pnpm-download",
  },
  loopback: {
    file: "apps/server/src/m3-pm-office-ops.acceptance.test.ts",
    name: "P10 §13.9/M3.5: runtime loss becomes unknown then lost; attention, needs-you and Office report it",
    signature: "loopback-connect",
  },
} as const;
export type CheckFlakeId = keyof typeof checkFlakeCases;
export const checkFlakeIds = Object.keys(checkFlakeCases) as CheckFlakeId[];
