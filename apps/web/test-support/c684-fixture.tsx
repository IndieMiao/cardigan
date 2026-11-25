import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import { ApiError, type TemplateView } from "../src/api.js";
import { card, fakeClient, NOW } from "../src/testing/fixtures.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/components/ui/theme.css";

// C-684: the cards page with three synthetic cards (or none with `?empty`),
// the built-in templates and one preference record. `?open=dev` opens the dev
// template to people. Creating a card whose title contains “失败” is refused
// with the server's reason. No backend, no production data.
Date.now = () => new Date(NOW).getTime();
const query = new URLSearchParams(location.search);
const template = (
  id: string,
  title: string,
  extra: Partial<TemplateView> = {},
): TemplateView => ({
  id,
  title,
  description: "",
  version: 1,
  builtin: true,
  status: "active",
  requires_repo: false,
  merge: "none",
  require_acceptance_criteria: false,
  primary_work_item_key: null,
  work_items: [],
  completion: { mode: "human_mark_done" },
  ...extra,
});
const templates = [
  template("story", "需求卡", { story: true }),
  template("dev", "开发卡", { require_acceptance_criteria: true }),
  template("ui", "界面卡", { require_acceptance_criteria: true }),
  template("design", "设计稿", { require_acceptance_criteria: true }),
  template("general", "通用卡"),
  template("artifact", "产出物"),
];
let allowed = [
  "story",
  ...(query.get("open") ? [query.get("open") ?? ""] : []),
];
const cards = query.has("empty")
  ? []
  : [1, 2, 3].map((n) => ({
      ...card,
      id: `C-${n}`,
      title: ["整理发布说明", "导出周报", "核对卡片页工具栏"][n - 1] ?? "",
      status: (["todo", "in_progress", "in_review"] as const)[n - 1] ?? "todo",
      waiting_on: [],
      why: "进行中",
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
    counts: { total: cards.length, needs_me: 0, agent: cards.length },
  }),
  templates: async () => ({ templates }),
  preferences: async () => ({
    auto_merge_after_minutes: null,
    merge_gate_enabled: true,
    review_max_rounds_ceiling: 20,
    human_card_templates: [...allowed],
  }),
  setHumanCardTemplates: async (_project, changes) => {
    for (const [id, open] of Object.entries(changes))
      allowed = open
        ? [...allowed.filter((x) => x !== id), id]
        : allowed.filter((x) => x !== id);
  },
  createCard: async (_project, input) => {
    if (input.title.includes("失败"))
      throw new ApiError(
        400,
        "validation_failed",
        "人只能开需求卡；“开发卡”需由所有者在设置 → 偏好 → 人可开的卡片模板中放开",
      );
    return { id: "C-4", entry_id: "C-4#1" };
  },
  attachmentMaxBytes: () => 10 * 1024 * 1024,
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(<App client={client} />);
