import React, {
  useEffect,
  useId,
  useRef,
  useState,
  useLayoutEffect,
} from "react";
import { createPortal } from "react-dom";
import "../../../apps/web/node_modules/@fontsource-variable/inter/index.css";
import "../../../apps/web/node_modules/@fontsource-variable/noto-sans-sc/index.css";
import { createRoot } from "react-dom/client";
import { BoardCard } from "../../../apps/web/src/components/BoardCard";
import { IdBadge } from "../../../apps/web/src/components/IdTag";
import { PriorityBadge } from "../../../apps/web/src/components/Priority";
import { StatusTag } from "../../../apps/web/src/components/Foundation";
import "../../../apps/web/src/styles.css";
import "./prototype.css";

const query = new URLSearchParams(location.search);
const variant = query.get("variant") || "a";
const view = query.get("view") || "board";
const theme = query.get("theme") || "light";
document.documentElement.dataset.theme = theme;
document.body.dataset.variant = variant;
const types = [
  ["dev", 2, "开发卡"],
  ["dev", 1, "开发卡"],
  ["product", 1, "产品卡"],
  ["integration", 1, "集成验证"],
  ["fast_patch", 1, "快速补丁"],
  ["design", 1, "设计稿"],
  ["artifact", 1, "产出物"],
  ["general", 1, "通用任务"],
  ["custom", 3, "客户服务与跨区域内容发布联合检查模板（合成长名称）"],
  ["unknown", null, "未知模板"],
];
const titles = [
  "修复卡片刷新后的排序",
  "补齐历史任务的验收记录",
  "收拢设置页的操作入口",
  "验证当前版本的集成链路",
  "恢复部署后的版本追踪",
  "统一三处模板标记",
  "整理操作与设计说明",
  "记录本周待处理事项",
  "核对跨区域发布前的内容与链接",
  "找回历史卡片的模板信息",
];
const statuses = [
  "in_progress",
  "todo",
  "review",
  "in_progress",
  "awaiting_merge",
  "review",
  "done",
  "todo",
  "in_progress",
  "backlog",
];
const cards = types.map(([template, version, name], i) => ({
  id: `C-${901 + i}`,
  title: titles[i],
  template,
  version,
  name,
  status: statuses[i],
  priority: i % 5,
  progress: { completed: i === 6 ? 3 : i % 3, total: 3 },
  roles: ["开发"],
  participants: [],
  next_owners: [],
  waiting_on:
    i === 4
      ? [{ kind: "decision", ref: "Q-91", label: "等待拍板" }]
      : i === 8
        ? [{ kind: "blocked", ref: "W-91", label: "等待资料" }]
        : [],
  why: "等待审核",
  updated_at: "2026-11-16T23:00:00Z",
  created_at: "2026-11-16T22:00:00Z",
  related_cards: [],
  repo: "",
  base_branch: "main",
  attachment_count: i === 6 ? 2 : 0,
}));
const paths = {
  dev: "m7 5-5 5 5 5m6-10 5 5-5 5m-2-12-2 14",
  product: "m10 2 7 4v8l-7 4-7-4V6Zm-7 4 7 4 7-4m-7 4v8",
  integration: "M3 3h5v6H3zM12 11h5v6h-5zM8 6h5v5M7 14h5M5 9v5h2",
  fast_patch: "m11 2-7 9h5l-1 7 8-10h-6Z",
  design: "m3 13 9-9 4 4-9 9-5 1Zm7-7 4 4M3 13l4 4m6-14 1-1 4 4-1 1",
  artifact: "M4 2h8l4 4v12H4Zm8 0v5h4M7 11h6m-6 3h4",
  general: "M5 4H3v14h14V4h-2M7 2h6v4H7ZM6 10h8m-8 4h5",
  custom: "m10 2 7 4v8l-7 4-7-4V6ZM7 7h6v6H7Z",
  unknown: "m10 2 7 4v8l-7 4-7-4V6ZM7 7h6v6H7Z",
};
function Glyph({ type }) {
  return (
    <svg
      viewBox="0 0 20 20"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[type] || paths.unknown} />
    </svg>
  );
}
function Tip({ anchor, id, label }) {
  const ref = useRef(null),
    [pos, setPos] = useState({ top: 0, left: 0 });
  useLayoutEffect(() => {
    const a = anchor.current.getBoundingClientRect(),
      t = ref.current.getBoundingClientRect();
    setPos({
      left: Math.max(12, Math.min(a.left, innerWidth - t.width - 12)),
      top:
        a.bottom + t.height + 8 < innerHeight
          ? a.bottom + 6
          : Math.max(12, a.top - t.height - 6),
    });
  }, [anchor, label]);
  return createPortal(
    <span ref={ref} className="template-tip" style={pos} id={id} role="tooltip">
      {label}
    </span>,
    document.body,
  );
}
function Marker({ card, force = false }) {
  const [open, setOpen] = useState(false),
    [pinned, setPinned] = useState(false);
  const ref = useRef(null),
    id = useId();
  const omitted =
    variant === "before" ||
    (variant === "b" &&
      card.template === "dev" &&
      card.version === 2 &&
      !force);
  useEffect(() => {
    const close = (e) => {
      if (!ref.current?.contains(e.target)) {
        setOpen(false);
        setPinned(false);
      }
    };
    document.addEventListener("pointerdown", close);
    const scroll = () => {
      setOpen(false);
      setPinned(false);
    };
    window.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("scroll", scroll, true);
    };
  }, []);
  if (omitted) return null;
  const label = `模板：${card.name} · ${card.version === null ? "版本未记录" : `v${card.version}`}`;
  return (
    <span
      className="marker-wrap"
      ref={ref}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => {
        if (!pinned && !ref.current?.contains(document.activeElement))
          setOpen(false);
      }}
    >
      <button
        className="template-marker"
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          setOpen(false);
          setPinned(false);
        }}
        onClick={() => {
          setPinned(!pinned);
          setOpen(!pinned);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setOpen(false);
            setPinned(false);
            e.stopPropagation();
          }
        }}
      >
        <span className="marker-ink">
          <Glyph type={card.template} />
        </span>
      </button>
      {open && <Tip anchor={ref} id={id} label={label} />}
    </span>
  );
}
const display = {
  number: true,
  progress: true,
  roles: false,
  next: false,
  updated: false,
  waiting: true,
  reason: false,
};
function Tile({ card }) {
  return (
    <div className="tile-context">
      <BoardCard card={card} projectId="design-fixture" display={display} />
      <div className="tile-marker">
        <Marker card={card} />
      </div>
    </div>
  );
}
function Board() {
  const groups = [
    ["进行中", [0, 3, 8]],
    ["审核中", [2, 5]],
    ["待合并", [4]],
    ["其他", [1, 6, 7, 9]],
  ];
  return (
    <div className="design-board" tabIndex={0} aria-label="看板横向滚动区域">
      {groups.map(([name, indices]) => (
        <section className="lane" key={name}>
          <h2>
            {name}
            <span>{indices.length}</span>
          </h2>
          {indices.map((i) => (
            <Tile key={i} card={cards[i]} />
          ))}
        </section>
      ))}
    </div>
  );
}
function IdLink({ card }) {
  return (
    <a
      className="number-link"
      href={`?variant=${variant}&view=detail&theme=${theme}&card=${cards.indexOf(card)}`}
    >
      <IdBadge id={card.id} />
    </a>
  );
}
function List() {
  return (
    <div className="list-surface">
      <div className="list-head">
        <span>编号 / 标题</span>
        <span>状态</span>
        <span>进度</span>
      </div>
      {cards.map((card) => (
        <article className="design-row" key={card.id}>
          <div className="row-content">
            <div className="row-ident">
              <IdLink card={card} />
              {variant !== "b" && <Marker card={card} />}
            </div>
            <div className="row-title">
              <PriorityBadge value={card.priority} />
              <a
                href={`?variant=${variant}&view=detail&theme=${theme}&card=${cards.indexOf(card)}`}
              >
                {card.title}
              </a>
            </div>
          </div>
          <StatusTag status={card.status} />
          <span className="row-progress">
            {card.progress.completed}/{card.progress.total}
          </span>
          {variant === "b" && <Marker card={card} />}
        </article>
      ))}
    </div>
  );
}
function Detail() {
  const card = cards[Number(query.get("card") ?? 3)] || cards[3];
  return (
    <article className="detail-surface">
      <div className="detail-identity">
        <IdLink card={card} />
        {variant !== "b" && <Marker card={card} force />}
        <PriorityBadge value={card.priority} />
        <StatusTag status={card.status} />
        {variant === "b" && (
          <div className="detail-corner">
            <Marker card={card} force />
          </div>
        )}
      </div>
      <h2 className="detail-title">{card.title}</h2>
      <div className="detail-facts">
        <span>更新于 11-17 07:00</span>
        {variant === "before" && (
          <span>
            模板：{card.name} · v{card.version}
          </span>
        )}
      </div>
      <nav className="section-tabs">
        <a href="#goal">目标</a>
        <a href="#work">工作项</a>
        <a href="#records">记录</a>
      </nav>
      <section id="goal">
        <h3>目标</h3>
        <p>确认当前版本能正确完成集成验证，并保留可查证的结果。</p>
      </section>
      <section id="work">
        <h3>工作项</h3>
        <div className="work-row">
          <IdBadge id="W-901" />
          <span>开发</span>
          <StatusTag status="in_progress" />
        </div>
        <div className="work-row">
          <IdBadge id="W-902" />
          <span>代码审核</span>
          <StatusTag status="todo" />
        </div>
      </section>
    </article>
  );
}
function Legend() {
  return (
    <section className="legend">
      <h2>看懂卡片 · 模板</h2>
      <p>
        模板标记说明卡片采用哪种流程；不表示优先级、进度或权限。悬停、键盘聚焦或点按标记可读模板名与版本。
      </p>
      <div className="legend-grid">
        {cards.map((c) => (
          <div className="legend-item" key={c.id}>
            <Marker card={c} force />
            <div>
              <strong>{c.name}</strong>
              <p>
                {c.template === "unknown"
                  ? "模板资料缺失时使用通用图标"
                  : c.template === "custom"
                    ? "项目自定义模板使用通用图标"
                    : c.template === "fast_patch"
                      ? "快速补丁流程；实际门禁以当前工作项为准"
                      : c.template === "dev"
                        ? `开发模板 v${c.version}`
                        : "按卡片绑定模板显示"}
              </p>
            </div>
          </div>
        ))}
      </div>
      <p>
        {variant === "b"
          ? "开发卡 v2 在看板与列表省略标记，详情保留；历史 v1 仍显示。"
          : "开发卡也显示标记，所有模板都能在原位置直接读取名称与版本。"}
      </p>
    </section>
  );
}
function App() {
  return (
    <>
      <div className="study-bar">
        <strong>
          C-411 /{" "}
          {variant === "before"
            ? "前稿 · 无模板标记"
            : variant === "a"
              ? "A · 编号旁图标 · 推荐"
              : "B · 右侧角标"}
        </strong>
        <span>设计样例 · 合成 10 卡</span>
        <a
          href={`?variant=${variant === "a" ? "b" : "a"}&view=${view}&theme=${theme}`}
        >
          切换方案
        </a>
        <a
          href={`?variant=${variant}&view=${view}&theme=${theme === "light" ? "dark" : "light"}`}
        >
          切换主题
        </a>
      </div>
      <div className="app-shell">
        <aside>
          <b>Cardigan</b>
          <a
            className="selected"
            href={`?variant=${variant}&view=board&theme=${theme}`}
          >
            卡片
          </a>
          <span>执行视图</span>
          <span>Needs You</span>
          <span>项目动态</span>
          <span>设置</span>
          <a href={`?variant=${variant}&view=legend&theme=${theme}`}>帮助</a>
        </aside>
        <main>
          <header className="study-header">
            <h1>
              {view === "detail"
                ? "卡片详情"
                : view === "legend"
                  ? "帮助"
                  : "卡片"}
              {view === "board" || view === "list" ? (
                <span className="count">10</span>
              ) : null}
            </h1>
            <nav aria-label="设计视图">
              {[
                ["board", "看板"],
                ["list", "列表"],
                ["detail", "详情"],
              ].map(([key, label]) => (
                <a
                  key={key}
                  aria-current={view === key ? "page" : undefined}
                  href={`?variant=${variant}&view=${key}&theme=${theme}`}
                >
                  {label}
                </a>
              ))}
            </nav>
          </header>
          {view === "board" ? (
            <Board />
          ) : view === "list" ? (
            <List />
          ) : view === "detail" ? (
            <Detail />
          ) : (
            <Legend />
          )}
        </main>
      </div>
    </>
  );
}
createRoot(document.getElementById("root")).render(<App />);
