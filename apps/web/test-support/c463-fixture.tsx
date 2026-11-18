import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import { card, cardDetail, fakeClient, NOW } from "../src/testing/fixtures.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/components/ui/theme.css";

// C-463: three synthetic cards; card detail requests wait until the capture
// script releases them so the drawer's loading frame can be measured.
Date.now = () => new Date(NOW).getTime();
const cards = ["todo", "in_progress", "review"].map((status, i) => ({
  ...card,
  id: `C-${i + 1}`,
  title:
    i === 1 ? "核对卡片页工具栏、长标题与下一步负责人" : `示例任务 ${i + 1}`,
  status: status as typeof card.status,
  waiting_on: [],
  why: "等待下一步处理",
}));
const pending: Array<() => void> = [];
const gate = window as unknown as {
  c463Pending: () => number;
  c463Release: () => void;
};
gate.c463Pending = () => pending.length;
gate.c463Release = () => {
  for (const release of pending.splice(0)) release();
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
    counts: { total: cards.length, needs_me: 0, agent: cards.length },
  }),
  card: async (_project, id) => {
    await new Promise<void>((resolve) => pending.push(resolve));
    const selected = cards.find((c) => c.id === id) ?? cards[1];
    return cardDetail({ card: selected, attachments: [] });
  },
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(<App client={client} />);
