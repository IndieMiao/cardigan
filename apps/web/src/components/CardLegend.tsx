import type { ReactNode } from "react";
import type { CardListItem, CardStatus } from "../api.js";
import { DEFAULT_CARD_DISPLAY } from "../card-display.js";
import { BOARD_STATUSES } from "../status.js";
import { BoardCard, BoardCardIcon, ProgressPie } from "./BoardCard.js";
import { StatusTag } from "./Foundation.js";
import { IdBadge } from "./IdTag.js";
import { PRIORITY_LEVELS, PriorityGlyph } from "./Priority.js";
import { StatusIcon } from "./StatusIcon.js";
import { TEMPLATE_GLYPHS, TemplateGlyph } from "./TemplateMarker.js";
import "./CardLegend.css";

export const CARD_GUIDE_SLUG = "03-card-signals";

const statusDescriptions = {
  backlog: ["灰色虚线圆", "待整理，尚未进入执行队列。"],
  todo: ["蓝色空心圆", "待开始，已有工作但尚未开始执行。"],
  in_progress: ["青蓝色圆内四分之一扇形", "正在推进工作。"],
  review: ["紫色圆内实心点", "审核或完成申请阶段，具体等待内容见原因。"],
  awaiting_merge: ["青绿色圆内合流箭头", "待合并，仍需通过合并门禁。"],
  done: ["绿色实心圆内对勾", "卡片已经完成。"],
  cancelled: ["灰棕色圆内斜线", "卡片已取消；被取代时还会显示取代标记。"],
} satisfies Record<CardStatus, readonly [string, string]>;

const priorityDescriptions = {
  none: "灰色圆内斜线，没有亮起的信号格",
  low: "蓝色，三格中亮起一格",
  medium: "黄色，三格中亮起两格",
  high: "橙色，三格全部亮起",
  urgent: "红色实心方块内感叹号，不使用信号格",
} satisfies Record<(typeof PRIORITY_LEVELS)[number]["name"], string>;

interface LegendRow {
  id: string;
  element: ReactNode;
  meaning: string;
  when: string;
  /** A real BoardCard signal must match a documented row in the coverage test. */
  selectors?: readonly string[];
}

const icon = (name: Parameters<typeof BoardCardIcon>[0]["name"]) => (
  <BoardCardIcon name={name} />
);
const progress = (completed: number, total: number) => (
  <span
    className={`board-card-badge${completed === total && total > 0 ? " board-card-complete" : ""}`}
  >
    <ProgressPie completed={completed} total={total} />
    {completed}/{total}
  </span>
);

