import type { ExecutionAssignment, ExecutionData, RunView } from "../api.js";

// C-314: fixed, small synthetic fixture; no production data or service calls.
export const executionDisplayFixture = (): ExecutionData => {
  const assignments: ExecutionAssignment[] = [
    ["running", "E-1", "赵云"],
    ["idle", "E-1", "赵云"],
    ["lost", "E-2", "孙悟空"],
    ["idle", "E-3", "王熙凤"],
    ["idle", "E-4", "大乔"],
    ["idle", "E-5", "赵云"],
    ["unrecognized", null, null],
    ["not_provisioned", "E-6", "张良"],
  ].map(([runtime, employeeId, name], i) => ({
    id: `A-${i + 1}`,
    role_id: i === 3 || i === 7 ? "pm" : i === 4 ? "host_ops" : "coder",
    role_version: 1,
    status: i === 5 ? "released" : "active",
    runtime_state: runtime ?? "unknown",
    machine_id: "fixture",
    standing_mode: i === 3 ? "ops" : i === 7 ? "office" : null,
    external: i === 7,
    card_id: [3, 4, 7].includes(i) ? null : `C-${i + 1}`,
    work_item_id: [3, 4, 7].includes(i) ? null : `W-${i + 1}`,
    card_status: "in_progress",
    card_title: `合成任务 ${i + 1}：${"验证长标题完整阅读与换行".repeat(4)}`,
    worktree_path: null,
    branch: null,
    session_ref: null,
    runtime_ref: { terminal_ref: `t-${i}`, runtime_machine: "fixture" },
    last_mcp_activity_at: `2026-11-15T07:4${i}:00Z`,
    ...(i === 1 ? { queue_ahead: 0 } : {}),
    cursors: [],
    employee: employeeId
      ? {
          id: employeeId,
          name: name ?? "",
          title: "合成员工",
          avatar: `/avatars/v1/${["zhao-yun", "zhao-yun", "sun-wukong", "wang-xifeng", "da-qiao", "zhao-yun", "", "zhang-liang"][i]}/head-64.webp`,
        }
      : null,
  }));
  const runs: RunView[] = assignments.slice(0, 4).map((a, i) => ({
    id: `R-${i + 1}`,
    assignment_id: a.id,
    status: i === 1 ? "queued" : i === 3 ? "completed" : "running",
    kind: "initial",
    model: "fixture-model",
    harness: "codex",
    effort: "high",
    role_version: 1,
    agent_cli_version: "fixture",
    summary: "合成记录",
    context_usage: { used_ratio: 0.25, window_tokens: 200000 },
  }));
  return { assignments, runs, machines: [] };
};
