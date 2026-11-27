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

// C-820 evidence only: one synthetic card with the attachment mix of the
// owner's screenshot (6 screenshots with long names and notes, a patch and a
// text file), two comments carrying them and an open decision that names
// three of them. The capture script serves synthetic image bytes for these
// paths; no backend, database or production data.
Date.now = () => Date.parse(NOW);
const uploaded = new Date(Date.parse(NOW) - 2 * 3600_000).toISOString();
const files: [string, string, string, number, string][] = [
  [
    "F-1",
    "c200-A-streets3d-emulator-3f26e951.png",
    "image/png",
    1258291,
    "截图 A 模拟器 Sensen_P0 原型 3f26e951d19a145628d81c4885f44b961c8754fd：默认 60° 倾斜，Streets 立体楼 + 光照（无阴影）+ 占位模型",
  ],
  [
    "F-2",
    "c200-B-standard-emulator-333eb30b.png",
    "image/png",
    1008538,
    "截图 B 模拟器 Sensen_P0 原型 333eb30b0407a7ddab7d153fb7647e241f56610f：STYLE standard，Mapbox Standard 3D 楼/树/光照 + 占位模型",
  ],
  [
    "F-3",
    "c200-C-select-3a-emulator-3f26e951.png",
    "image/png",
    1153434,
    "截图 C 模拟器 Sensen_P0 原型 3f26e951d19a145628d81c4885f44b961c8754fd：PARTS lights,datasf,model，选中 855 Page St 后其楼去掉、原位微缩模型（3a）",
  ],
  [
    "F-4",
    "c200-D-zoom-emulator-3f26e951.png",
    "image/png",
    554803,
    "截图 D 模拟器 Sensen_P0 原型 3f26e951d19a145628d81c4885f44b961c8754fd：同 C，双击放大到 19.5 级（同时选中 226 Scott St）近看微缩模型",
  ],
  [
    "F-5",
    "c200-E-night-emulator-3f26e951.png",
    "image/png",
    897024,
    "截图 E 夜间模式",
  ],
  ["F-6", "c200-F-overview.png", "image/png", 402653, ""],
  [
    "F-7",
    "c200-fix-label-overlap-and-building-height-rounding.patch",
    "text/x-patch",
    18432,
    "补丁：标签重叠与楼高取整，基于 3f26e951",
  ],
  [
    "F-8",
    "c200-measurements.txt",
    "text/plain",
    2304,
    "实测记录：帧率、内存、首屏时间，三台设备各跑 5 次取中位数，原始数据见附件说明末尾的表格。",
  ],
];
const employee = {
  id: "E-9",
  name: "哪吒·森",
  title: "前端工程师",
  avatar: null,
};
const attachments: AttachmentView[] = files.map(
  ([id, name, mime, size, note]) => {
    const download_path = `/api/projects/p-1/attachments/${id}`,
      inline = mime.startsWith("image/");
    return {
      id,
      original_filename: name,
      ...(note ? { note } : {}),
      mime,
      size,
      sha256: id.slice(2).padStart(64, "0"),
      kind: "evidence",
      attach_to: {
        kind: "timeline_entry",
        id: ["F-1", "F-2", "F-3", "F-4"].includes(id) ? "C-1#3" : "C-1#2",
      },
      uploaded_by: "assignment:A-9",
      employee,
      uploader_role: "frontend_engineer",
      uploaded_at: uploaded,
      basis: null,
      supersedes: null,
      inline,
      download_path,
      thumbnail_path: inline ? `${download_path}/thumbnail` : null,
      preview_path: inline ? `${download_path}/thumbnail` : null,
    };
  },
);
const pick = (...ids: string[]) =>
  attachments.filter((a) => ids.includes(a.id));
const decision = {
  id: "Q-1",
  question: "请你确认：地图默认用截图 C 的微缩模型方案",
  status: "open",
  decider: "human",
  blocking: false,
  options: [
    { key: "c", description: "截图 C 方案", impact: "选中楼原位微缩" },
    { key: "b", description: "截图 B 方案", impact: "沿用 Standard 3D" },
  ],
  recommended: "c",
  attachments: pick("F-1", "F-3", "F-7"),
} as unknown as CardDetail["decisions"][number];
const detail = cardDetail({
  card: { ...card, title: "附件展示合成卡片" },
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
      body: "四张模拟器截图，对照不同的 3D 方案。",
      author: "assignment:A-9",
      employee,
      created_at: uploaded,
    }),
    timelineEntry({
      id: "C-1#2",
      event_seq: 2,
      type: "comment",
      body: "其它截图、补丁与实测记录。",
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
