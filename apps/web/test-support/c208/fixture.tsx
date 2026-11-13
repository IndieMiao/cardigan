import { createRoot } from "react-dom/client";
import { App } from "../../src/App.js";
import type { NeedsDecision } from "../../src/api.js";
import {
  card,
  cardDetail,
  fakeClient,
  NOW,
  timelineEntry,
} from "../../src/testing/fixtures.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../../src/styles.css";
import "./palette.css";

document.documentElement.dataset.c208 =
  new URLSearchParams(location.search).get("palette") === "before"
    ? "before"
    : "after";

// Keep relative times stable while comparing the same DOM under two stylesheets.
Date.now = () => new Date(NOW).getTime();
history.scrollRestoration = "manual";
const sample = {
  ...card,
  title: "暗色主题与编号标签联合核对",
  goal: "用中性深灰区分内容层次，让状态和重点信息更清楚。",
  acceptance_criteria: [
    "五个页面的暗色背景均为中性灰",
    "状态文字与编号标签保持清晰可读",
  ],
  priority: 3,
};
const samples = [
  sample,
  ...["todo", "review", "done"].map((status, i) => ({
    ...sample,
    id: `C-${i + 2}`,
    title: ["补充页面设计说明", "复核状态与标签配色", "确认交付证据"][i],
    status,
    priority: i + 1,
    waiting_on: [],
    why: "按当前验收标准推进",
    progress: { completed: i, total: 3 },
  })),
];
const decision: NeedsDecision = {
  id: "Q-1",
  question: "是否继续安排发布前的检查？",
  context: "主要功能已经完成，需要核对交付记录和页面截图。",
  why: "需要确认下一步安排",
  status: "open",
  blocking: true,
  decider: "human",
  card_id: card.id,
  affected_cards: [card.id],
  options: [
    { key: "go", description: "继续检查", impact: "安排审核并核对页面截图" },
    { key: "hold", description: "暂缓", impact: "保留当前工作进度" },
  ],
  recommended: "go",
  waited_ms: 120000,
  trigger: null,
  category: "general",
  assignment_id: null,
  related_cards: [{ id: sample.id, title: sample.title }],
  merge_confirmation: null,
};
const longComment = `本轮核对覆盖页面背景、侧栏、内容卡片和长段文字。正文使用柔和的浅灰，次要信息再低一级；阅读时先看到问题本身，再根据需要查看编号、时间和负责人。标题沿用原有字号和字重，不另外提高文字亮度。

第一项需要确认的是信息层次。审核问题、评论和交付说明常常需要连续阅读，正文不能像白色警告一样抢眼。几段说明放在同一张内容卡里，段落之间保留原有间距；即使文字较长，也不增加装饰框或大面积强调底色。

第二项需要确认的是状态辨识。通过、失败、运行中、阻塞和暂缓仍显示专用图标与中文名称。编号标签的色彩只提示对象类型，不能替代状态，也不能让读者误以为某个对象已经审核通过。长评论里的普通文字保持同一灰度，真正需要注意的结果由旁边的状态信息表达。

最后请结合窄屏核对。正文应自然换行，时间和编号不会挤占阅读区域；需要继续处理时，可以使用已有的评论入口。这里是一段本地示例内容，用来检查连续阅读的亮度和对比度，不代表真实项目的审核结论。`;
const client = fakeClient({
  ...(new URLSearchParams(location.search).has("capacity")
    ? {
        executionCapacity: async () => ({
          agents: [
            {
              machine_id: "local",
              label: "local",
              running: 5,
              limit: 6,
              max_limit: 16,
              queued: 2,
              merge_check_slots: 0,
            },
          ],
          merge_checks: [
            { machine_id: "test-ci", running: 1, limit: 3, queued: 4 },
          ],
          merge_config_invalid: false,
        }),
      }
    : {}),
  subscribe: (_project, callbacks) => {
    callbacks.status("live");
    return () => {};
  },
  card: async () =>
    cardDetail({
      card: sample,
      attachments: [],
      counts: { timeline: 25, deliveries: 1, reviews: 1, open_decisions: 0 },
      deliveries: [
        {
          id: "D-1",
          work_item_id: "W-1",
          kind: "design",
          summary: "本地示例：界面配色与连续阅读",
          subject: { kind: "doc_version", value: "example-v1" },
          status: "submitted",
        },
      ],
      reviews: [
        {
          id: "V-1",
          delivery_id: "D-1",
          work_item_id: "W-2",
          verdict: "reject",
          blocking: true,
          issues: [
            {
              severity: "major",
              must_fix: true,
              pre_existing: false,
              description:
                "第一项：检查正文的连续阅读感受。审核问题、评论和交付说明需要使用同一档柔和浅灰，避免长段文字与状态提示争夺注意力。标题继续使用原有字号和字重，不能靠提高正文亮度来制造层级。",
              proof:
                "将同一段示例文字放在页面、卡片和时间线三档背景上，核对正文与次要信息。",
            },
            {
              severity: "major",
              must_fix: true,
              pre_existing: false,
              description:
                "第二项：核对标签与状态之间的关系。编号颜色只表示对象类型，状态仍需要专用图标和中文名称。短编号不应比旁边的正文更亮，不能因为浅色标签形成一串视觉亮点，打断审核问题的阅读顺序。",
              proof:
                "同时查看任务、运行、审核和交付编号；色差与对比度需要分别计算。",
            },
            {
              severity: "minor",
              must_fix: true,
              pre_existing: false,
              description:
                "第三项：检查窄屏换行。问题说明应跟随内容宽度自然换行，严重程度和必须修复标记保持可读。较长的依据可以使用已有的内容展开入口，展开以后也不能遮住后续段落或把页面撑出横向滚动。",
              proof:
                "分别在宽屏和窄屏打开同一份问题列表，使用相同的示例内容对照。",
            },
            {
              severity: "minor",
              must_fix: false,
              pre_existing: true,
              description:
                "第四项：保留必要的次要信息。发言时间和编号可降低一级亮度，但仍应方便核对；不要为了突出正文而删除阅读所需的背景。建议在长评论下方继续使用原有回复入口，让处理动作紧跟内容。",
              proof: "本条是展示建议标记的示例，不代表产品存在真实缺陷。",
            },
          ],
        },
      ],
      timeline: [
        timelineEntry({
          id: "C-1#25",
          event_seq: 25,
          type: "review",
          review_id: "V-1",
          author_role: "reviewer",
          body: "本地示例：连续阅读问题列表",
        }),
        timelineEntry({
          id: "C-1#24",
          event_seq: 24,
          author_role: "coder",
          body: longComment,
        }),
        timelineEntry({
          id: "C-1#23",
          event_seq: 23,
          author_role: "coder",
          body: "本地示例：请结合审核问题列表核对正文与次要信息的亮度。",
        }),
      ],
    }),
  needsYou: async () => ({
    decisions: [decision],
    human_actions: [],
    incident_handling: {
      host_ops: {
        assignment_id: "A-90",
        name: "张良",
        mention: "张良",
        patrol_interval_ms: 30 * 60_000,
      },
      pm_office: { assignment_id: "A-91", name: null, mention: "A-91" },
      hc_session: "cardigan",
    },
    incidents: [
      {
        id: "A-3",
        role_id: "coder",
        runtime_state: "lost",
        waited_ms: 12 * 60_000,
        card_id: card.id,
        disconnected_at: "2026-01-01T00:00:00.000Z",
        lost_at: null,
        last_run: null,
        author: "assignment:A-3",
        author_role: "coder",
        author_display: "未命名的 coder",
        employee: null,
        member: null,
      },
    ],
  }),
  cards: async (_project, filter) => ({
    project_id: "p-1",
    filter,
    cards: samples,
    counts: { total: 4, needs_me: 1, agent: 3 },
  }),
  activity: async () => ({
    cards: samples.map(({ id, title }) => ({ id, title })),
    events: [
      "delivery_submitted",
      "review_submitted",
      "comment_posted",
      "decision_requested",
      "run_started",
      "card_created",
    ].map((type, i) => ({
      id: `event-${i}`,
      card_id: samples[i % 4].id,
      card_title: samples[i % 4].title,
      seq: 12 - i,
      type,
      role: i % 2 ? "reviewer" : "coder",
      created_at: NOW,
      payload: {
        card_id: samples[i % 4].id,
        summary: "本地示例数据，仅用于设计核对",
      },
      actor: { kind: "assignment", assignment_id: `A-${i + 1}` },
      author_display: i % 2 ? "示例审核员" : "示例设计师",
    })),
    next_before: null,
    counts: { returned: 6, matched: 6 },
  }),
  execution: async () => ({
    assignments: [
      {
        id: "A-1",
        role_id: "coder",
        role_version: 1,
        status: "active",
        runtime_state: "running",
        machine_id: "test",
        standing_mode: null,
        card_id: card.id,
        card_status: card.status,
        work_item_id: "W-1",
        worktree_path: null,
        branch: null,
        session_ref: null,
        runtime_ref: { terminal_ref: "test-terminal", runtime_machine: "test" },
        last_mcp_activity_at: null,
        cursors: [],
      },
      // C-159: every other runtime / Assignment status in the same column.
      ...(
        [
          ["not_provisioned", "active"],
          ["provisioning", "active"],
          ["idle", "suspended"],
          ["unknown", "active"],
          ["lost", "active"],
          ["released", "released"],
        ] as const
      ).map(([runtime_state, status], i) => ({
        id: `A-${i + 430}`,
        role_id: "coder",
        role_version: 1,
        status,
        runtime_state,
        machine_id: "test",
        standing_mode: null,
        card_id: card.id,
        card_status: card.status,
        work_item_id: `W-${i + 472}`,
        worktree_path: null,
        branch: null,
        session_ref: null,
        runtime_ref: null,
        last_mcp_activity_at: null,
        cursors: [],
      })),
    ],
    runs: [
      {
        id: "R-1",
        assignment_id: "A-1",
        status: "running",
        kind: "initial",
        model: "gpt-6.1-sol",
        harness: "codex",
        effort: "xhigh",
        context_usage: { used_ratio: 0.9, window_tokens: 1000000 },
        role_version: 1,
        agent_cli_version: "1.0",
        summary: "正在核对工作台各页窄屏布局",
        started_at: NOW,
      },
    ],
    machines: [],
  }),
});

const root = document.getElementById("root");
if (!root) throw new Error("Missing test root");
createRoot(root).render(<App client={client} />);

// Design-only candidate for C-204: decorate the existing IdTag, no component edits.
const kinds: Record<string, string> = {
  C: "card",
  W: "work-item",
  Q: "decision",
  A: "assignment",
  R: "run",
  D: "delivery",
  V: "review",
  H: "human-action",
  E: "employee",
  M: "member",
  MB: "merge-batch",
};
const decorate = () =>
  document.querySelectorAll<HTMLElement>(".id-tag").forEach((el) => {
    const prefix = el.textContent?.trim().match(/^([A-Z]+)-/)?.[1] ?? "";
    el.dataset.idKind = kinds[prefix] ?? "unknown";
  });
new MutationObserver(decorate).observe(root, {
  childList: true,
  subtree: true,
});
