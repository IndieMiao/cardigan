// C-775 evidence: a card detail whose reads the server refuses with
// 503 read_timeout. Synthetic data only; no server or database.
// `?phase=retrying` holds every retry wait open (the page while it backs off);
// `?phase=failed` lets the waits pass at once (the page after the last retry).
// The first click on “重试” makes the next read succeed.
import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import { HttpCardiganClient } from "../src/api.js";
import { ServiceUpdatingNotice } from "../src/service-retry.js";
import { card, cardDetail, fakeClient, NOW } from "../src/testing/fixtures.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/components/ui/theme.css";

Date.now = () => new Date(NOW).getTime();
const phase = new URLSearchParams(location.search).get("phase") ?? "failed";
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
const detail = cardDetail({ card: cards[1], attachments: [] });
let recovered = false;
const reads = { count: 0 };
(window as unknown as { c775: unknown }).c775 = {
  reads,
  recover: () => {
    recovered = true;
  },
};
const notice = new ServiceUpdatingNotice();
const http = new HttpCardiganClient(
  async () => {
    reads.count++;
    if (recovered) return Response.json(detail);
    return new Response(
      JSON.stringify({
        error: { code: "read_timeout", message: "读取超时，请稍后重试" },
      }),
      {
        status: 503,
        headers: { "content-type": "application/json", "retry-after": "1" },
      },
    );
  },
  undefined,
  {
    notice,
    sleep: (ms) =>
      phase === "retrying"
        ? new Promise(() => {})
        : new Promise((resolve) => setTimeout(resolve, ms / 1000)),
  },
);
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
  card: (projectId, cardId, options) => http.card(projectId, cardId, options),
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(<App client={client} serviceNotice={notice} />);
