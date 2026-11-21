import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import type { AttachmentView } from "../src/api.js";
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

// C-540 evidence only: one synthetic card with the attachment mix of the
// user's C-501 screenshot — stitched 1440 and long 390 screenshots, a normal
// screenshot, an undecodable PNG and a text file. The capture script serves
// synthetic image bytes for these paths; no backend or production data.
Date.now = () => Date.parse(NOW);
const files: [string, string, string, number][] = [
  ["F-1", "C-501-1440-dark.png", "image/png", 0],
  ["F-2", "C-501-1440-light.png", "image/png", 0],
  ["F-3", "C-501-390-dark.png", "image/png", 0],
  ["F-4", "C-501-390-light.png", "image/png", 0],
  ["F-5", "settings-1440-light.png", "image/png", 0],
  ["F-6", "broken-capture.png", "image/png", 0],
  ["F-7", "measurements.md", "text/markdown", 2048],
];
const sizes = JSON.parse(
  new URLSearchParams(location.search).get("sizes") ?? "{}",
) as Record<string, number>;
const attachments: AttachmentView[] = files.map(([id, name, mime, size]) => {
  const download_path = `/api/projects/p-1/attachments/${id}`,
    inline = mime.startsWith("image/");
  return {
    id,
    original_filename: name,
    note: `合成样例：${name}`,
    mime,
    size: sizes[id] ?? size,
    sha256: id.slice(2).padStart(64, "0"),
    kind: "evidence",
    attach_to: {
      kind: "timeline_entry",
      id: ["F-1", "F-3", "F-6"].includes(id) ? "C-1#2" : "C-1#1",
    },
    uploaded_by: "assignment:A-1",
    author_display: "合成样例",
    uploader_role: "frontend_engineer",
    uploaded_at: NOW,
    basis: null,
    supersedes: null,
    inline,
    download_path,
    thumbnail_path: inline ? `${download_path}/thumbnail` : null,
  };
});
const detail = cardDetail({
  card: { ...card, title: "附件缩略图合成卡片" },
  attachments,
  timeline: [
    timelineEntry({
      id: "C-1#2",
      event_seq: 2,
      type: "comment",
      body: "附件截图：1440 拼接长图、390 长图和一张无法解码的 PNG。",
      author_display: "合成样例",
    }),
    timelineEntry({
      id: "C-1#1",
      event_seq: 1,
      type: "comment",
      body: "其它截图与测量记录。",
      author_display: "合成样例",
    }),
  ],
  counts: { timeline: 2, deliveries: 1, reviews: 0, open_decisions: 0 },
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
