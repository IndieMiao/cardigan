import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import type { CardReadOptions } from "../src/api.js";
import {
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

// C-488: one synthetic card with 95 timeline entries (the reported size),
// served in cursor pages like the real API. Older-page reads can be held or
// failed by the capture script; every read is logged for the request checks.
Date.now = () => new Date(NOW).getTime();
const TOTAL = 95;
const entries = Array.from({ length: TOTAL }, (_, i) => {
  const seq = TOTAL - i;
  return timelineEntry({
    id: `C-1#${seq}`,
    event_seq: seq,
    type: seq % 3 ? "comment" : "system",
    author: seq % 3 ? "assignment:A-1" : "system",
    body: `合成时间线记录 ${seq}：用于核对滚动到底部时自动加载更早的记录。`,
    created_at: new Date(
      Date.parse(NOW) - (TOTAL - seq) * 3_600_000,
    ).toISOString(),
  });
});
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
const gate = {
  hold: false,
  fail: false,
  pending: [] as (() => void)[],
  requests: [] as CardReadOptions[],
};
(window as unknown as { c488: typeof gate }).c488 = gate;
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
  card: async (_project, id, options = {}) => {
    gate.requests.push(options);
    if (options.before) {
      if (gate.hold)
        await new Promise<void>((resolve) => gate.pending.push(resolve));
      if (gate.fail) throw new Error("网络中断（合成）");
    }
    const matching = entries.filter(
      (e) => !options.before || e.event_seq < Number(options.before),
    );
    const page = matching.slice(0, options.limit ?? 200);
    const base = cardDetail({ attachments: [] });
    return {
      ...base,
      card: { ...base.card, ...cards.find((c) => c.id === id) },
      timeline: page,
      timeline_next_cursor:
        matching.length > page.length ? String(page.at(-1)?.event_seq) : null,
      counts: { ...base.counts, timeline: TOTAL },
    };
  },
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(<App client={client} />);
