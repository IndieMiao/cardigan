import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import { Timeline } from "../src/components/Timeline.js";
import {
  attachment,
  card,
  cardDetail,
  fakeClient,
  NOW,
  timelineEntry,
} from "../src/testing/fixtures.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/components/ui/theme.css";

// Fixed, non-production fixture: one card, seven entries, two work items.
Date.now = () => Date.parse(NOW);
const samples = [
  ["comment", "短".repeat(159)],
  ["comment", "长评论正文。".repeat(32)],
  ["instruction", "长指令正文。".repeat(32)],
  ["comment", `## 结构化结论\n\n${"说明".repeat(80)}`],
  ["comment", `${"字".repeat(158)}😀`],
  ["comment", `${"字".repeat(159)}😀`],
  ["comment", `短句${" \n".repeat(100)}`],
] as const;
const entries = samples.map(([type, body], index) =>
  timelineEntry({
    id: `C-1#${index + 1}`,
    event_seq: index + 1,
    type,
    body,
    author_display: `合成样例 ${index + 1}`,
  }),
);
const detail = cardDetail({
  card: {
    ...card,
    title: "卡片详情长正文样式回归，保留完整标题、状态信息与结构化内容",
    goal: "长段正文在详情中使用次要文字颜色和字号。".repeat(12),
    risk_tags: ["permission", "security", "numeric_rule"],
  },
  template: {
    id: "dev",
    title: "开发卡",
    version: 2,
    description: "",
    builtin: true,
    status: "active",
    requires_repo: true,
    merge: "confirm",
    require_acceptance_criteria: true,
    work_items: [],
    primary_work_item_key: "development",
    completion: { mode: "review", reviewer: "reviewer" },
  },
  timeline: entries,
  attachments: [attachment({ mime: "text/plain", inline: false })],
  counts: {
    timeline: entries.length,
    deliveries: 1,
    reviews: 0,
    open_decisions: 0,
  },
});
const client = fakeClient({
  subscribe: (_project, callbacks) => {
    callbacks.status("live");
    return () => {};
  },
  card: async () => detail,
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
  new URLSearchParams(location.search).has("outside") ? (
    <Timeline projectId="p-1" cardId="C-1" entries={entries} attachments={[]} />
  ) : (
    <App client={client} />
  ),
);