export const CARD_LEGEND_GROUPS: readonly {
  title: string;
  rows: readonly LegendRow[];
}[] = [
  {
    title: "左侧竖条",
    rows: [
      {
        id: "border-normal",
        element: <span className="card-guide-swatch">无彩色竖条</span>,
        meaning: "没有需要强调的拍板、执行或阻塞信号。",
        when: "普通进行中、待审核等情况。没有彩条不代表卡片已完成。",
      },
      {
        id: "border-waiting",
        element: (
          <span className="card-guide-swatch card-tile-waiting">
            琥珀色（黄橙色）
          </span>
        ),
        meaning: "有待拍板或待人执行的事项。",
        when: "存在拍板或人工操作等待，且没有阻塞。",
        selectors: [".card-tile-waiting"],
      },
      {
        id: "border-blocked",
        element: (
          <span className="card-guide-swatch card-tile-blocked">红色</span>
        ),
        meaning: "工作被阻塞。",
        when: "存在阻塞原因；同时有等待时，红色竖条优先。",
        selectors: [".card-tile-blocked"],
      },
    ],
  },
  {
    title: "状态图标",
    rows: BOARD_STATUSES.map((status) => ({
      id: `status-${status}`,
      element: <StatusTag status={status} />,
      meaning: statusDescriptions[status][0],
      when: statusDescriptions[status][1],
      selectors: [`.status-${status}`],
    })),
  },
  {
    title: "优先级",
    rows: PRIORITY_LEVELS.map((level, value) => ({
      id: `priority-${level.name}`,
      element: (
        <>
          <PriorityGlyph value={value} />
          {level.label}
        </>
      ),
      meaning: priorityDescriptions[level.name],
      when: `优先级设为“${level.label}”时；只表达优先程度，不代表执行进度。`,
      selectors: [`.priority-${level.name}`],
    })),
  },
  {
    title: "模板标记",
    rows: [
      ...Object.entries(TEMPLATE_GLYPHS).map(([kind, glyph]) => ({
        id: `template-${kind}`,
        element: (
          <>
            <TemplateGlyph kind={kind as keyof typeof TEMPLATE_GLYPHS} />
            {glyph.name}
          </>
        ),
        meaning: `中性浅底${glyph.shape}。`,
        when:
          kind === "dev"
            ? "内置开发卡 v2 在看板和列表省略；历史 v1 仍显示。详情页始终显示。"
            : kind === "custom"
              ? "自定义、未识别或资料缺失时始终显示；缺失版本提示“版本未记录”。"
              : "—",
        selectors: [`.template-marker [data-template-glyph="${kind}"]`],
      })),
      {
        id: "template-position",
        element: "看板右上角 / 列表行尾 / 详情页头",
        meaning:
          "悬停、键盘聚焦或点按可读卡片绑定的模板名与版本。标记不表示优先级、进度或权限。",
        when: "有模板标记时；窄屏列表放在编号行右侧。",
        selectors: [".template-marker"],
      },
    ],
  },
  {
    title: "工作项进度",
    rows: [
      {
        id: "progress-empty",
        element: progress(0, 0),
        meaning: "灰色空心圆，尚无工作项。",
        when: "工作项总数为零；不会显示为全部完成。",
      },
      {
        id: "progress-zero",
        element: progress(0, 2),
        meaning: "灰色空心圆，尚无已完成的工作项。",
        when: "总数大于零，完成数为零。",
      },
      {
        id: "progress-partial",
        element: progress(3, 4),
        meaning: "灰色扇形按比例填充，已完成 3 个，共 4 个。",
        when: "部分工作项已完成；产出被接受、验证通过都计入完成数，并非只数验证项。",
        selectors: [
          ".board-progress",
          ".board-card-badge:has(.board-progress)",
        ],
      },
      {
        id: "progress-complete",
        element: progress(3, 3),
        meaning: "绿色实心圆，全部工作项完成。",
        when: "完成数等于非零总数；不等于已经合并，仍要看卡片状态。",
        selectors: [".board-card-complete"],
      },
    ],
  },
  {
    title: "编号与元信息",
    rows: [
      {
        id: "number",
        element: <IdBadge id="C-410" />,
        meaning: "卡片编号，蓝色浅底标签。",
        when: "开启“显示 → 编号”时。",
        selectors: [".card-id"],
      },
      {
        id: "title",
        element: "卡片标题",
        meaning: "要完成的工作；长标题自然换行。",
        when: "始终显示。悬停或键盘聚焦可查看完整标题。",
        selectors: [".card-title"],
      },
      {
        id: "participants",
        element: "头像组 / +2",
        meaning:
          "参与员工，最多显示三个头像；+数字表示其余人数，缺少身份时显示角色占位。",
        when: "卡片工作项有未释放的负责人时。头像可打开员工卡片，额外人数可查看其余名字；不是只显示下一步负责人。",
        selectors: [".employee-owners"],
      },
      {
        id: "roles",
        element: <>{icon("roles")}负责角色</>,
        meaning: "双人轮廓，查看这张卡需要哪些角色。",
        when: "开启“显示 → 负责角色”时；未配置也会明确提示。",
        selectors: ['[aria-label^="负责角色："]'],
      },
      {
        id: "next",
        element: <>{icon("next")}下一步</>,
        meaning: "人形加箭头，查看下一步由谁处理。",
        when: "开启“显示 → 下一步”时；没有下一步负责人显示“无人”。",
        selectors: ['[aria-label^="下一步："]'],
      },
      {
        id: "updated",
        element: <>{icon("clock")}最近活动</>,
        meaning: "时钟和相对时间，表示最近一次卡片事件；无事件时使用创建时间。",
        when: "开启“显示 → 更新时间”时；提示中可查看完整时间，不是耗时或截止时间。",
        selectors: ['[aria-label^="更新时间："]'],
      },
      {
        id: "attachment",
        element: <>{icon("attachment")}附件数</>,
        meaning: "回形针后面的数字是附件总数。",
        when: "附件数大于零；零个附件时隐藏。",
        selectors: ['[aria-label^="附件："]'],
      },
      {
        id: "queue",
        element: (
          <>
            <StatusIcon status="queued" />
            排队数
          </>
        ),
        meaning: "蓝色空心圆旁的灰色数字表示前面还有几个运行任务。",
        when: "存在排队任务；0 提示“即将开始”，多个任务取最靠前的一个。",
        selectors: ['[aria-label^="排队中"], [aria-label="即将开始"]'],
      },
    ],
  },
  {
    title: "等待、暂停与取代",
    rows: [
      {
        id: "decision",
        element: (
          <>
            <StatusIcon status="waiting_decision" />
            等你拍板
          </>
        ),
        meaning: "紫色圆内实心点；没有阻塞时，左侧使用琥珀色等待竖条。",
        when: "存在拍板等待且开启“显示 → 等待标记”。",
        selectors: ['[aria-label^="等你拍板："]'],
      },
      {
        id: "human_action",
        element: (
          <span className="board-card-waiting card-guide-icon">
            {icon("human_action")}待你执行
          </span>
        ),
        meaning: "琥珀色手形，提示需要人工操作。",
        when: "存在人工操作等待且开启“显示 → 等待标记”。",
        selectors: [".board-card-waiting", '[aria-label^="待你执行："]'],
      },
      {
        id: "blocked",
        element: (
          <>
            <StatusIcon status="blocked" />
            阻塞
          </>
        ),
        meaning: "红色实心圆内感叹号，提示工作无法继续。",
        when: "存在阻塞且开启“显示 → 等待标记”。同类原因合并在一个提示里，不同类标记可同时出现。",
        selectors: [".board-card-blocked", '[aria-label^="阻塞："]'],
      },
      {
        id: "review-reason",
        element: (
          <span className="card-review-reason">
            等待完成申请 / 待审核 · 手动派活
          </span>
        ),
        meaning:
          "灰色原因文字：前者表示仍需完成申请；后者表示待审核但需手动指派。也可能显示等待新交付、审核中等当前原因。",
        when: "状态为“审核中”且未暂停时，显示系统给出的当前原因；普通审核等待不产生彩色竖条。",
        selectors: [".card-review-reason"],
      },
      {
        id: "hold",
        element: <strong className="card-hold-tag">已暂停</strong>,
        meaning:
          "暂停区展示原因和恢复条件。暂停期间不派发新工作，已有结果保留，正在执行的工作可继续完成。",
        when: "卡片被设置为暂停时。标题里的“【暂停】”若只是手写文字，不代表系统暂停；以“已暂停”区域为准。",
        selectors: [".card-hold-details", ".card-hold-tag"],
      },
      {
        id: "superseded",
        element: (
          <>
            <StatusIcon status="superseded" />
            已被取代
          </>
        ),
        meaning:
          "灰棕色圆内斜线；整张卡底色及标题弱化。提示会给出取代它的卡片（如有）。",
        when: "处理结果是“已被取代”。",
        selectors: [".card-superseded", '[aria-label^="已被"]'],
      },
      {
        id: "reason",
        element: <>{icon("reason")}原因</>,
        meaning: "灰色圆内信息符号，提示中显示当前等待或推进原因。",
        when: "开启“显示 → 原因”时；这一项默认关闭。",
        selectors: ['[aria-label^="原因："]'],
      },
    ],
  },
];

