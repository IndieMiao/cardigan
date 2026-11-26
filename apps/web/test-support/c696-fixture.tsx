import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import {
  ApiError,
  type CardDetail,
  type CardListItem,
  type TemplateView,
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

// C-696: the “标记完成” dialog on two synthetic general cards: C-48 with 14
// evidence files (as the C-687 design) and C-49 with none. `?done=` picks
// how marking done answers: `pending` never answers, `fail` is refused,
// anything else succeeds and the card reads as done afterwards. No backend,
// no production data. Fixed clock.
const now = "2026-11-24T08:00:00.000Z";
Date.now = () => Date.parse(now);
const outcome = new URLSearchParams(location.search).get("done") ?? "ok";

const generalTpl = {
  id: "general",
  title: "通用任务",
  version: 1,
  description: "",
  builtin: true,
  status: "active",
  requires_repo: false,
  merge: "none",
  require_acceptance_criteria: false,
  work_items: [],
  primary_work_item_key: null,
  completion: { mode: "human_mark_done" },
} as TemplateView;

const evidence = Array.from({ length: 14 }, (_, i) =>
  attachment({
    id: `F-${1201 + i}`,
    original_filename: `现场照片-${String(i + 1).padStart(2, "0")}.png`,
    download_path: `/api/projects/p-1/attachments/F-${1201 + i}`,
    thumbnail_path: null,
    inline: false,
  }),
);

const make = (
  id: string,
  title: string,
  attachments: CardDetail["attachments"],
): CardDetail => {
  const base = cardDetail();
  return {
    ...base,
    card: {
      ...base.card,
      id,
      title,
      status: "in_progress",
      template: "general",
      template_version: 1,
      goal: "到三号仓库现场复核货架承重标签，拍照记录，并写明是否需要更换。",
      acceptance_criteria: [],
      next_owners: [{ kind: "human", ref: "human" }],
      waiting_on: [
        { kind: "human_action", ref: "H-50", label: "等你执行 H-50" },
      ],
      progress: { completed: 0, total: 0 },
      risk_tags: [],
      related_cards: [],
      created_at: "2026-11-20T02:00:00.000Z",
    },
    template: generalTpl,
    mark_done: { allowed: true, reason: null },
    updated_at: now,
    merge_confirmations: [],
    decisions: [],
    deliveries: [],
    reviews: [],
    review_matrix: [],
    attachments,
    human_actions: [],
    work_items: [],
    timeline: [
      timelineEntry({
        id: `${id}#1`,
        card_id: id,
        type: "system",
        body: "卡片已创建",
        created_at: "2026-11-20T02:00:00.000Z",
      }),
    ],
    counts: { timeline: 1, deliveries: 0, reviews: 0, open_decisions: 0 },
  } as CardDetail;
};

const details: CardDetail[] = [
  make("C-48", "现场勘查：三号仓库货架承重复核", evidence),
  make("C-49", "现场勘查：二号仓库消防通道复核", []),
];
const done = new Set<string>();
const read = (id: string): CardDetail => {
  const detail = details.find((d) => d.card.id === id);
  if (!detail) throw new Error("Unknown synthetic card");
  return done.has(id)
    ? {
        ...detail,
        card: {
          ...detail.card,
          status: "done",
          resolution: "done",
          next_owners: [],
          waiting_on: [],
        },
        mark_done: { allowed: false, reason: "卡片已完成" },
      }
    : detail;
};
const client = fakeClient({
  subscribe: (_project, callbacks) => {
    callbacks.status("live");
    return () => {};
  },
  cards: async (_p, filter) => {
    const cards: CardListItem[] = details.map((d) => ({
      ...card,
      ...read(d.card.id).card,
    }));
    return {
      project_id: "p-1",
      cards,
      server_filtered: true,
      lanes: {},
      filter,
      counts: { total: cards.length, needs_me: 2, agent: 0 },
    };
  },
  card: async (_p, id) => read(id),
  markCardDone: (_p, id) => {
    if (outcome === "pending") return new Promise(() => {});
    if (outcome === "fail")
      return Promise.reject(
        new ApiError(409, "illegal_transition", "卡片已暂停，请先解除暂停"),
      );
    done.add(id);
    return Promise.resolve();
  },
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<App client={client} />);
