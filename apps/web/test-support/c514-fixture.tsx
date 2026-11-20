import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import type { MentionCandidate } from "../src/api.js";
import { card, cardDetail, fakeClient, NOW } from "../src/testing/fixtures.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/components/ui/theme.css";

// C-514: one synthetic card (the shared cardDetail sample) and 9 synthetic
// active employees, 3 of them on this card; library avatars for 7, initials
// for 2. No backend, no production data.
Date.now = () => new Date(NOW).getTime();
const person = (
  id: string,
  name: string,
  title: string,
  avatar: string | null,
  related = false,
): MentionCandidate => ({
  id,
  name,
  title,
  avatar: avatar && `/avatars/v1/${avatar}/head-64.webp`,
  related,
});
const employees = [
  person("E-5", "张良", "平台负责人", "zhang-liang", true),
  person("E-14", "薛宝钗", "前端工程师", "xue-baochai", true),
  person("E-7", "王熙凤", "代码审核", "wang-xifeng", true),
  person("E-2", "关羽", "开发工程师", "guan-yu"),
  person("E-3", "诸葛亮", "设计总监", "zhuge-liang"),
  person("E-9", "林黛玉", "独立复核员", "lin-daiyu"),
  person("E-11", "Alice", "主机运维", null),
  person("E-12", "森·刘邦", "游戏程序", "liu-bei"),
  person("E-15", "Bob", "游戏策划与关卡、数值、剧情统筹", null),
];
const cards = [
  { ...card, waiting_on: [], why: "进行中" },
  ...[2, 3].map((n) => ({
    ...card,
    id: `C-${n}`,
    title: `示例任务 ${n}`,
    waiting_on: [],
    why: "进行中",
  })),
];
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
  card: async (_project, id) => {
    const base = cardDetail({ attachments: [] });
    return {
      ...base,
      card: { ...base.card, ...cards.find((c) => c.id === id) },
    };
  },
  mentionCandidates: async () => ({ employees }),
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(<App client={client} />);
