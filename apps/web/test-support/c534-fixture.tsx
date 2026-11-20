import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import { HelpMarkdown } from "../src/components/HelpMarkdown.js";
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

// C-534 evidence only: one synthetic card whose goal and first comment carry
// four Markdown tables — a copy of the user's C-517 screenshot table, column
// alignment syntax with tags/code/links/raw HTML, a 10-column table, and a
// tag link with a long description (C-534 design review V-2556).
// No network client, database or production data.
Date.now = () => Date.parse(NOW);
const tag = "[C-494](#/p/p-1/cards/C-494)";
const C534_TABLES = `拆解方案（确认后开卡）

| # | 卡 | 模板 | 依赖 |
|---|---|---|---|
| 1 | 启动配置读写接口：读取（provider 不含密钥值、profile、模型元数据、使用者、检查结果）；写入（预览差异 → 确认 → 校验 → 备份 → 原子写 → 热加载）；检查和在线探测；只限人，留审计 | dev | — |
| 2 | 设置页“模型”：列表、详情、编辑（差异确认）、检查、谁在用；员工编辑页可选启动配置 | ui | 1 |
| 另 | ${tag}（设置页角色流程）里“启动配置下拉”改用卡 1 的接口 | 在 ${tag} 卡上补一句 | 1 |

回复“确认”或改几处，我就开子卡。

| 左对齐 | 居中 | 右对齐 |
|:---|:---:|---:|
| \`pnpm lint\` 与 ${tag} | [说明](https://example.com/docs) | 1,234 |
| <b>原始 HTML</b> | 是 | 56 |

| 编号 | 标题 | 状态 | 负责人 | 模板 | 依赖 | 预计 | 风险 | 备注 | 链接 |
|---|---|---|---|---|---|---|---|---|---|
| ${tag} | 设置页角色流程改用启动配置接口 | 进行中 | 前端工程师 | ui | 卡 1 | 2 天 | 低 | 需要等接口合并后再联调 | [说明](https://example.com/docs) |
| \`C-495\` | 启动配置读写接口与审计记录 | 待开始 | 后端工程师 | dev | — | 3 天 | 中 | 只限人类登录会话写入 | — |

| # | 卡 | 依赖 |
|---|---|---|
| 1 | [C-494 设置页角色流程改用启动配置接口](#/p/p-1/cards/C-494) | 1 |
| 2 | 普通文字也很长很长很长的一段说明 | — |`;

const entries = [
  timelineEntry({
    id: "C-1#1",
    event_seq: 1,
    type: "comment",
    body: C534_TABLES,
    author_display: "合成样例",
  }),
];
const detail = cardDetail({
  card: {
    ...card,
    title: "Markdown 表格样式合成卡片",
    goal: C534_TABLES,
    acceptance_criteria: [
      "测试通过",
      "| 场景 | 结果 |\n|---|---:|\n| 窄屏抽屉 | 1 |",
    ],
  },
  timeline: entries,
  counts: { timeline: 1, deliveries: 0, reviews: 0, open_decisions: 0 },
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
createRoot(root).render(
  new URLSearchParams(location.search).has("help") ? (
    <main className="content">
      <article className="help-article" aria-label="帮助正文">
        <HelpMarkdown source={C534_TABLES} />
      </article>
    </main>
  ) : (
    <App client={client} />
  ),
);
