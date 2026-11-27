import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import type {
  AttachmentView,
  CardDetail,
  CardListItem,
  NeedsDecision,
  NeedsPage,
} from "../src/api.js";
import {
  attachment,
  card,
  cardDetail,
  fakeClient,
  timelineEntry,
} from "../src/testing/fixtures.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/components/ui/theme.css";

// C-810: two decisions shaped like SEN-Q-299 (a completion review with design
// images, a motion note and four acceptance criteria) and SEN-Q-303 (an Agent
// question that asks the owner to look at three images). Synthetic text and
// images only (served by c810-capture.mjs); no backend, no production data.
const now = "2026-11-27T08:00:00.000Z";
Date.now = () => Date.parse(now);

const image = (id: string, name: string): AttachmentView =>
  attachment({
    id,
    original_filename: name,
    download_path: `/__c810img/${id}.svg`,
    thumbnail_path: `/__c810img/${id}.svg`,
    preview_path: `/__c810img/${id}.svg`,
    uploaded_at: now,
  });
const file = (id: string, name: string, mime: string): AttachmentView =>
  attachment({
    id,
    original_filename: name,
    mime,
    inline: false,
    download_path: `/__c810img/${id}.bin`,
    thumbnail_path: null,
    uploaded_at: now,
  });

const author = {
  employee: { id: "E-7", name: "顾恺之", title: "设计师", avatar: null },
  author_role: "designer",
  author_display: "顾恺之",
};

const q299: NeedsDecision = {
  id: "Q-299",
  question: "验收 C-187 的完成申请 D-473",
  why: "验收 C-187 的完成申请 D-473",
  status: "open",
  blocking: false,
  decider: "human",
  card_id: "C-187",
  affected_cards: ["C-187"],
  trigger: "completion_review",
  category: "feature_detail",
  assignment_id: null,
  waited_ms: 3_600_000,
  related_cards: [
    { id: "C-187", title: "地图美术表现：家到空间入口的移动表现（设计）" },
  ],
  merge_confirmation: null,
  author: "system",
  author_display: "系统",
  human_required_reason: "卡片模板规定完成申请由人验收，不能交给 PM 代为决定。",
  context:
    "按 Q-283 缩小范围后重提，取代 D-438；引用 D-437、V-570 的设计说明，LOCK-24 已释放。动效说明见 attachment-1660。",
  plain_summary: {
    changed:
      "只交地图上的移动表现设计：从家去另一个地点时，头像沿一条弧形虚线小跳着走过去，到了以后画面以目的地为中心收拢进入场景；回来时从那里展开。",
    impact:
      "这次只是设计，游戏还没改，由实现卡 C-188 照做。地图入口图标和锁定的圆钉样式都不改。",
    risk: "无",
  },
  options: [
    { key: "approve", description: "验收通过", impact: "进入合并或完成" },
    { key: "reject", description: "退回修改", impact: "重新提交完成申请" },
  ],
  recommended: "approve",
  attachments: [
    image("F-1643", "map-move-01-route.png"),
    image("F-1657", "map-move-02-arrive.png"),
    image("F-1658", "map-move-03-return.png"),
    image("F-1659", "map-move-04-avatar.png"),
    file("F-1660", "map-move-motion.html", "text/html"),
  ],
  acceptance_criteria_snapshot: [
    "现状盘点：列出地图上家、地块和空间入口现有的移动与切换方式",
    "移动表现设计稿：从家到有空间的入口、返回两条路线，含头像动作与镜头",
    "设计总监审核通过",
    "所有者拍板确认",
  ],
};

