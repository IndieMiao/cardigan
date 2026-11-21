import { expect, test } from "vitest";
import { layoutDependencyGraph } from "./dependency-graph.js";
import { type StoryProgress, storyGraph } from "./story-graph.js";

const progress = (
  ...children: [string, StoryProgress["children"][number]["status"]][]
): StoryProgress => ({
  children: children.map(([id, status]) => ({
    id,
    title: `子卡 ${id}`,
    status,
  })),
  counts: {
    backlog: 0,
    todo: 0,
    in_progress: 0,
    review: 0,
    awaiting_merge: 0,
    done: 0,
    cancelled: 0,
  },
  finished: 0,
  total: children.length,
});
const story = { id: "C-1", title: "需求", status: "in_progress" as const };
const dep = (id: string) => ({
  id,
  title: id,
  status: "todo",
  satisfied: false,
});

test("parent links to the children that start a chain, dependencies only between siblings", () => {
  const { graph, isParentEdge, before, after } = storyGraph(
    story,
    progress(["C-2", "done"], ["C-3", "todo"], ["C-4", "cancelled"]),
    [
      // C-3 waits on its sibling C-2 and on C-9 outside the story.
      {
        id: "C-3",
        dependency: { predecessors: [dep("C-2"), dep("C-9")], successors: [] },
      },
      // The same link seen from the other end is drawn once.
      { id: "C-2", dependency: { predecessors: [], successors: [dep("C-3")] } },
      { id: "C-4", resolution: "wontdo" },
    ],
  );
  expect(graph.nodes.map((n) => n.id)).toEqual(["C-1", "C-2", "C-3", "C-4"]);
  // C-3 hangs off C-2; only the chain starts link to the story.
  expect(graph.edges).toEqual([
    { from: "C-1", to: "C-2" },
    { from: "C-1", to: "C-4" },
    { from: "C-2", to: "C-3" },
  ]);
  expect(graph.edges.filter(isParentEdge)).toHaveLength(2);
  expect(isParentEdge({ from: "C-2", to: "C-3" })).toBe(false);
  expect(before.get("C-3")).toEqual(["C-2"]);
  expect(after.get("C-2")).toEqual(["C-3"]);
  // A finished child is progress, never 待核; resolutions come from the list.
  expect(graph.nodes[1]).toMatchObject({ status: "done", satisfied: true });
  expect(graph.nodes[3]).toMatchObject({ resolution: "wontdo" });
});

test("without child rows the graph still shows every child under the story", () => {
  const { graph } = storyGraph(
    story,
    progress(["C-2", "todo"], ["C-3", "todo"]),
  );
  expect(graph.edges).toEqual([
    { from: "C-1", to: "C-2" },
    { from: "C-1", to: "C-3" },
  ]);
  const layout = layoutDependencyGraph(graph, story.id);
  expect(layout.nodes.find((n) => n.card.id === "C-1")).toMatchObject({
    column: 0,
    current: true,
  });
  expect(
    layout.nodes.filter((n) => n.column === 1).map((n) => n.card.id),
  ).toEqual(["C-2", "C-3"]);
});

test("a dependent child sits right of its prerequisite with no parent line crossing the graph", () => {
  const { graph } = storyGraph(
    story,
    progress(["C-2", "todo"], ["C-3", "todo"]),
    [{ id: "C-3", dependency: { predecessors: [dep("C-2")], successors: [] } }],
  );
  const layout = layoutDependencyGraph(graph, story.id);
  const column = (id: string) =>
    layout.nodes.find((n) => n.card.id === id)?.column;
  expect([column("C-1"), column("C-2"), column("C-3")]).toEqual([0, 1, 2]);
  expect(layout.edges.every((e) => e.via.length === 0)).toBe(true);
});

test("children in a corrupt cycle with no chain start still link to the story once", () => {
  const { graph, isParentEdge } = storyGraph(
    story,
    progress(["C-2", "todo"], ["C-3", "todo"], ["C-4", "todo"]),
    [
      { id: "C-2", dependency: { predecessors: [dep("C-4")], successors: [] } },
      { id: "C-3", dependency: { predecessors: [dep("C-2")], successors: [] } },
      { id: "C-4", dependency: { predecessors: [dep("C-3")], successors: [] } },
    ],
  );
  expect(graph.edges.filter(isParentEdge)).toEqual([
    { from: "C-1", to: "C-2" },
  ]);
  expect(layoutDependencyGraph(graph, story.id).nodes).toHaveLength(4);
});

test("an empty story is just the story", () => {
  const { graph } = storyGraph(story, progress());
  expect(graph.nodes).toHaveLength(1);
  expect(graph.edges).toEqual([]);
});
