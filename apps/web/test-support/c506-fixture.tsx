import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import type {
  CardListItem,
  CardStatus,
  DependencyCard,
  DependencyGraph,
} from "../src/api.js";
import { card, cardDetail, fakeClient, NOW } from "../src/testing/fixtures.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/components/ui/theme.css";

// C-506: synthetic dependency graphs only; no network client or database.
// C-454 a 9-card fork/merge graph, C-470 a 15-card chain wider than the view,
// C-480 30 side-by-side prerequisites, taller than the view, C-490 a pair
// that fits.
// Popover reads answer from the same synthetic set: one employee, fixed time.
Date.now = () => new Date(NOW).getTime();
const titles: Record<string, string> = {
  "C-449": "旧版启动配置（重复）",
  "C-450": "启动配置 LP-0：调研",
  "C-451": "启动配置 LP-1b：模型目录",
  "C-452": "启动配置 LP-1：配置文件格式",
  "C-453": "启动配置 LP-2：热加载、launch check / set-model 命令与引用校验",
  "C-454":
    "启动配置 LP-3：HarnessAdapter 重构（单一 harness 枚举 + 适配器接口）",
  "C-455": "启动配置 LP-4：Workbench 设置页",
  "C-456": "启动配置 LP-5：迁移旧角色",
  "C-457": "启动配置 LP-6：上线与清理",
};
const status: Record<string, CardStatus> = {
  "C-449": "done",
  "C-450": "done",
  "C-451": "in_progress",
  "C-452": "done",
  "C-453": "awaiting_merge",
  "C-454": "backlog",
  "C-455": "backlog",
  "C-456": "todo",
  "C-457": "todo",
};
const node = (id: string, extra: Partial<DependencyCard> = {}) => ({
  id,
  title: titles[id] ?? `长链第 ${Number(id.slice(2)) - 460} 张`,
  status: status[id] ?? (Number(id.slice(2)) < 470 ? "done" : "todo"),
  // Only a finished card meets a dependency; the long chain is done below 470.
  satisfied: status[id] ? status[id] === "done" : Number(id.slice(2)) < 470,
  ...extra,
});
const edges = (...pairs: string[]) =>
  pairs.map((pair) => {
    const [from = "", to = ""] = pair.split(">");
    return { from, to };
  });
const chain = Array.from({ length: 15 }, (_, i) => `C-${461 + i}`);
const side = Array.from({ length: 30 }, (_, i) => `C-${500 + i}`);
const graphs: Record<
  string,
  { graph: DependencyGraph; waiting_on: string[]; critical_path_length: number }
> = {
  "C-454": {
    graph: {
      nodes: [
        node("C-449", { resolution: "duplicate", satisfied: false }),
        node("C-450"),
        node("C-451"),
        node("C-452", { satisfied: false }),
        node("C-453"),
        node("C-454"),
        node("C-455"),
        node("C-456"),
        node("C-457"),
      ],
      edges: edges(
        "C-450>C-452",
        "C-451>C-453",
        "C-452>C-453",
        "C-449>C-453",
        "C-453>C-454",
        "C-454>C-455",
        "C-454>C-456",
        "C-455>C-457",
        "C-456>C-457",
      ),
    },
    waiting_on: ["C-453"],
    critical_path_length: 5,
  },
  "C-470": {
    graph: {
      nodes: chain.map((id) => node(id)),
      edges: edges(...chain.slice(1).map((id, i) => `${chain[i]}>${id}`)),
    },
    waiting_on: ["C-469"],
    critical_path_length: 6,
  },
  "C-480": {
    graph: {
      nodes: [
        ...side.map((id, i) => node(id, { title: `并排前置 ${i + 1}` })),
        node("C-480", { title: "汇总 30 张并排前置" }),
      ],
      edges: edges(...side.map((id) => `${id}>C-480`)),
    },
    waiting_on: side,
    critical_path_length: 2,
  },
  "C-490": {
    graph: {
      nodes: [
        node("C-489", { title: "短链前置" }),
        node("C-490", { title: "短链当前" }),
      ],
      edges: edges("C-489>C-490"),
    },
    waiting_on: ["C-489"],
    critical_path_length: 2,
  },
};
const cards = Object.keys(graphs).map((id) => {
  const self = graphs[id]?.graph.nodes.find((n) => n.id === id);
  return {
    ...card,
    id,
    title: self?.title ?? id,
    status: (self?.status ?? "todo") as CardStatus,
    waiting_on: [],
    why: "等待下一步处理",
  };
});
const known = new Map(
  Object.values(graphs).flatMap(({ graph }) =>
    graph.nodes.map((n) => [n.id, n]),
  ),
);
const employee = {
  employee: {
    id: "E-7",
    name: "林黛玉",
    title: "后端工程师",
    avatar: null,
    role_id: "coder",
  },
};
/** The list summary a node's popover reads; deterministic per id. */
const summary = (id: string): CardListItem => {
  const n = known.get(id);
  const open = !["done", "cancelled"].includes(n?.status ?? "todo");
  return {
    ...card,
    id,
    title: n?.title ?? id,
    status: (n?.status ?? "todo") as CardStatus,
    priority: Number(id.slice(2)) % 5,
    updated_at: "2025-12-31T08:30:00.000Z",
    waiting_on: [],
    why: "",
    next_owners:
      open && n?.status !== "backlog"
        ? [{ kind: "assignment", ref: "A-7", ...employee }]
        : [],
    produce_owners: open && n?.status !== "backlog" ? [employee] : [],
    work_items: open
      ? [
          { id: `W-${id.slice(2)}1`, title: "后端开发", status: "in_progress" },
          {
            id: `W-${id.slice(2)}2`,
            title: "代码审核",
            status: n?.status === "awaiting_merge" ? "in_progress" : "todo",
          },
        ]
      : [{ id: `W-${id.slice(2)}1`, title: "后端开发", status: "accepted" }],
  };
};
const client = fakeClient({
  subscribe: (_project, callbacks) => {
    callbacks.status("live");
    return () => {};
  },
  cards: async (_project, filter, options = {}) => {
    const ids = options.ids?.split(",");
    const rows = ids ? ids.map(summary) : cards;
    return {
      project_id: "p-1",
      filter,
      cards: rows,
      counts: { total: rows.length, needs_me: 0, agent: rows.length },
    };
  },
  card: async (_project, id) => {
    const selected = cards.find((c) => c.id === id) ?? cards[0];
    const entry = graphs[selected?.id ?? ""];
    if (!selected || !entry) throw new Error("fixture");
    const { graph } = entry;
    return cardDetail({
      attachments: [],
      card: {
        ...selected,
        dependency: {
          predecessors: graph.edges
            .filter((e) => e.to === selected.id)
            .flatMap((e) => graph.nodes.filter((n) => n.id === e.from)),
          successors: graph.edges
            .filter((e) => e.from === selected.id)
            .flatMap((e) => graph.nodes.filter((n) => n.id === e.to)),
          waiting_on: entry.waiting_on,
          critical_path_length: entry.critical_path_length,
          graph,
        },
      },
    });
  },
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(<App client={client} />);
