import { expect, test } from "vitest";
import type { DependencyCard, DependencyGraph } from "./api.js";
import {
  dependencyGraphOf,
  dependencyStatusLabel,
  layoutDependencyGraph,
} from "./dependency-graph.js";
import { card } from "./testing/fixtures.js";

const node = (
  id: string,
  extra: Partial<DependencyCard> = {},
): DependencyCard => ({
  id,
  title: `title ${id}`,
  status: "todo",
  satisfied: false,
  ...extra,
});
const graph = (
  ids: readonly (string | DependencyCard)[],
  edges: readonly string[],
): DependencyGraph => ({
  nodes: ids.map((id) => (typeof id === "string" ? node(id) : id)),
  edges: edges.map((edge) => {
    const [from = "", to = ""] = edge.split(">");
    return { from, to };
  }),
});
/** column:row per id, the observable placement contract. */
const cells = (g: DependencyGraph, current: string) =>
  Object.fromEntries(
    layoutDependencyGraph(g, current).nodes.map((n) => [
      n.card.id,
      `${n.column}:${n.row}`,
    ]),
  );

test("single chain lays out one row left to right with the current card in place", () => {
  const layout = layoutDependencyGraph(
    graph(["C-1", "C-2", "C-3"], ["C-1>C-2", "C-2>C-3"]),
    "C-2",
  );
  expect(layout).toMatchObject({ columns: 3, rows: 2 });
  expect(
    cells(graph(["C-1", "C-2", "C-3"], ["C-1>C-2", "C-2>C-3"]), "C-2"),
  ).toEqual({ "C-1": "0:0", "C-2": "1:0", "C-3": "2:0" });
  expect(layout.nodes.filter((n) => n.current).map((n) => n.card.id)).toEqual([
    "C-2",
  ]);
});

test("a fork stacks the dependents and centres the single prerequisite", () => {
  expect(
    cells(graph(["C-1", "C-2", "C-3"], ["C-1>C-2", "C-1>C-3"]), "C-1"),
  ).toEqual({ "C-1": "0:1", "C-2": "1:0", "C-3": "1:2" });
});

test("a merge stacks the prerequisites and centres the joined card", () => {
  const layout = layoutDependencyGraph(
    graph(["C-1", "C-2", "C-3"], ["C-1>C-3", "C-2>C-3"]),
    "C-3",
  );
  expect(layout).toMatchObject({ columns: 2, rows: 4 });
  expect(
    cells(graph(["C-1", "C-2", "C-3"], ["C-1>C-3", "C-2>C-3"]), "C-3"),
  ).toEqual({ "C-1": "0:0", "C-2": "0:2", "C-3": "1:1" });
});

test("multi-level chains keep every prerequisite left of its dependents", () => {
  // C-1 → C-2 → C-4 → C-5, plus a shortcut C-1 → C-5 and a late C-3 → C-4.
  const g = graph(
    ["C-1", "C-2", "C-3", "C-4", "C-5"],
    ["C-1>C-2", "C-2>C-4", "C-3>C-4", "C-4>C-5", "C-1>C-5"],
  );
  const layout = layoutDependencyGraph(g, "C-4");
  const column = new Map(layout.nodes.map((n) => [n.card.id, n.column]));
  for (const { from, to } of layout.edges)
    expect(column.get(from)).toBeLessThan(column.get(to) ?? -1);
  // The pure prerequisite C-3 sits beside C-4, not at the far left.
  expect(column.get("C-3")).toBe(1);
  expect(layout.columns).toBe(4);
  expect(layout.edges).toHaveLength(5);
});

test("pulling a lone prerequisite right never leaves an empty column", () => {
  expect(cells(graph(["C-9", "C-1"], ["C-9>C-1"]), "C-1")).toEqual({
    "C-9": "0:0",
    "C-1": "1:0",
  });
});

test("barycentric ordering untangles parallel chains", () => {
  // Input order would cross C-1 → C-4 with C-2 → C-3.
  expect(
    cells(graph(["C-1", "C-2", "C-3", "C-4"], ["C-1>C-4", "C-2>C-3"]), "C-1"),
  ).toEqual({ "C-1": "0:0", "C-2": "0:2", "C-4": "1:0", "C-3": "1:2" });
});

test("a lone prerequisite lines up with its dependent instead of the column centre", () => {
  // C-1 feeds only C-4, the last of three stacked cards in the next column.
  const layout = layoutDependencyGraph(
    graph(
      ["C-1", "C-2", "C-3", "C-4", "C-5"],
      ["C-1>C-4", "C-2>C-5", "C-3>C-5", "C-4>C-5"],
    ),
    "C-5",
  );
  const row = new Map(layout.nodes.map((n) => [n.card.id, n.row]));
  expect(row.get("C-1")).toBe(row.get("C-4"));
  expect(Math.min(...row.values())).toBe(0);
  expect(layout.rows).toBe(Math.max(...row.values()) + 2);
});

test("finished prerequisites are muted; unverified done and the current card are not", () => {
  const layout = layoutDependencyGraph(
    graph(
      [
        node("C-1", { status: "done", satisfied: true }),
        node("C-2", { status: "done", satisfied: false }),
        node("C-3", { status: "cancelled" }),
        node("C-4", { status: "done", resolution: "duplicate" }),
        node("C-5", { status: "done", resolution: "wontdo" }),
        node("C-6", { status: "done", satisfied: true }),
      ],
      ["C-1>C-6", "C-2>C-6", "C-3>C-6", "C-4>C-6", "C-5>C-6"],
    ),
    "C-6",
  );
  expect(
    Object.fromEntries(layout.nodes.map((n) => [n.card.id, n.muted])),
  ).toEqual({
    "C-1": true,
    "C-2": false,
    "C-3": true,
    "C-4": true,
    "C-5": true,
    "C-6": false,
  });
  expect(layout.nodes.find((n) => n.card.id === "C-1")?.column).toBe(0);
});

