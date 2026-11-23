import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
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

// C-615: one synthetic card whose timeline references its own PDF, screenshot
// and log, another card's file and a number nobody may see; the comment box
// offers them after `#`. No backend, no production data; downloads are tiny
// synthetic bodies served by the capture script's Vite middleware.
Date.now = () => new Date(NOW).getTime();
const file = (id: string, name: string, mime: string, size: number) =>
  attachment({
    id,
    original_filename: name,
    mime,
    size,
    inline: mime === "image/png",
    thumbnail_path: mime === "image/png" ? `/__c615/files/${id}.png` : null,
    uploaded_by: "human",
    attach_to: { kind: "timeline_entry", id: "C-1#3" },
    download_path: `/__c615/files/${id}${mime === "image/png" ? ".png" : ""}`,
  });
const attachments = [
  file("attachment-141", "新手引导评审.pdf", "application/pdf", 1_843_200),
  file("attachment-142", "第一关截图.png", "image/png", 312_000),
  file("attachment-143", "server.log", "text/plain", 48_000),
];
const foreign = {
  ...file("attachment-97", "关卡数值表.json", "application/json", 9_600),
  card_id: "C-30",
};
const comment = timelineEntry({
  id: "C-1#3",
  event_seq: 3,
  author: "human",
  body: "评审意见见 attachment-141，问题出在第一关（attachment-142），日志 attachment-143。\n\n数值沿用 attachment-97；attachment-404 已删除。",
});
const agent = timelineEntry({
  id: "C-1#4",
  event_seq: 4,
  author: "assignment:A-1",
  body: "已按 attachment-141 第 3 节修改，复测日志见 attachment-143。",
});
const base = cardDetail({ attachments, referenced_attachments: [foreign] });
const detail = {
  ...base,
  card: { ...base.card, ...card, waiting_on: [], why: "进行中" },
  timeline: [agent, comment, ...base.timeline],
};
const client = fakeClient({
  subscribe: (_project, callbacks) => {
    callbacks.status("live");
    return () => {};
  },
  cards: async (_project, filter) => ({
    project_id: "p-1",
    filter,
    cards: [detail.card],
    counts: { total: 1, needs_me: 0, agent: 1 },
  }),
  card: async () => detail,
  mentionCandidates: async () => ({ employees: [] }),
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(<App client={client} />);
