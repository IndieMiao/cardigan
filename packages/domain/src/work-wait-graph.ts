/**
 * C-851: what a work item waits for, as a graph over two stages.
 *
 * - `done` of a producer means accepted; of a verifier, passed.
 * - `delivery` of a producer means it has delivered (output exists).
 *
 * Edges, each only while the source is unsatisfied:
 * - producer `delivery` → `done` of each `depends_on` while still `todo`
 *   (canStartWork: a producer starts only when its dependencies completed);
 * - producer `done` → its own `delivery`, and → `done` of every required,
 *   uncancelled verifier targeting it (accepted needs them passed);
 * - verifier `done` → its target's `delivery`, and → each `depends_on`: a
 *   producer's `delivery` (it needs that output) or a verifier's `done`.
 *
 * Satisfied or cancelled nodes have no edges, so a cycle is a wait that can
 * never resolve on its own. Pure: callers pass the work items to consider.
 */
export interface WaitItem {
  readonly id: string;
  readonly kind: "produce" | "verify";
  readonly status: string;
  readonly required: boolean;
  readonly depends_on: readonly string[];
  readonly target_work_item_id?: string | undefined;
  readonly assignment_id?: string | undefined;
  readonly title?: string;
  readonly template_key?: string | undefined;
}
export type WaitStage = "done" | "delivery";
export interface WaitNode {
  readonly item: string;
  readonly stage: WaitStage;
}
export interface WaitEdge {
  readonly from: WaitNode;
  readonly to: WaitNode;
  readonly via: "dependency" | "verifier" | "target" | "own_delivery";
}

const nodeKey = (n: WaitNode) => `${n.stage}:${n.item}`;

export function waitSatisfied(item: WaitItem, stage: WaitStage): boolean {
  if (stage === "delivery")
    return (
      item.kind === "produce" &&
      (item.status === "delivered" || item.status === "accepted")
    );
  return item.kind === "produce"
    ? item.status === "accepted"
    : item.status === "passed";
}

export class WaitGraph {
  readonly items: ReadonlyMap<string, WaitItem>;
  private readonly verifiers = new Map<string, WaitItem[]>();
  private readonly cache = new Map<string, readonly WaitEdge[]>();
  constructor(items: Iterable<WaitItem>) {
    const map = new Map<string, WaitItem>();
    for (const item of items) map.set(item.id, item);
    this.items = map;
    for (const item of map.values())
      if (item.kind === "verify" && item.target_work_item_id) {
        const list = this.verifiers.get(item.target_work_item_id) ?? [];
        list.push(item);
        this.verifiers.set(item.target_work_item_id, list);
      }
  }

  /** Nodes of one item: a producer has both stages, a verifier only `done`. */
  nodes(id: string): WaitNode[] {
    const item = this.items.get(id);
    if (!item) return [];
    return item.kind === "produce"
      ? [
          { item: id, stage: "delivery" },
          { item: id, stage: "done" },
        ]
      : [{ item: id, stage: "done" }];
  }

  pending(node: WaitNode): boolean {
    const item = this.items.get(node.item);
    return (
      !!item && item.status !== "cancelled" && !waitSatisfied(item, node.stage)
    );
  }

  edges(from: WaitNode): readonly WaitEdge[] {
    const key = nodeKey(from);
    const hit = this.cache.get(key);
    if (hit) return hit;
    const out: WaitEdge[] = [];
    const item = this.items.get(from.item);
    const push = (to: WaitNode, via: WaitEdge["via"]) => {
      if (this.pending(to)) out.push({ from, to, via });
    };
    if (item && this.pending(from)) {
      const depend = (id: string) => {
        const dependency = this.items.get(id);
        if (!dependency) return;
        push(
          {
            item: id,
            stage:
              item.kind === "verify" && dependency.kind === "produce"
                ? "delivery"
                : "done",
          },
          "dependency",
        );
      };
      if (item.kind === "produce") {
        if (from.stage === "delivery") {
          if (item.status === "todo") item.depends_on.forEach(depend);
        } else {
          push({ item: item.id, stage: "delivery" }, "own_delivery");
          for (const v of this.verifiers.get(item.id) ?? [])
            if (v.required) push({ item: v.id, stage: "done" }, "verifier");
        }
      } else {
        if (
          item.target_work_item_id &&
          this.items.has(item.target_work_item_id)
        )
          push({ item: item.target_work_item_id, stage: "delivery" }, "target");
        item.depends_on.forEach(depend);
      }
    }
    this.cache.set(key, out);
    return out;
  }

  /** Strongly connected components with a cycle (iterative Tarjan). */
  cyclicComponents(): WaitNode[][] {
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: WaitNode[] = [];
    const found: WaitNode[][] = [];
    let counter = 0;
    for (const id of [...this.items.keys()].sort(compareIds))
      for (const root of this.nodes(id)) {
        if (index.has(nodeKey(root))) continue;
        const frames: { node: WaitNode; next: number }[] = [
          { node: root, next: 0 },
        ];
        index.set(nodeKey(root), counter);
        low.set(nodeKey(root), counter++);
        stack.push(root);
        onStack.add(nodeKey(root));
        while (frames.length) {
          const frame = frames[frames.length - 1] as (typeof frames)[number];
          const key = nodeKey(frame.node);
          const edge = this.edges(frame.node)[frame.next++];
          if (edge) {
            const to = nodeKey(edge.to);
            if (!index.has(to)) {
              index.set(to, counter);
              low.set(to, counter++);
              stack.push(edge.to);
              onStack.add(to);
              frames.push({ node: edge.to, next: 0 });
            } else if (onStack.has(to))
              low.set(
                key,
                Math.min(low.get(key) as number, index.get(to) as number),
              );
            continue;
          }
          frames.pop();
          const parent = frames[frames.length - 1];
          if (parent) {
            const p = nodeKey(parent.node);
            low.set(p, Math.min(low.get(p) as number, low.get(key) as number));
          }
          if (low.get(key) !== index.get(key)) continue;
          const component: WaitNode[] = [];
          for (;;) {
            const n = stack.pop() as WaitNode;
            onStack.delete(nodeKey(n));
            component.push(n);
            if (nodeKey(n) === key) break;
          }
          if (
            component.length > 1 ||
            this.edges(frame.node).some((e) => nodeKey(e.to) === key)
          )
            found.push(component);
        }
      }
    return found;
  }