test("status labels keep 待核, duplicate and wontdo distinctions", () => {
  expect(dependencyStatusLabel(node("C-1", { status: "done" }))).toBe(
    "已完成（待核）",
  );
  expect(
    dependencyStatusLabel(node("C-1", { status: "done", satisfied: true })),
  ).toBe("已完成");
  expect(
    dependencyStatusLabel(
      node("C-1", { status: "done", resolution: "wontdo" }),
    ),
  ).toBe("不做");
  expect(
    dependencyStatusLabel(
      node("C-1", { status: "done", resolution: "duplicate" }),
    ),
  ).toBe("重复");
  expect(
    dependencyStatusLabel(
      node("C-1", { status: "cancelled", resolution: "superseded" }),
    ),
  ).toBe("已取代");
  expect(dependencyStatusLabel(node("C-1", { status: "unknown" }))).toBe(
    "状态未知",
  );
});

test("corrupt cycles, duplicates, self-links and dangling edges do not break layout", () => {
  const layout = layoutDependencyGraph(
    graph(
      ["C-1", "C-2", "C-3", "C-3"],
      ["C-1>C-2", "C-2>C-3", "C-3>C-1", "C-1>C-2", "C-2>C-2", "C-2>C-404"],
    ),
    "C-2",
  );
  expect(layout.nodes.map((n) => n.card.id).sort()).toEqual([
    "C-1",
    "C-2",
    "C-3",
  ]);
  expect(layout.edges).toHaveLength(3);
  expect(layoutDependencyGraph({ nodes: [], edges: [] }, "C-1")).toEqual({
    columns: 0,
    rows: 0,
    nodes: [],
    edges: [],
  });
});

test("older reads without a graph fall back to the direct links", () => {
  expect(dependencyGraphOf(card)).toBeUndefined();
  const direct = dependencyGraphOf({
    ...card,
    dependency: {
      predecessors: [node("C-2")],
      successors: [node("C-3")],
      waiting_on: ["C-2"],
      critical_path_length: 2,
    },
  });
  expect(direct?.nodes.map((n) => n.id)).toEqual(["C-2", card.id, "C-3"]);
  expect(direct?.edges).toEqual([
    { from: "C-2", to: card.id },
    { from: card.id, to: "C-3" },
  ]);
});

/** Every hop spans one column and no waypoint shares a cell with anything. */
function expectClearRoutes(g: DependencyGraph, current: string) {
  const layout = layoutDependencyGraph(g, current);
  const at = new Map(layout.nodes.map((n) => [n.card.id, n]));
  const cellsByColumn = new Map<number, number[]>();
  const occupy = (column: number, row: number) =>
    cellsByColumn.set(column, [...(cellsByColumn.get(column) ?? []), row]);
  for (const n of layout.nodes) occupy(n.column, n.row);
  for (const edge of layout.edges) {
    const from = at.get(edge.from),
      to = at.get(edge.to);
    if (!from || !to) throw new Error(`missing end of ${edge.from}>${edge.to}`);
    const hops = [from, ...edge.via, to].map((p) => p.column);
    for (let i = 1; i < hops.length; i++)
      expect(hops[i]).toBe((hops[i - 1] ?? 0) + 1);
    for (const w of edge.via) occupy(w.column, w.row);
  }
  // Cells span two half-rows; any two in one column must not overlap.
  for (const rows of cellsByColumn.values()) {
    const sorted = [...rows].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++)
      expect((sorted[i] ?? 0) - (sorted[i - 1] ?? 0)).toBeGreaterThanOrEqual(2);
    for (const row of rows) expect(row + 2).toBeLessThanOrEqual(layout.rows);
  }
  return layout;
}

test("a shortcut beside a chain gets its own lane instead of overlapping it", () => {
  // A → B → C plus A → C: the direct edge must stay distinguishable.
  const layout = expectClearRoutes(
    graph(["C-1", "C-2", "C-3"], ["C-1>C-2", "C-2>C-3", "C-1>C-3"]),
    "C-3",
  );
  const shortcut = layout.edges.find((e) => e.from === "C-1" && e.to === "C-3");
  const middle = layout.nodes.find((n) => n.card.id === "C-2");
  expect(shortcut?.via).toHaveLength(1);
  expect(shortcut?.via[0]?.column).toBe(middle?.column);
  expect(shortcut?.via[0]?.row).not.toBe(middle?.row);
  expect(layout.edges.filter((e) => e.via.length === 0)).toHaveLength(2);
});

test("long edges in a wide multi-level graph never pass under another node", () => {
  // The design review's C-490 graph, plus a three-column jump.
  expectClearRoutes(
    graph(
      [
        "C-484",
        "C-485",
        "C-486",
        "C-488",
        "C-489",
        "C-490",
        "C-491",
        "C-492",
        "C-493",
      ],
      [
        "C-484>C-485",
        "C-488>C-485",
        "C-488>C-489",
        "C-484>C-490",
        "C-485>C-490",
        "C-489>C-490",
        "C-486>C-491",
        "C-490>C-491",
        "C-490>C-492",
        "C-492>C-493",
        "C-490>C-493",
        "C-484>C-493",
      ],
    ),
    "C-490",
  );
  expectClearRoutes(
    graph(
      ["C-1", "C-2", "C-3", "C-4", "C-5"],
      ["C-1>C-2", "C-2>C-4", "C-3>C-4", "C-4>C-5", "C-1>C-5"],
    ),
    "C-4",
  );
});
