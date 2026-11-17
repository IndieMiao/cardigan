import { builtinCardTemplateVersions } from "@cardigan/domain";
import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import type { CardDetail, CardListItem } from "../src/api.js";
import { card, cardDetail, fakeClient } from "../src/testing/fixtures.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/styles.css";

// Fixed synthetic seed c411-implementation-v1, 12 cards; no production data or API.
const date = "2026-11-17T04:00:00.000Z";
Date.now = () => Date.parse(date);
const builtin = (id: string, version = 1) => {
  const t = builtinCardTemplateVersions.find(
    (t) => t.id === id && t.version === version,
  );
  if (!t) throw new Error(`Missing builtin ${id}@${version}`);
  return t;
};
const definitions = [
  builtin("dev", 2),
  builtin("dev"),
  builtin("product"),
  builtin("integration"),
  builtin("fast_patch"),
  builtin("design"),
  builtin("artifact"),
  builtin("general"),
  {
    ...builtin("dev"),
    id: "custom",
    title: "客户服务与跨区域内容发布联合检查模板（合成长名称）".repeat(3),
    version: 3,
    builtin: false,
  },
  null,
  { ...builtin("dev", 2), title: "自定义开发流程", builtin: false },
  null,
];
const states = [
  "in_progress",
  "todo",
  "review",
  "in_progress",
  "awaiting_merge",
  "review",
  "done",
  "todo",
  "in_progress",
  "backlog",
  "todo",
  "review",
] as const;
const titles = [
  "修复卡片刷新后的排序",
  "补齐历史任务的验收记录",
  "收拢设置页的操作入口",
  "验证当前版本的集成链路",
  "恢复部署后的版本追踪",
  "统一三处模板标记",
  "整理操作与设计说明",
  "记录本周待处理事项",
  "核对跨区域发布前的内容与链接",
  "找回历史卡片的模板信息",
  "核对自定义开发流程",
  "检查缺失模板资料",
];
const rows: CardListItem[] = definitions.map((t, i) => ({
  ...card,
  id: `C-${901 + i}`,
  title: titles[i] ?? "示例",
  status: states[i] ?? "todo",
  priority: i % 5,
  ...(i === 11
    ? {}
    : { template: t?.id ?? "future", template_version: t?.version ?? 7 }),
  template_info: t,
  progress: { completed: i % 4, total: 3 },
  waiting_on:
    i === 4
      ? [{ kind: "decision", ref: "Q-91", label: "等待拍板" }]
      : i === 8
        ? [{ kind: "blocked", ref: "W-91", label: "等待资料" }]
        : [],
  why: i === 5 ? "等待完成申请" : "",
  next_owners: [],
  roles: ["coder"],
  updated_at: date,
  created_at: date,
}));
const details: CardDetail[] = rows.map((row, i) =>
  cardDetail({
    card: {
      ...card,
      ...row,
      goal: "合成任务，用于验证模板标记和当前卡片结构。",
      acceptance_criteria: ["模板类型和版本可读", "保留现有卡片操作"],
    },
    template: definitions[i] ?? null,
    mark_done: { allowed: i === 7, reason: null },
    decisions: [],
    timeline: [],
    reviews: [],
    attachments: [],
    deliveries: [],
    work_items: [],
    counts: {
      timeline: 0,
      deliveries: 0,
      reviews: 0,
      open_decisions: 0,
      open_human_actions: 0,
    },
  }),
);
const client = fakeClient({
  subscribe: (_project, callbacks) => {
    callbacks.status("live");
    return () => {};
  },
  cards: async () => ({
    cards: rows,
    counts: { total: rows.length, needs_me: 0, agent: rows.length },
  }),
  card: async (_p, id) => {
    const d = details.find((d) => d.card.id === id);
    if (!d) throw new Error("Missing card");
    return d;
  },
});
createRoot(document.getElementById("root") as HTMLElement).render(
  <App client={client} />,
);
