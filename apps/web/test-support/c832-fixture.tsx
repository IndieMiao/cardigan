// C-832 evidence: the one enable prompt for a device discovered on a machine
// shared by two projects (cardigan, sensen), as the owner's Needs You shows
// it. H-283 is new; H-284's initialization failed after both projects were
// chosen, and the server refuses retrying it. Synthetic data only; no
// server or database.
import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import type { NeedsCounts, NeedsPage } from "../src/api.js";
import { card, fakeClient, NOW, project } from "../src/testing/fixtures.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/components/ui/theme.css";

Date.now = () => new Date(NOW).getTime();
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
}));
const steps = ["插电常亮", "关闭动画", "关闭锁屏"];
const prompt = (
  id: string,
  device: string,
  model: string,
  extra: { phase: "pending" | "failed"; chosen?: string[]; failure?: string },
): NeedsPage["human_actions"][number] => ({
  id,
  card_id: null,
  why: `mac-mini 发现安卓真机 ${model}，给哪些项目用？`,
  instructions: [
    `启用后系统自动${steps.join("、")}，并记录分辨率和系统版本；不恢复出厂，不装卸其它应用。`,
    `设备编号：${device}`,
    ...(extra.failure ? [`上次初始化失败：${extra.failure}`] : []),
  ].join("\n"),
  expected_return: "点“启用”后系统自动初始化，成功后这条待办自动结项。",
  due: null,
  waited_ms: 3_600_000,
  blocked_work_items: [],
  triage: "human",
  executor: "owner",
  handler: "owner",
  device_enablement: {
    machine_id: "mac-mini",
    type: "android.device",
    device_id: device,
    label: "安卓真机",
    model,
    projects: ["cardigan", "sensen"],
    steps,
    ...extra,
  },
});
const page: NeedsPage = {
  decisions: [],
  incidents: [],
  human_actions: [
    prompt("H-283", "WGC6R21609003324", "MRR-W39", { phase: "pending" }),
    prompt("H-284", "R58N12ABCDE", "SM-X200", {
      phase: "failed",
      chosen: ["cardigan", "sensen"],
      failure: "“关闭锁屏”没有成功：请先在设备上取消锁屏密码，再重试",
    }),
  ],
};
const counts: NeedsCounts = {
  total_pending: 2,
  tabs: {
    decisions: { count: 0, attention: 0 },
    merges: { count: 0, attention: 0 },
    actions: { count: 2, attention: 2 },
    later: { count: 0, attention: 0 },
    notices: { count: 0, attention: 0 },
  },
};
(window as unknown as { c832: boolean }).c832 = true;
const client = fakeClient({
  projects: async () => [
    { ...project, id: "cardigan", name: "cardigan" },
    { ...project, id: "sensen", name: "sensen" },
  ],
  subscribe: (_project, callbacks) => {
    callbacks.status("live");
    return () => {};
  },
  cards: async (_project, filter) => ({
    project_id: "cardigan",
    filter,
    cards,
    counts: { total: 7, needs_me: 0, agent: 7 },
  }),
  needsYouCounts: async () => counts,
  needsYouSection: async (_project, section) =>
    section === "actions"
      ? page
      : { decisions: [], human_actions: [], incidents: [] },
  requestMachineDevice: async () => {
    throw new Error("设备正在初始化，稍后再试");
  },
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(<App client={client} />);
