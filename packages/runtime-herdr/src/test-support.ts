import type {
  Assignment,
  Machine,
  Role,
  RuntimeLaunch,
  RuntimeRef,
  RuntimeResult,
} from "@cardigan/domain";
export const assignment: Assignment = {
  id: "A-1" as never,
  scope: "work_item",
  work_item_id: "W-1" as never,
  role_id: "coder",
  role_version: 1,
  status: "active",
  runtime_state: "not_provisioned",
  machine_id: "local",
  runtime_ref: null,
  mcp_token_id: "fixture",
  created_at: "2026-01-01T00:00:00Z",
};
export const role: Role = {
  role_id: "coder",
  version: 1,
  display_name: "Coder",
  kind: "work",
  core_prompt: "Fixture",
  harness: "codex",
  launch_profile_ref: "fixture",
  allowed_tools: ["whoami"],
  capabilities: [],
  abilities: [],
  worktree: "write",
  required_machine_tags: [],
};
export const machine: Machine = {
  id: "local",
  label: "Local",
  herdr_machine: "local",
  os: "linux",
  arch: "x64",
  tags: [],
  max_assignments: 10,
  status: "online",
  last_seen: "2026-01-01T00:00:00Z",
};
export const ref: RuntimeRef = {
  machine_id: "local",
  runtime_machine: "local",
  terminal_ref: "t1",
  agent_name: "coder-c1-w1-a1",
};
export const launch: RuntimeLaunch = {
  command: "node",
  args: ["fixture.cjs"],
  cwd: "/fixture",
  agent_name: ref.agent_name,
  labels: {
    cardigan: "1",
    project: "fixture",
    assignment: assignment.id,
    run: "R-1",
  },
};
export function value<T>(result: RuntimeResult<T>): T {
  if (!result.ok)
    throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}
