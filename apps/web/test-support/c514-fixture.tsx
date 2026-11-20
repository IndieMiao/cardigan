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
// for 2. `?roster=long` adds 33 more (long names and titles, names with
// spaces), 42 in all; `window.__c514Roster` replaces the roster for the next
// read, and `window.__c514Gate` holds reads until it resolves. No backend, no production data.
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
if (new URLSearchParams(location.search).get("roster") === "long")
  employees.unshift(
    person(
      "E-105",
      "员工05",
      "很长很长的职位名称用于检查省略与截断表现",
      null,
      true,
    ),
    person("E-100", "测试员工非常非常长的名字0号", "运营", "lin-daiyu", true),
    person("E-101", "Mary Jane", "视觉设计", null),
    person("E-103", "明明", "运营", null),
    person("E-104", "Bobby", "设计", null),
    person("E-102", "Mary Jo", "交互设计", null),
    ...Array.from({ length: 27 }, (_, n) =>
      person(
        `E-${110 + n}`,
        `合成员工${String(n + 1).padStart(2, "0")}`,
        n % 3 === 0 ? "负责发布流程、合并检查与主机运维的工程师" : "开发工程师",
        null,
      ),
    ),
  );
declare global {
  interface Window {
    __c514Roster?: MentionCandidate[];
    __c514Reads?: number;
    __c514Gate?: Promise<void>;
  }
}
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
  mentionCandidates: async () => {
    window.__c514Reads = (window.__c514Reads ?? 0) + 1;
    const roster = window.__c514Roster ?? employees;
    await window.__c514Gate;
    return { employees: roster };
  },
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(<App client={client} />);
