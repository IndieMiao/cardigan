import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import type { CardListItem } from "../src/api.js";
import { card, cardDetail, fakeClient, NOW } from "../src/testing/fixtures.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/components/ui/theme.css";

// C-567 evidence only: the page-skeleton card statuses plus fixed check states.
// No network client, database or real employee records. On a build without
// C-567 the `checking` field is ignored, which is the "before" capture.
Date.now = () => new Date(NOW).getTime();

const sha = "a".repeat(40);
const titles: Record<number, string> = {
  1: "作者等预检：只等预检结果的工作项",
  2: "真正的阻塞：缺少测试环境",
  3: "待合并：合并检查运行中",
};
const cards: CardListItem[] = (
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
  title: titles[i] ?? `示例任务 ${i + 1}`,
  status,
  waiting_on: [],
  why: "等待下一步处理",
  priority: i % 5,
  attachment_count: i,
}));
const at = (i: number, patch: Partial<CardListItem>) => {
  cards[i] = { ...(cards[i] as CardListItem), ...patch };
};
// C-2: the producer reported a blocker that resumes when its precheck ends.
at(1, {
  why: "W-1 阻塞",
  waiting_on: [{ kind: "blocked", ref: "W-1", label: "W-1 阻塞" }],
  prechecks: [{ attempt_id: "P-1", head_sha: sha, status: "running" }],
  checking: { precheck: { attempt_ids: ["P-1"], waiting_items: ["W-1"] } },
});
// C-3: a real blocker, unchanged by C-567.
at(2, {
  why: "W-2 阻塞",
  waiting_on: [{ kind: "blocked", ref: "W-2", label: "W-2 阻塞" }],
});
// C-4: an awaiting-merge card with a running merge check.
at(3, {
  checking: { merge_check: { attempt_id: "M-1", status: "running" } },
});

const base = cardDetail({ attachments: [] });
const detailOf = (id: string) => {
  const item = cards.find((c) => c.id === id) ?? (cards[1] as CardListItem);
  return {
    ...base,
    card: {
      ...base.card,
      ...item,
      prechecks: item.prechecks?.map((check) => ({
        ...check,
        log_ref: `${check.attempt_id}.log`,
        updated_at: NOW,
      })),
    },
  };
};

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
  card: async (_project, id) => detailOf(id),
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(<App client={client} />);
