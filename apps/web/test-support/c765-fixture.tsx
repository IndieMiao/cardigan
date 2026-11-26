import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import type { AuthorView } from "../src/api.js";
import type { RunPresence } from "../src/run-presence.js";
import { card, fakeClient, NOW } from "../src/testing/fixtures.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/components/ui/theme.css";

// C-765 evidence only: page-skeleton cards whose participants are given in
// creation order with fixed run states. No network client, database or real
// employee records.
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
const decision: RunPresence = { state: "waiting", waiting: "decision" };
const idle: RunPresence = { state: "idle" };
function participant(key: Person, n: number, presence: RunPresence) {
  return { ...who(key, n), run_presence: presence };
}

// Each list is what an older server sent: creation order. A newer server
// already puts runners first by Run start; the board gives the same result.
const participants: Record<number, ReturnType<typeof participant>[]> = {
  // One runner, created fifth (the reported case: folded into +2 before).
  0: [
    participant("zhangliang", 1, idle),
    participant("qingwen", 2, decision),
    participant("daiyu", 3, idle),
    participant("miaoyu", 4, queued),
    participant("guanyu", 5, running),
  ],
  // Four runners (in Run start order) among two idle people.
  1: [
    participant("zhangliang", 6, idle),
    participant("zhaoyun", 7, running),
    participant("qingwen", 8, queued),
    participant("wukong", 9, running),
    participant("linchong", 10, running),
    participant("guanyu", 11, running),
  ],
  // Nobody running: the given order stays.
  2: [
    participant("miaoyu", 12, idle),
    participant("linchong", 13, decision),
    participant("zhaoyun", 14, queued),
    participant("daiyu", 15, idle),
  ],
};
const cards = (
  [
    "in_progress",
    "in_progress",
    "in_progress",
    "review",
    "backlog",
    "cancelled",
    "done",
  ] as const
).map((status, i) => ({
  ...card,
  id: `C-${i + 1}`,
  title:
    ["1 个运行中员工", "4 个运行中员工", "没有运行中员工"][i] ??
    `示例任务 ${i + 1}`,
  status,
  waiting_on: [],
  why: "等待下一步处理",
  priority: i % 5,
  attachment_count: i,
  participants: participants[i] ?? [participant("zhaoyun", 99, idle)],
}));

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
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(<App client={client} />);
