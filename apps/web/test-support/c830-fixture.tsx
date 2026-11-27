import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import type { AttachmentView, CardDetail } from "../src/api.js";
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

// C-830 evidence only: one synthetic card whose attachments stand in for the
// owner's case (SEN-C-141): a tall 2×3 comparison with small labels, a wide
// strip and an ordinary screenshot. They appear in the attachments tab, as
// tiles and a Markdown chip in the timeline, and on an open decision. The
// capture script serves synthetic image bytes; no backend, database or
// production data.
Date.now = () => Date.parse(NOW);
const uploaded = new Date(Date.parse(NOW) - 2 * 3600_000).toISOString();
const files: [string, string, string][] = [
  [
    "attachment-1",
    "C-141-shake-late-ec5244d9.png",
    "桌面实渲晃动差异图 2×3：GLES3 旧 / GLES3 新 / Mobile 新，各为时钟 10 s 与 3000.37 s",
  ],
  ["attachment-2", "c830-wide-strip.png", "超宽横条：12 帧连续截图"],
  ["attachment-3", "c830-screen.png", "普通截图"],
];
const employee = {
  id: "E-9",
  name: "哪吒·森",
  title: "前端工程师",
  avatar: null,
};
const attachments: AttachmentView[] = files.map(([id, name, note], i) => {
  const download_path = `/api/projects/p-1/attachments/${id}`;
  return {
    id,
    original_filename: name,
    note,
    mime: "image/png",
    size: 120_000 + i * 40_000,
    sha256: String(i + 1).padStart(64, "0"),
    kind: "evidence",
    attach_to: { kind: "timeline_entry", id: "C-1#2" },
    uploaded_by: "assignment:A-9",
    employee,
    uploader_role: "frontend_engineer",
    uploaded_at: uploaded,
    basis: null,
    supersedes: null,
    inline: true,
    download_path,
    thumbnail_path: `${download_path}/thumbnail`,
    preview_path: null,
  };
});
const decision = {
  id: "Q-1",
  question: "请你确认：晃动修复按对比图里的新版本上线",
  status: "open",
  decider: "human",
  blocking: false,
  options: [
    { key: "new", description: "按新版本", impact: "晃动减弱" },
    { key: "old", description: "保留旧版本", impact: "不变" },
  ],
  recommended: "new",
  attachments: attachments.slice(0, 2),
} as unknown as CardDetail["decisions"][number];
const detail = cardDetail({
  card: { ...card, title: "图片大图预览合成卡片" },
  attachments,
  decisions: [decision],
  timeline: [
    timelineEntry({
      id: "C-1#4",
      event_seq: 4,
      type: "decision_request",
      decision_id: "Q-1",
      author: "assignment:A-9",
      employee,
      body: decision.question,
      created_at: uploaded,
    }),
    timelineEntry({
      id: "C-1#3",
      event_seq: 3,
      type: "comment",
      body: "对比图见 attachment-1，超宽条见 attachment-2。",
      author: "assignment:A-9",
      employee,
      created_at: uploaded,
    }),
    timelineEntry({
      id: "C-1#2",
      event_seq: 2,
      type: "comment",
      body: "三张截图。",
      author: "assignment:A-9",
      employee,
      created_at: uploaded,
    }),
  ],
  counts: { timeline: 3, deliveries: 1, reviews: 0, open_decisions: 1 },
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
createRoot(root).render(<App client={client} />);
