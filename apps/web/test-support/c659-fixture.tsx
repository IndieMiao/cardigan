import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import type { CardStatus } from "../src/api.js";
import { card, cardDetail, fakeClient, NOW } from "../src/testing/fixtures.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/components/ui/theme.css";

// C-659: 16 synthetic cards across five lanes, with dependencies around C-23.
// No network client or database. C-99 is a prerequisite that the board does
// not show (filtered out), so it must get no line.
Date.now = () => new Date(NOW).getTime();
const lanes: [CardStatus, string[]][] = [
  ["todo", ["C-11", "C-12", "C-13"]],
  ["in_progress", ["C-21", "C-22", "C-23", "C-24", "C-25", "C-26", "C-27"]],
  ["review", ["C-31", "C-32"]],
  ["awaiting_merge", ["C-41", "C-42"]],
  ["done", ["C-51", "C-52"]],
];
const edges: [string, string][] = [
  ["C-11", "C-23"],
  ["C-51", "C-23"],
  ["C-99", "C-23"],
  ["C-23", "C-32"],
  ["C-23", "C-41"],
  ["C-23", "C-27"],
  ["C-12", "C-22"],
  // C-673 performance run (`?dense`): C-23 gets ten visible lines at 1440.
  ...((new URLSearchParams(location.search).has("dense")
    ? [
        ["C-12", "C-23"],
        ["C-13", "C-23"],
        ["C-21", "C-23"],
        ["C-23", "C-31"],
        ["C-23", "C-42"],
        ["C-23", "C-25"],
      ]
    : []) as [string, string][]),
];
const titles: Record<string, string> = {
  "C-11": "设置页管理飞书机器人配置：开关、免打扰、限速",
  "C-23":
    "控制主机临时目录被 Agent 临时产物占满：Run 私有临时目录、结束时清理进程树",
  "C-32": "审核收敛：驳回必须对应验收标准",
  "C-41": "受管发布链一次授权：入库、送签、签后入库",
  "C-27": "请求预检受理阶段读分支 HEAD 遇仓库忙时自动重试",
};
const statusOf = new Map(
  lanes.flatMap(([status, ids]) => ids.map((id) => [id, status] as const)),
);
const ref = (id: string) => ({
  id,
  title: titles[id] ?? `示例任务 ${id}`,
  status: statusOf.get(id) ?? "todo",
  satisfied: statusOf.get(id) === "done",
});
const cards = lanes.flatMap(([status, ids]) =>
  ids.map((id, i) => {
    const predecessors = edges.filter(([, to]) => to === id).map(([f]) => f);
    const successors = edges.filter(([from]) => from === id).map(([, t]) => t);
    return {
      ...card,
      id,
      title: titles[id] ?? `示例任务 ${id}`,
      status,
      waiting_on: [],
      why: "等待下一步处理",
      priority: i % 5,
      attachment_count: i % 3,
      ...(predecessors.length || successors.length
        ? {
            dependency: {
              predecessors: predecessors.map(ref),
              successors: successors.map(ref),
              waiting_on: [],
              critical_path_length: 0,
            },
          }
        : {}),
    };
  }),
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
    counts: { total: cards.length, needs_me: 0, agent: cards.length },
  }),
  card: async () => cardDetail({ card: cards[0], attachments: [] }),
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
