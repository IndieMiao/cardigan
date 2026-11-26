import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import {
  ApiError,
  type ExecutionAssignment,
  type RunView,
} from "../src/api.js";
import { fakeClient } from "../src/testing/fixtures.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/components/ui/theme.css";

// C-703 evidence: the C-687 design's synthetic Assignments (运行中 A-213,
// 空闲 A-214, 失联 A-215, 已释放 A-216, 会话维护中 A-217) with the Workbench
// start, stop and diff faked. `?op=slow` keeps a write pending, `?op=fail`
// answers with a server reason. No backend, no production data.
const NOW = "2026-11-24T08:00:00.000Z";
Date.now = () => Date.parse(NOW);
const ago = (m: number) => new Date(Date.parse(NOW) - m * 60_000).toISOString();
const usage = (r: number | null) =>
  r === null
    ? null
    : {
        used_ratio: r,
        window_tokens: 200_000,
        used_tokens: Math.round(r * 200_000),
        level:
          r >= 0.85
            ? ("restart" as const)
            : r >= 0.8
              ? ("handoff" as const)
              : null,
        updated_at: ago(1),
      };
const maint = (reason: string, candidate = false) => ({
  reason,
  candidate,
  threshold_minutes: 60,
  evaluated_at: ago(0),
  since: ago(16),
});
type Spec = {
  id: string;
  name: string;
  avatar: string;
  role: string;
  title: string;
  card: string;
  cardTitle: string;
  work: string;
  runtime: string;
  status?: string;
  cardStatus?: string;
  maintenance: ReturnType<typeof maint>;
  cursors: number;
};
const specs: Spec[] = [
  {
    id: "A-213",
    name: "李逵",
    avatar: "li-kui",
    role: "coder",
    title: "开发工程师",
    card: "C-92",
    cardTitle: "动态农场数据集 r5：按建筑轮廓生成可开垦区",
    work: "W-277",
    runtime: "running",
    maintenance: maint("run_busy"),
    cursors: 1,
  },
  {
    id: "A-214",
    name: "林冲",
    avatar: "lin-chong",
    role: "reviewer",
    title: "代码审核",
    card: "C-93",
    cardTitle: "地图图层切换按钮",
    work: "W-281",
    runtime: "idle",
    maintenance: maint("idle_candidate", true),
    cursors: 3,
  },
  {
    id: "A-215",
    name: "鲁智深",
    avatar: "lu-zhishen",
    role: "coder",
    title: "开发工程师",
    card: "C-94",
    cardTitle: "断网时缓存地块数据",
    work: "W-284",
    runtime: "lost",
    maintenance: maint("agent_exited"),
    cursors: 2,
  },
  {
    id: "A-217",
    name: "吴用",
    avatar: "wu-yong",
    role: "coder",
    title: "开发工程师",
    card: "C-95",
    cardTitle: "仓库地块缓存清理",
    work: "W-290",
    runtime: "idle",
    maintenance: maint("retirement_pending"),
    cursors: 1,
  },
  {
    id: "A-216",
    name: "鲁肃",
    avatar: "lu-su",
    role: "acceptance",
    title: "验收测试",
    card: "C-90",
    cardTitle: "地块颜色按季节变化",
    work: "W-270",
    runtime: "idle",
    status: "released",
    cardStatus: "done",
    maintenance: maint("inactive"),
    cursors: 5,
  },
];
const assignments: ExecutionAssignment[] = specs.map((s) => ({
  id: s.id,
  role_id: s.role,
  role_version: 3,
  status: s.status ?? "active",
  runtime_state: s.runtime,
  machine_id: "cardigan-ci",
  standing_mode: null,
  card_id: s.card,
  card_status: s.cardStatus ?? "in_progress",
  card_title: s.cardTitle,
  card_priority: 2,
  work_item_id: s.work,
  worktree_path: `/srv/cardigan-workers/sensen-godot/worktrees/sensen-godot/${s.id}`,
  branch: `agent/${s.card}/${s.work}`,
  session_ref:
    s.status === "released" ? null : `sess-${s.id.toLowerCase()}-7f3a`,
  runtime_ref:
    s.status === "released"
      ? null
      : {
          terminal_ref: `sensen-godot-cardigan-ci/t3f`,
          runtime_machine: "cardigan-ci",
          machine_id: "cardigan-ci",
        },
  last_mcp_activity_at: ago(s.runtime === "lost" ? 42 : 3),
  cursors: Array.from({ length: s.cursors }, (_, i) => ({
    card_id: `C-${92 - i}`,
    acked_seq: 6 + i * 3,
  })),
  session_maintenance: s.maintenance as never,
  employee: {
    id: `E-${s.id}`,
    name: s.name,
    title: s.title,
    avatar: `/avatars/v1/${s.avatar}/head-64.webp`,
    role_id: s.role,
  },
  author: `assignment:${s.id}`,
  author_role: s.role,
  author_display: s.name,
}));
const run = (
  n: number,
  a: string,
  status: string,
  ratio: number | null,
  extra: Partial<RunView> = {},
): RunView => ({
  id: `R-${n}`,
  assignment_id: a,
  status,
  kind: "initial",
  model: "opus",
  harness: "claude",
  effort: "high",
  context_usage: usage(ratio),
  role_version: 3,
  agent_cli_version: "1.0",
  summary: status === "running" ? "" : "已提交交付，等审核。",
  started_at: ago(16),
  ...extra,
});
const runs: RunView[] = [
  run(1973, "A-213", "running", 0.62),
  run(1981, "A-214", "completed", 0.41, {
    outcome: "completed",
    finished_at: ago(25),
  }),
  run(1990, "A-215", "running", null),
  run(1995, "A-217", "completed", 0.2, {
    outcome: "completed",
    finished_at: ago(70),
  }),
  run(1960, "A-216", "completed", 0.33, {
    outcome: "completed",
    finished_at: ago(300),
  }),
];
const history = (a: string): RunView[] => {
  const head = runs.find((r) => r.assignment_id === a);
  if (!head) return [];
  const n = Number(head.id.slice(2));
  return [
    head,
    run(n - 1, a, "completed", null, {
      kind: "followup",
      outcome: "completed",
      summary: "补充截图后重新提交。",
      started_at: ago(90),
      finished_at: ago(70),
    }),
    run(n - 2, a, "completed", null, {
      outcome: "completed",
      summary: "首次交付。",
      started_at: ago(200),
      finished_at: ago(160),
    }),
  ];
};
const op = new URLSearchParams(location.search).get("op");
const answer = async <T,>(value: T, reason: string): Promise<T> => {
  if (op === "slow") await new Promise(() => undefined);
  if (op === "fail") throw new ApiError(409, "stop_failed", reason);
  return value;
};
const longLine = `+  const area = buildArableArea(${"outline, ".repeat(18)}seasons);`;
const patch = [
  "diff --git a/scripts/farm/arable.gd b/scripts/farm/arable.gd",
  "--- a/scripts/farm/arable.gd",
  "+++ b/scripts/farm/arable.gd",
  "@@ -12,7 +12,9 @@ func _ready():",
  " func build(outline):",
  "-  var area = old_area(outline)",
  longLine,
  "+  area.trim_to(outline)",
  "   return area",
  "diff --git a/scripts/farm/seasons.gd b/scripts/farm/seasons.gd",
  "--- a/scripts/farm/seasons.gd",
  "+++ b/scripts/farm/seasons.gd",
  "@@ -1,3 +1,4 @@",
  "+const SPRING = 0",
  " const SUMMER = 1",
  "diff --git a/tests/farm/arable_test.gd b/tests/farm/arable_test.gd",
  "--- a/tests/farm/arable_test.gd",
  "+++ b/tests/farm/arable_test.gd",
  "@@ -40,2 +40,2 @@",
  "-  assert_eq(area.size(), 12)",
  "+  assert_eq(area.size(), 14)",
  "",
].join("\n");
const client = fakeClient({
  startAssignment: (_p, a, restart) =>
    answer(
      { run_id: "R-2001" },
      restart
        ? `未能确认 ${a} 的原会话已退出：原终端仍在运行。停止状态和终端引用均已保留，不会另起会话。`
        : "卡片已暂停，请先解除暂停",
    ),
  stopAssignment: (_p, a) =>
    answer(
      { released: true, aborted: true, held: false },
      `未能确认 ${a} 的原会话已退出：worker 暂时无法连接，查不到原终端和进程。停止状态和终端引用均已保留，不会另起会话。`,
    ),
  assignmentDiff: async (_p, a) => ({
    worktree_path: `/srv/cardigan-workers/sensen-godot/worktrees/sensen-godot/${a}`,
    branch: "agent/C-92/W-277",
    head_sha: "3f9c2d17a0b4e6c8d2f1a9b7c5e3d1f0a2b4c6d8",
    tracked: [
      "scripts/farm/arable.gd",
      "scripts/farm/seasons.gd",
      "tests/farm/arable_test.gd",
    ],
    untracked: ["docs/farm/arable-notes.md"],
    reachable: false,
    patch,
    truncated: false,
  }),
  subscribe: (_p, cb) => {
    cb.status("live");
    return () => {};
  },
  execution: async () => ({ assignments, runs, machines: [] }),
  executionRuns: async (_p, a) => {
    const list = history(a);
    return { runs: list, total: list.length, next_cursor: null };
  },
  executionCapacity: async () => ({
    agents: [
      {
        machine_id: "cardigan-ci",
        label: "cardigan-ci",
        running: 2,
        limit: 12,
        max_limit: 12,
        queued: 0,
        merge_check_slots: 2,
      },
    ],
    merge_checks: [],
    merge_config_invalid: false,
  }),
});
Object.assign(window, { __c687exec: { assignments } });
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<App client={client} />);