  /** Shortest cycle back to `start` inside `within` (all nodes when omitted). */
  cycleThrough(
    start: WaitNode,
    within?: ReadonlySet<string>,
  ): WaitEdge[] | undefined {
    const target = nodeKey(start);
    const parent = new Map<string, WaitEdge>();
    const queue: WaitNode[] = [start];
    const seen = new Set<string>([target]);
    while (queue.length) {
      const node = queue.shift() as WaitNode;
      for (const edge of this.edges(node)) {
        const to = nodeKey(edge.to);
        if (within && !within.has(to)) continue;
        if (to === target) {
          const path = [edge];
          let at = nodeKey(edge.from);
          while (at !== target) {
            const back = parent.get(at) as WaitEdge;
            path.unshift(back);
            at = nodeKey(back.from);
          }
          return path;
        }
        if (seen.has(to)) continue;
        seen.add(to);
        parent.set(to, edge);
        queue.push(edge.to);
      }
    }
    return undefined;
  }

  /** A cycle passing through any node of `id`, or undefined. */
  cycleOf(id: string): WaitEdge[] | undefined {
    for (const node of this.nodes(id)) {
      const cycle = this.cycleThrough(node);
      if (cycle) return cycle;
    }
    return undefined;
  }
}

/** Every cycle in the graph: the item set (sorted) and one cycle through it. */
export function waitCycles(
  items: Iterable<WaitItem>,
): { readonly work_items: readonly string[]; readonly cycle: WaitEdge[] }[] {
  const graph = new WaitGraph(items);
  return graph.cyclicComponents().flatMap((component) => {
    const within = new Set(component.map(nodeKey));
    const ids = [...new Set(component.map((n) => n.item))].sort(compareIds);
    const start =
      component
        .filter((n) => n.item === ids[0])
        .sort((a, b) => a.stage.localeCompare(b.stage))[0] ?? component[0];
    const cycle = start ? graph.cycleThrough(start, within) : undefined;
    return cycle ? [{ work_items: ids, cycle }] : [];
  });
}

function compareIds(a: string, b: string) {
  const n = (s: string) => Number(s.slice(s.lastIndexOf("-") + 1));
  return n(a) - n(b) || a.localeCompare(b);
}

const doneLabel = (item: WaitItem | undefined) =>
  item?.kind === "verify" ? "passed" : "accepted";

/** One wait in words, e.g. "W-859 等 W-639 accepted"; the internal own-delivery step has none. */
export function describeWaitEdge(
  graph: WaitGraph,
  edge: WaitEdge,
): string | undefined {
  const from = edge.from.item,
    to = edge.to.item;
  if (edge.via === "own_delivery") return undefined;
  if (edge.via === "verifier") return `${from} 等必需验证项 ${to} passed`;
  if (edge.to.stage === "delivery") return `${from} 等 ${to} 产出`;
  return `${from} 等 ${to} ${doneLabel(graph.items.get(to))}`;
}

export function describeWaitCycle(
  graph: WaitGraph,
  cycle: readonly WaitEdge[],
): string {
  return cycle
    .map((e) => describeWaitEdge(graph, e))
    .filter((s): s is string => !!s)
    .join(" → ");
}

/** Items on a cycle in order of first appearance. */
export function waitCycleItems(cycle: readonly WaitEdge[]): string[] {
  return [...new Set(cycle.flatMap((e) => [e.from.item, e.to.item]))];
}

/**
 * What a waiting item is waiting on, depth first: each wait in words, then
 * for an item that waits on nothing pending its current state. A wait that
 * comes back to a node already on the path is marked as a cycle.
 */
export function waitChain(
  graph: WaitGraph,
  start: WaitNode,
  limit = 12,
): { readonly steps: string[]; readonly cyclic: boolean } {
  const steps: string[] = [];
  const visited = new Set<string>();
  const path = new Set<string>();
  let cyclic = false;
  const describeLeaf = (node: WaitNode) => {
    const item = graph.items.get(node.item);
    if (!item) return;
    steps.push(
      `${item.id} 当前 ${item.status}，${item.assignment_id ? `指派 ${item.assignment_id}` : "未指派"}`,
    );
  };
  const visit = (node: WaitNode) => {
    const key = nodeKey(node);
    visited.add(key);
    path.add(key);
    const edges = graph.edges(node);
    if (!edges.length && node !== start) describeLeaf(node);
    for (const edge of edges) {
      if (steps.length >= limit) break;
      const to = nodeKey(edge.to);
      const text = describeWaitEdge(graph, edge);
      if (path.has(to)) {
        cyclic = true;
        if (text) steps.push(`${text}（回到 ${edge.to.item}，成环）`);
        continue;
      }
      if (visited.has(to)) {
        if (text) steps.push(text);
        continue;
      }
      if (text) steps.push(text);
      visit(edge.to);
    }
    path.delete(key);
  };
  visit(start);
  if (steps.length >= limit) {
    steps.length = limit;
    steps.push("……");
  }
  return { steps, cyclic };
}
