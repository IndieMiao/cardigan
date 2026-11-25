import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import { ApiError, type ReleaseNoteEntryView } from "../src/api.js";
import { card, cardDetail, fakeClient, NOW } from "../src/testing/fixtures.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/components/ui/theme.css";

// C-713 synthetic data: 4 published versions (one without a note), 7 cards
// for the cards-page comparison. No network client or database.
// `?mode=empty` has no publication; `?mode=fail` rejects every save.
Date.now = () => new Date(NOW).getTime();
const mode = new URLSearchParams(location.search).get("mode");
const owner = {
  author: "human",
  author_display: "示例所有者",
  member: { id: "M-1", name: "示例所有者", title: "所有者", avatar: null },
};
const pm = {
  author: "assignment:A-9",
  author_role: "pm",
  author_display: "示例 PM",
  employee: {
    id: "E-9",
    name: "示例 PM",
    title: "项目经理",
    avatar: null,
    role_id: "pm",
  },
};
const note = (
  version: string,
  body: string,
  author: typeof owner | typeof pm,
  at: string,
  revision = 1,
) => ({
  version,
  version_code: null,
  decision_id: "Q-1",
  body,
  author: author.author,
  author_view: author,
  created_at: at,
  updated_at: at,
  revision,
});
let entries: ReleaseNoteEntryView[] =
  mode === "empty"
    ? []
    : [
        {
          version: "0.6.0",
          version_code: 2025123101,
          decision_id: "Q-4",
          published_at: "2025-12-31T09:30:00.000Z",
          note: null,
        },
        {
          version: "0.5.1",
          version_code: 2025122001,
          decision_id: "Q-3",
          published_at: "2025-12-20T08:00:00.000Z",
          note: note(
            "0.5.1",
            "- 新增关卡“雪原”\n- 修复存档在低电量时丢失的问题\n- 优化开场加载速度",
            pm,
            "2025-12-20T08:05:00.000Z",
          ),
        },
        {
          version: "0.5.0",
          version_code: 2025121001,
          decision_id: "Q-2",
          published_at: "2025-12-10T08:00:00.000Z",
          note: note(
            "0.5.0",
            [
              "本版本重做了设置页，并加入多语言支持。",
              "",
              "- 设置页按“画面 / 声音 / 操作”分组",
              "- 新增英文与日文界面",
              "- 手柄震动强度可调",
              "- 修复横竖屏切换后按钮错位",
              "- 修复部分机型首次启动黑屏",
              "- 降低后台耗电",
              "- 其它细节优化",
            ].join("\n"),
            owner,
            "2025-12-11T02:00:00.000Z",
            3,
          ),
        },
        {
          version: "0.4.2",
          version_code: 2025120101,
          decision_id: "Q-1",
          published_at: "2025-12-01T08:00:00.000Z",
          note: note(
            "0.4.2",
            "修复登录后偶发闪退。",
            pm,
            "2025-12-01T08:10:00.000Z",
          ),
        },
      ];
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
  card: async () => cardDetail({ card: cards[1], attachments: [] }),
  releaseNotes: async () => ({ entries }),
  writeReleaseNote: async (_project, input) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (mode === "fail")
      throw new ApiError(
        409,
        "stale_target",
        "发版说明已被改为第 4 版，请刷新后再改",
      );
    const saved = note(input.version, input.body, owner, NOW);
    entries = entries.map((entry) =>
      entry.version === input.version ? { ...entry, note: saved } : entry,
    );
    return { note: { ...saved, author_view: undefined }, changed: true };
  },
  executionCapacity: async () => ({
    agents: [
      {
        machine_id: "fixture",
        label: "示例机器",
        running: 2,
        total_running: 4,
        limit: 6,
        max_limit: 8,
        queued: 1,
        merge_check_slots: 0,
      },
    ],
    merge_checks: [
      { machine_id: "fixture-ci", running: 1, limit: 3, queued: 0 },
    ],
    merge_config_invalid: false,
  }),
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(<App client={client} />);
