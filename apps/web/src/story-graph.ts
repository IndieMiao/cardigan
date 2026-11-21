import type {
  CardListItem,
  CardView,
  DependencyCard,
  DependencyGraph,
} from "./api.js";

export type StoryProgress = NonNullable<CardView["story_progress"]>;

/** Child rows: only the fields the graph reads from the shared card list. */
export type StoryChildRow = Pick<CardListItem, "id" | "resolution"> & {
  readonly dependency?: Pick<
    NonNullable<CardListItem["dependency"]>,
    "predecessors" | "successors"
  >;
};

export interface StoryGraph {
  readonly graph: DependencyGraph;
  /** `from` is the story and `to` one of its children. */
  readonly isParentEdge: (edge: { from: string; to: string }) => boolean;
  /** Prerequisites among the story's own children, by child. */
  readonly before: ReadonlyMap<string, readonly string[]>;
  readonly after: ReadonlyMap<string, readonly string[]>;
}

/**
 * The story and its children in one graph: parent links to the children that
 * start a chain, and the dependencies between children. Links to cards outside the story belong
 * to that child's own dependency graph and are left out here.
 */
export function storyGraph(
  story: Pick<CardView, "id" | "title" | "status" | "resolution">,
  progress: StoryProgress,
  rows: readonly StoryChildRow[] = [],
): StoryGraph {
  const children = [
    ...new Map(
      progress.children
        .filter((child) => child.id !== story.id)
        .map((child) => [child.id, child]),
    ).values(),
  ];
  const ids = new Set(children.map((child) => child.id));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const self: DependencyCard = {
    id: story.id,
    title: story.title,
    status: story.status,
    ...(story.resolution ? { resolution: story.resolution } : {}),
    // The story is no one's prerequisite here: show its real state, never 待核.
    satisfied: story.status === "done",
  };
  const nodes: DependencyCard[] = [
    self,
    ...children.map((child) => {
      const resolution = byId.get(child.id)?.resolution;
      return {
        id: child.id,
        title: child.title,
        status: child.status,
        ...(resolution ? { resolution } : {}),
        // Progress, not a prerequisite check: a finished child is finished.
        satisfied: child.status === "done",
      };
    }),
  ];
  const seen = new Set<string>();
  const dependencies: { from: string; to: string }[] = [];
  const link = (from: string, to: string) => {
    const key = `${from}\u0000${to}`;
    if (from === to || !ids.has(from) || !ids.has(to) || seen.has(key)) return;
    seen.add(key);
    dependencies.push({ from, to });
  };
  for (const child of children) {
    const dependency = byId.get(child.id)?.dependency;
    for (const p of dependency?.predecessors ?? []) link(p.id, child.id);
    for (const s of dependency?.successors ?? []) link(child.id, s.id);
  }
  const before = new Map<string, string[]>(),
    after = new Map<string, string[]>();
  for (const { from, to } of dependencies) {
    before.set(to, [...(before.get(to) ?? []), from]);
    after.set(from, [...(after.get(from) ?? []), to]);
  }
  // The story links to the children that start a chain; the rest hang off
  // those through their dependencies, so no parent line crosses the graph.
  // A child no chain start reaches (a corrupt cycle) gets its own link.
  const reached = new Set<string>();
  const heads = new Set<string>();
  const walk = (start: string) => {
    heads.add(start);
    const queue = [start];
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      if (reached.has(id)) continue;
      reached.add(id);
      queue.push(...(after.get(id) ?? []));
    }
  };
  for (const child of children)
    if (!before.get(child.id)?.length) walk(child.id);
  for (const child of children) if (!reached.has(child.id)) walk(child.id);
  return {
    graph: {
      nodes,
      edges: [
        ...children
          .filter((child) => heads.has(child.id))
          .map((child) => ({ from: story.id, to: child.id })),
        ...dependencies,
      ],
    },
    isParentEdge: (edge) => edge.from === story.id && ids.has(edge.to),
    before,
    after,
  };
}
