import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import type { ExecutionAssignment, RunView } from "../src/api.js";
import { fakeClient, NOW } from "../src/testing/fixtures.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/styles.css";

// C-207 screenshots only: deterministic demo data, no business service.
Date.now = () => new Date(NOW).getTime();
history.scrollRestoration = "manual";
const minutesAgo = (minutes: number) =>
  new Date(Date.parse(NOW) - minutes * 60_000).toISOString();

type Row = readonly [
  id: string,
  name: string,
  title: string,
  avatar: string,
  role: string,
  card: string | null,
  work: string | null,
  runtime: string,
  minutes: number,
  extra?: Partial<ExecutionAssignment>,
];
const rows: readonly Row[] = [
  [
    "A-581",
    "晴雯",
    "UI/UX 设计师",
    "qingwen",
    "ui_ux_designer",
    "C-207",
    "W-628",
    "running",
    1,
  ],
  [
    "A-586",
    "妙玉",
    "设计总监",
    "miaoyu",
    "design_director",
    "C-205",
    "W-630",
    "running",
    2,
  ],
  [
    "A-662",
    "孙悟空",
    "开发工程师",
    "sun-wukong",
    "coder",
    "C-204",
    "W-620",
    "running",
    3,
  ],
  [
    "A-584",
    "林冲",
    "代码审核",
    "lin-chong",
    "reviewer",
    "C-208",
    "W-632",
    "not_provisioned",
    4,
    { queue_ahead: 2 },
  ],
  [
    "A-237",
    "张良",
    "平台负责人",
    "zhang-liang",
    "pm",
    null,
    null,
    "not_provisioned",
    5,
    { external: true, standing_mode: "office", runtime_ref: null },
  ],
  [
    "A-570",
    "王熙凤",
    "项目经理",
    "wang-xifeng",
    "pm",
    null,
    null,
    "idle",
    8,
    { standing_mode: "ops" },
  ],
  [
    "A-589",
    "鲁肃",
    "验收测试",
    "lu-su",
    "acceptance",
    "C-211",
    "W-635",
    "idle",
    12,
  ],
  [
    "A-587",
    "李逵",
    "开发工程师",
    "li-kui",
    "coder",
    "C-209",
    "W-633",
    "lost",
    18,
  ],
  [
    "A-588",
    "鲁智深",
    "开发工程师",
    "lu-zhishen",
    "coder",
    "C-210",
    "W-634",
    "idle",
    32,
    { status: "released" },
  ],
];
const assignments: ExecutionAssignment[] = rows.map(
  ([id, name, title, avatar, role, card, work, runtime, minutes, extra]) => ({
    id,
    role_id: role,
    role_version: 3,
    status: "active",
    runtime_state: runtime,
    machine_id: "local",
    standing_mode: null,
    card_id: card,
    card_status: card ? "in_progress" : null,
    card_priority: card ? 2 : undefined,
    work_item_id: work,
    worktree_path: work ? `/worktrees/${id}` : null,
    branch: work ? `agent/${card}/${work}` : null,
    session_ref: `session-${id}`,
    runtime_ref: { terminal_ref: `t-${id}`, runtime_machine: "local" },
    last_mcp_activity_at: minutesAgo(minutes),
    cursors: [],
    employee: {
      id: `E-${id}`,
      name,
      title,
      avatar: `/avatars/v1/${avatar}/head-64.webp`,
      role_id: role,
    },
    author: `assignment:${id}`,
    author_role: role,
    author_display: name,
    ...extra,
  }),
);
const usage = (used_ratio: number | null) =>
  used_ratio === null ? null : { used_ratio, window_tokens: 200_000 };
const run = (
  n: number,
  assignment_id: string,
  status: string,
  harness: string,
  model: string,
  effort: string | null,
  ratio: number | null,
  extra: Partial<RunView> = {},
): RunView => ({
  id: `R-${n}`,
  assignment_id,
  status,
  kind: "initial",
  model,
  harness,
  effort,
  context_usage: usage(ratio),
  role_version: 3,
  agent_cli_version: "1.0",
  summary: "示例执行摘要",
  started_at: minutesAgo(20),
  ...extra,
});
const runs: RunView[] = [
  run(3095, "A-581", "running", "codex", "gpt-6", "high", 0.6234),
  run(3094, "A-586", "running", "claude-code", "opus-5.5", "high", 0.8),
  run(3093, "A-662", "running", "codex", "gpt-6", "high", 0.85),
  run(3092, "A-584", "queued", "claude-code", "opus-5.5", null, null, {
    queue_ahead: 2,
    queue_reason: "concurrency_limit",
  }),
  run(3090, "A-570", "completed", "claude-code", "opus-5.5", "high", 0.4218),
  run(3087, "A-589", "completed", "claude-code", "opus-5.5", "high", 0.1056),
  run(3089, "A-587", "running", "codex", "gpt-6", "high", null),
  run(3088, "A-588", "completed", "claude-code", "opus-5.5", "high", null),
];

const client = fakeClient({
  subscribe: (_project, callbacks) => {
    callbacks.status("live");
    return () => {};
  },
  execution: async () => ({ assignments, runs, machines: [] }),
  executionRuns: async () => ({ runs: [], total: 0, next_cursor: null }),
  executionCapacity: async () => ({
    agents: [
      {
        machine_id: "local",
        label: "示例工作机",
        running: 4,
        limit: 6,
        max_limit: 12,
        queued: 2,
        merge_check_slots: 2,
      },
    ],
    merge_checks: [{ machine_id: "test-ci", running: 1, limit: 2, queued: 0 }],
    merge_config_invalid: false,
  }),
});

const root = document.getElementById("root");
if (!root) throw new Error("Missing test root");
createRoot(root).render(<App client={client} />);
