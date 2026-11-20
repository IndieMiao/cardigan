import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import type {
  AuthorView,
  ExecutionAssignment,
  RunView,
  WorkItemView,
} from "../src/api.js";
import type { RunPresence } from "../src/run-presence.js";
import { card, cardDetail, fakeClient, NOW } from "../src/testing/fixtures.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/components/ui/theme.css";

// C-531 evidence only: the page-skeleton cards plus fixed run states. No
// network client, database or real employee records.
Date.now = () => new Date(NOW).getTime();

const people = {
  zhaoyun: ["E-11", "赵云", "开发工程师", "zhao-yun"],
  qingwen: ["E-12", "晴雯", "UI/UX 设计师", "qingwen"],
  daiyu: ["E-13", "林黛玉", "代码审核", "lin-daiyu"],
  zhangliang: ["E-14", "张良", "平台负责人", "zhang-liang"],
  guanyu: ["E-15", "关羽", "开发工程师", "guan-yu"],
  wukong: ["E-16", "孙悟空", "开发工程师", "sun-wukong"],
  miaoyu: ["E-17", "妙玉", "设计总监", "miaoyu"],
  linchong: ["E-18", "林冲", "代码审核", "lin-chong"],
} as const;
type Person = keyof typeof people;
function who(key: Person, n: number): AuthorView {
  const [id, name, title, avatar] = people[key];
  return {
    employee: {
      id,
      name,
      title,
      avatar: `/avatars/v1/${avatar}/head-64.webp`,
    },
    author: `assignment:A-${n}`,
    author_role: "coder",
    author_display: name,
  };
}
const running: RunPresence = { state: "running" };
const queued: RunPresence = { state: "queued" };
const precheck: RunPresence = { state: "waiting", waiting: "precheck" };
const decision: RunPresence = { state: "waiting", waiting: "decision" };
const idle: RunPresence = { state: "idle" };
function participant(key: Person, n: number, presence?: RunPresence) {
  return presence ? { ...who(key, n), run_presence: presence } : who(key, n);
}

const participants: Record<number, ReturnType<typeof participant>[]> = {
  // The user's three-person group: running, queued, waiting for precheck.
  1: [
    participant("zhaoyun", 1, running),
    participant("qingwen", 2, queued),
    participant("daiyu", 3, precheck),
  ],
  // Idle, running, and one person with no run facts (unknown).
  2: [
    participant("zhangliang", 4, idle),
    participant("guanyu", 5, running),
    participant("wukong", 6),
  ],
  // Overflow: two hidden people, one of them running.
  3: [
    participant("miaoyu", 7, idle),
    participant("linchong", 8, decision),
    participant("zhangliang", 9, idle),
    participant("zhaoyun", 10, running),
    participant("qingwen", 11, queued),
  ],
};
const cards = (
  [
    "todo",
    "in_progress",
    "review",
    "awaiting_merge",
    "backlog",
    "cancelled",
    "done",
  ] as const
).map((status, i) => ({
  ...card,
  id: `C-${i + 1}`,
  title:
    i === 1 ? "核对卡片页工具栏、长标题与下一步负责人" : `示例任务 ${i + 1}`,
  status,
  waiting_on: [],
  why: "等待下一步处理",
  priority: i % 5,
  attachment_count: i,
  participants: participants[i] ?? [
    {
      employee: {
        id: "E-1",
        name: "示例开发",
        title: "开发工程师",
        avatar: null,
      },
      author: "assignment:A-1",
      author_role: "coder",
      author_display: "示例开发",
      run_presence: idle,
    },
  ],
}));

const base = cardDetail({ card: cards[1], attachments: [] });
const workItems: WorkItemView[] = [
  {
    ...(base.work_items[0] as WorkItemView),
    card_id: "C-2",
    status: "in_progress",
  },
  {
    ...(base.work_items[1] as WorkItemView),
    card_id: "C-2",
    assignment_id: "A-2",
  },
  {
    ...(base.work_items[1] as WorkItemView),
    id: "W-3",
    card_id: "C-2",
    title: "界面验收",
    role_id: "design_director",
    assignment_id: "A-3",
  },
].map((item, i) => ({
  ...item,
  assignee: who(
    (["zhaoyun", "qingwen", "daiyu"] as const)[i] ?? "zhaoyun",
    i + 1,
  ),
  run_presence: [running, queued, precheck][i] ?? idle,
}));

const minutesAgo = (minutes: number) =>
  new Date(Date.parse(NOW) - minutes * 60_000).toISOString();
const rows: readonly [
  Person,
  string,
  string | null,
  string,
  RunPresence | null,
][] = [
  ["zhaoyun", "A-1", "C-2", "running", running],
  ["qingwen", "A-2", "C-2", "not_provisioned", queued],
  ["daiyu", "A-3", "C-2", "idle", precheck],
  ["guanyu", "A-5", "C-3", "running", running],
  ["zhangliang", "A-4", null, "idle", null],
];
const assignments: ExecutionAssignment[] = rows.map(
  ([key, id, cardId, runtime, presence], i) => ({
    ...who(key, i + 1),
    id,
    role_id: "coder",
    role_version: 1,
    status: "active",
    runtime_state: runtime,
    machine_id: "local",
    standing_mode: cardId ? null : "ops",
    card_id: cardId,
    card_status: cardId ? "in_progress" : null,
    card_title: cardId
      ? (cards.find((c) => c.id === cardId)?.title ?? null)
      : null,
    card_priority: cardId ? 2 : undefined,
    work_item_id: cardId ? `W-${i + 1}` : null,
    worktree_path: null,
    branch: null,
    session_ref: `session-${id}`,
    runtime_ref: { terminal_ref: `t-${id}`, runtime_machine: "local" },
    last_mcp_activity_at: minutesAgo(i + 1),
    cursors: [],
    ...(presence ? { run_presence: presence } : {}),
  }),
);
const runs: RunView[] = rows.flatMap(([, id, , runtime], i) =>
  runtime === "running" || runtime === "not_provisioned"
    ? [
        {
          id: `R-${i + 1}`,
          assignment_id: id,
          status: runtime === "running" ? "running" : "queued",
          kind: "initial",
          outcome: null,
          model: "fixture-model",
          role_version: 1,
          agent_cli_version: "1.0",
          started_at: runtime === "running" ? minutesAgo(i + 2) : null,
          finished_at: null,
          summary: "",
        } as unknown as RunView,
      ]
    : [],
);

const client = fakeClient({
  subscribe: (_project, callbacks) => {
    callbacks.status("live");
    return () => {};
  },
  cards: async (_project, filter) => ({
    project_id: "p-1",
    filter,
    cards,
    counts: { total: 7, needs_me: 0, agent: 7 },
  }),
  card: async () => ({ ...base, work_items: workItems }),
  execution: async () => ({ assignments, runs, machines: [] }),
  executionCapacity: async () => ({
    agents: [
      {
        machine_id: "fixture",
        label: "示例机器",
        running: 2,
        total_running: 4,
        limit: 6,
        max_limit: 8,
        queued: 1,
        merge_check_slots: 0,
      },
    ],
    merge_checks: [
      { machine_id: "fixture-ci", running: 1, limit: 3, queued: 0 },
    ],
    merge_config_invalid: false,
  }),
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(<App client={client} />);