export function cardGuideExample(now = Date.now()): CardListItem {
  return {
    id: "C-410",
    template: "product",
    template_version: 1,
    template_info: {
      id: "product",
      title: "产品卡",
      version: 1,
      builtin: true,
    },
    title: "帮助页增加卡片图例（示例）",
    status: "review",
    priority: 3,
    repo: "",
    base_branch: "main",
    created_at: new Date(now - 3600000).toISOString(),
    updated_at: new Date(now - 120000).toISOString(),
    why: "等待完成申请",
    waiting_on: [{ kind: "decision", ref: "Q-1", label: "确认示例方案" }],
    next_owners: [{ kind: "role", ref: "reviewer" }],
    related_cards: [],
    progress: { completed: 3, total: 4 },
    roles: ["coder", "reviewer"],
    attachment_count: 2,
    participants: ["开发", "审核", "验收", "设计"].map((name, i) => ({
      employee: {
        id: `E-${i + 1}`,
        name: `示例${name}`,
        title: name,
        avatar: null,
      },
    })),
  };
}

const annotations = [
  "左侧等待竖条",
  "卡片编号",
  "当前状态",
  "卡片标题",
  "当前等待原因",
  "优先级",
  "工作项进度",
  "参与员工",
  "最近活动",
  "附件数",
  "拍板等待标记",
  "模板标记",
];

export function CardLegend({ projectId }: { projectId: string }) {
  return (
    <div className="help-markdown card-guide">
      <h2>看懂卡片</h2>
      <figure className="card-guide-example">
        <div className="card-guide-preview" inert aria-hidden="true">
          <BoardCard
            card={cardGuideExample()}
            projectId={projectId}
            display={{ ...DEFAULT_CARD_DISPLAY, roles: false, next: false }}
          />
        </div>
        <figcaption>
          <p>示例卡片 · 合成数据，仅用于说明</p>
          <ol>
            {annotations.map((label) => (
              <li key={label}>{label}</li>
            ))}
          </ol>
        </figcaption>
      </figure>
      <p>
        下表按实际颜色、形状和出现条件逐项说明。亮暗主题使用同一组语义色；部分字段可在卡片页的“显示”菜单中关闭。看板上悬停或用键盘聚焦图标，可以查看具体原因。
      </p>
      {CARD_LEGEND_GROUPS.map((group) => (
        <section key={group.title} aria-label={group.title}>
          <h3>{group.title}</h3>
          <table aria-label={`${group.title}对照表`}>
            <thead>
              <tr>
                <th scope="col">元素</th>
                <th scope="col">含义</th>
                <th scope="col">什么时候出现</th>
              </tr>
            </thead>
            <tbody>
              {group.rows.map((row) => (
                <tr key={row.id} data-legend-signal={row.id}>
                  <td>
                    <span className="card-guide-element">{row.element}</span>
                  </td>
                  <td data-label="含义">{row.meaning}</td>
                  <td data-label="出现条件">{row.when}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}