const q303: NeedsDecision = {
  ...author,
  id: "Q-303",
  question: "请你确认：羊圈按 5×5 比例建正式模型",
  why: "请你确认：羊圈按 5×5 比例建正式模型",
  status: "open",
  blocking: true,
  decider: "human",
  card_id: "C-180",
  affected_cards: ["C-180"],
  trigger: null,
  category: "feature_detail",
  assignment_id: "A-524",
  waited_ms: 25 * 60_000,
  related_cards: [{ id: "C-180", title: "羊圈美术：按设计稿做羊圈和羊" }],
  merge_confirmation: null,
  handed_over_from_pm: { at: now, reason: "验收标准要求所有者看图确认" },
  context:
    "按 Q-302 做了 5×5 灰模，俯视图含 4×4 等比例小图。羊圈 25 格，鸡场 35 格；空地由 5 格增至 14 格。门中心 (1.5,5)，投喂槽中心 (0.5,2.5)。",
  plain_summary: {
    changed:
      "按你说的改成 5×5 后又出了一版对比图：羊圈占地从 16 格变成 25 格，棚、槽、草捆大小不变，多出来的 9 格全留给院子。",
    impact: "你确认后美术按 5×5 做正式模型；之前交的羊和羊毛不变。",
    risk: "无",
  },
  options: [
    {
      key: "confirm_5x5",
      description: "保留 5×5 布局，按图制作",
      impact: "占地、门、投喂处位置按本图执行；完工后仍需成品看图",
    },
    {
      key: "revise",
      description: "继续改灰模",
      impact: "美术暂停正式模型，按你的意见再出一版",
    },
  ],
  recommended: "confirm_5x5",
  suggestion: {
    version: 1,
    option: "confirm_5x5",
    rationale: "5×5 后两只羊在院子里有足够空间走动，和鸡场放在一起比例也协调",
    by: "assignment:A-524",
    at: now,
    stale: false,
  },
  attachments: [
    image("F-1822", "C-180-5x5-01-top.png"),
    image("F-1823", "C-180-5x5-02-angle.png"),
    image("F-1824", "C-180-5x5-03-animals.png"),
  ],
};

const comments = (id: string) =>
  Array.from({ length: 3 }, (_, i) =>
    timelineEntry({
      id: `${id}#${10 - i}`,
      card_id: id,
      event_seq: 10 - i,
      body: `合成讨论 ${3 - i}：进度说明。`,
      author_display: i % 2 ? "张良" : "庄周",
      created_at: now,
    }),
  );
const detail = (
  id: string,
  title: string,
  q: NeedsDecision,
  requestAuthor: string,
): CardDetail =>
  cardDetail({
    card: {
      ...card,
      id,
      title,
      status: "review",
      why: `等你拍板 ${q.id}`,
      waiting_on: [{ kind: "decision", ref: q.id, label: `等你拍板 ${q.id}` }],
      next_owners: [{ kind: "human", ref: "human" }],
      updated_at: now,
      created_at: now,
    },
    decisions: [q],
    attachments: [],
    timeline: [
      timelineEntry({
        id: `${id}#11`,
        card_id: id,
        event_seq: 11,
        type: "decision_request",
        decision_id: q.id,
        author: requestAuthor,
        body: q.question,
        created_at: now,
      }),
      ...comments(id),
    ],
    counts: { timeline: 4, deliveries: 1, reviews: 0, open_decisions: 1 },
  });
const details = [
  detail("C-187", q299.related_cards[0]?.title ?? "", q299, "system"),
  detail("C-180", q303.related_cards[0]?.title ?? "", q303, "assignment:A-524"),
];
const cards: CardListItem[] = details.map((d) => ({ ...card, ...d.card }));
const needs = {
  decisions: [q299, q303],
  human_actions: [],
  incidents: [],
} as unknown as NeedsPage;

const client = fakeClient({
  subscribe: (_project, callbacks) => {
    callbacks.status("live");
    return () => {};
  },
  cards: async (_p, filter) => ({
    project_id: "p-1",
    cards,
    server_filtered: true,
    lanes: {},
    filter,
    counts: { total: cards.length, needs_me: 2, agent: 0 },
  }),
  card: async (_p, id) => {
    const found = details.find((d) => d.card.id === id);
    if (!found) throw new Error("Unknown synthetic card");
    return found;
  },
  needsYou: async () => needs,
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<App client={client} />);
