/** M5.T1: read-model and SSE expectations from M5 §3.3 and development-plan §8. */
import {
  type Assignment,
  assign,
  type Card,
  createCard,
  type Decision,
  type HumanAction,
  postComment,
  queueRun,
  requestDecision,
} from "@cardigan/domain";
import { afterEach, beforeEach, expect, test } from "vitest";
import type {
  ActivityData,
  CardDetail,
  CardPage,
  ExecutionData,
  NeedsPage,
  SnapshotData,
} from "../../../web/src/api.js";
import {
  type M5Cross,
  m5Cross,
  TEST_PASSWORD,
} from "../../test-support/m5-cross.js";

let f: M5Cross;
let streams: Stream[];
beforeEach(async () => {
  f = await m5Cross();
  streams = [];
  expect((await f.password(TEST_PASSWORD)).code).toBe(0);
  expect((await f.login()).status).toBe(200);
});
afterEach(async () => {
  for (const s of streams) await s.close();
  await f?.close();
}, 30_000);
const question = {
  category: "general" as const,
  kind: "choose" as const,
  question: "请选择下一步",
  context: "等待方向",
  options: [{ key: "go", description: "继续", impact: "解除阻塞" }],
  recommended: "go",
  affected_cards: [],
  affected_work_items: [],
  blocking: false,
  decider: "human" as const,
};
async function read<T>(suffix: string): Promise<T> {
  const r = await f.call(f.projectPath(suffix));
  expect(r.status).toBe(200);
  return r.json as T;
}
async function second() {
  const card = f.command((s, a, p) =>
    createCard(
      s,
      a,
      {
        title: "Second card",
        goal: "Independent work",
        acceptance_criteria: ["Second verified"],
        source: { kind: "quote", text: "Build another" },
        repo: "fixture",
        base_branch: "main",
      },
      p,
    ),
  );
  const assignments = f
    .state()
    .work_items.filter((w) => w.card_id === card.id)
    .map((w) =>
      f.command((s, a, p) =>
        assign(s, a, { work_item_id: w.id, role_id: w.role_id }, p),
      ),
    );
  return {
    card,
    owner: assignments[0] as Assignment,
    verifier: assignments[1] as Assignment,
  };
}
async function awaitingMerge() {
  const product = await f.deliver(
    f.primary,
    await f.change(f.primary.owner, "ready.txt", "ready\n"),
  );
  await f.review(f.primary.verifier, product);
  const completion = await f.complete(product);
  return { product, completion };
}

test("R01 §8.1: both board filters identify the actual next human or Agent and preserve all-card counts", async () => {
  await f.start(f.primary.owner);
  const q = await f.mcp<Decision>(f.primary.owner, "request_decision", {
    ...question,
    card_id: f.card.id,
    blocking: true,
    affected_cards: [f.card.id],
    affected_work_items: [f.primary.owner.work_item_id],
  });
  const other = await second();
  await f.start(other.owner);
  const before = f.state().cursors;
  const human = await read<CardPage>("/cards?filter=needs_me"),
    agent = await read<CardPage>("/cards?filter=agent");
  expect(human.cards.map((c) => c.id)).toEqual([f.card.id]);
  expect(agent.cards.map((c) => c.id)).toEqual([other.card.id]);
  expect(human.counts).toEqual({ total: 2, needs_me: 1, agent: 1 });
  expect(agent.counts).toEqual(human.counts);
  expect(human.cards[0]?.waiting_on).toContainEqual(
    expect.objectContaining({ kind: "decision", ref: q.id }),
  );
  expect(human.cards[0]?.next_owners).toContainEqual({
    kind: "human",
    ref: "human",
  });
  expect(agent.cards[0]?.next_owners).toContainEqual({
    kind: "assignment",
    ref: other.owner.id,
  });
  expect(f.state().cursors).toEqual(before);
});

test("R02 §8.4: card detail answers goal, progress, next owner, blocker and final acceptance basis", async () => {
  const { product, completion } = await awaitingMerge(),
    q = f.state().decisions.find((q) => q.trigger === "merge_confirmation");
  const detail = await read<CardDetail>(`/cards/${f.card.id}`);
  expect(detail.card).toMatchObject({
    id: f.card.id,
    goal: f.card.goal,
    acceptance_criteria: f.card.acceptance_criteria,
    status: "awaiting_merge",
  });
  expect(detail.card.next_owners).toContainEqual({
    kind: "human",
    ref: "human",
  });
  expect(detail.card.waiting_on).toContainEqual(
    expect.objectContaining({ ref: q?.id }),
  );
  expect([...detail.card.why].length).toBeLessThanOrEqual(40);
  expect(detail.work_items).toContainEqual(
    expect.objectContaining({
      id: f.pm.work_item_id,
      kind: "verify",
      role_id: "pm",
      required: true,
      status: "passed",
    }),
  );
  for (const d of [product, completion])
    expect(detail.deliveries).toContainEqual(
      expect.objectContaining({
        id: d.id,
        status: "accepted",
        subject: d.subject,
      }),
    );
  for (const [delivery_id, work_item_id] of [
    [product.id, f.primary.verifier.work_item_id],
    [completion.id, f.pm.work_item_id],
  ])
    expect(detail.review_matrix).toContainEqual(
      expect.objectContaining({
        delivery_id,
        work_item_id,
        verdict: "pass",
        target_sha: product.subject.value,
      }),
    );
  expect(detail.timeline.map((e) => e.event_seq)).toEqual(
    detail.timeline.map((e) => e.event_seq).sort((a, b) => b - a),
  );
  expect(
    detail.timeline.some(
      (e) => e.type === "review" && e.author === `assignment:${f.pm.id}`,
    ),
  ).toBe(true);
  expect(detail.relations.decisions).toContainEqual(
    expect.objectContaining({ id: q?.id, status: "open", blocking: true }),
  );
});

test("R03 §8.2: Needs You puts blockers first, truncates reasons and calculates waits from real request times", async () => {
  await f.start(f.primary.owner);
  const ordinary = await f.mcp<Decision>(f.primary.owner, "request_decision", {
    ...question,
    card_id: f.card.id,
    question: "请选择方向。".repeat(15),
  });
  const blocking = await f.mcp<Decision>(f.primary.owner, "request_decision", {
    ...question,
    card_id: f.card.id,
    blocking: true,
    affected_work_items: [f.primary.owner.work_item_id],
  });
  const action = await f.mcp<HumanAction>(
    f.primary.owner,
    "request_human_action",
    {
      card_id: f.card.id,
      instructions: "连接设备并回报结果",
      why_human: "需要实体设备。".repeat(15),
      expected_return: "连接结果",
      blocked_work_items: [],
    },
  );
  const now = Date.now() + 120000;
  f.setTime(now);
  const needs = await read<NeedsPage>("/needs-you");
  expect(needs.decisions.map((q) => q.id)).toEqual([blocking.id, ordinary.id]);
  for (const q of needs.decisions) {
    const opened = f.state().timeline.find((e) => e.decision_id === q.id)
      ?.created_at as string;
    expect(q.waited_ms).toBe(now - Date.parse(opened));
    expect([...q.why].length).toBeGreaterThan(0);
    expect([...q.why].length).toBeLessThanOrEqual(40);
  }
  const h = needs.human_actions.find((h) => h.id === action.id),
    opened = f.state().timeline.find((e) => e.human_action_id === action.id)
      ?.created_at as string;
  expect(h).toMatchObject({
    instructions: action.instructions,
    expected_return: action.expected_return,
    waited_ms: now - Date.parse(opened),
  });
  expect([...(h?.why ?? "")].length).toBeLessThanOrEqual(40);
});

test("R04 §8.3: snapshot separates waiting actors, review and progress, and includes actual recent deliveries", async () => {
  const { product, completion } = await awaitingMerge(),
    other = await second();
  await f.start(other.owner);
  const view = await read<SnapshotData>("/snapshot");
  expect(view.in_review.map((c) => c.id)).toEqual([f.card.id]);
  expect(view.in_progress.map((c) => c.id)).toEqual([other.card.id]);
  expect(view.waiting).toEqual({ human: [f.card.id], agent: [other.card.id] });
  expect(view.recent_deliveries.map((d) => d.id)).toEqual([
    completion.id,
    product.id,
  ]);
  expect(
    view.cards.find((c) => c.id === other.card.id)?.next_owners,
  ).toContainEqual({ kind: "assignment", ref: other.owner.id });
  await f.mcp(other.owner, "report_blocker", {
    work_item_id: other.owner.work_item_id,
    reason: "Waiting for a specialist",
    needs: "role",
  });
  expect((await read<SnapshotData>("/snapshot")).blocked).toContainEqual(
    expect.objectContaining({
      card_id: other.card.id,
      work_item_id: other.owner.work_item_id,
    }),
  );
});

test("R05 §8.5: execution exposes real launch metadata and ACK without leaking credentials or changing cursors", async () => {
  await f.start(f.primary.owner);
  await f.agentComment("Execution evidence");
  await f.finish(f.primary.owner);
  const state = f.state(),
    a = f.current(f.primary.owner),
    r = state.runs.find((r) => r.assignment_id === a.id);
  const view = await read<ExecutionData>("/execution"),
    record = view.assignments.find((x) => x.id === a.id);
  expect(record).toMatchObject({
    id: a.id,
    work_item_id: a.work_item_id,
    role_version: a.role_version,
    machine_id: a.machine_id,
    worktree_path: a.worktree_path,
    branch: a.branch,
    runtime_ref: a.runtime_ref,
  });
  expect(record?.cursors).toEqual(
    state.cursors
      .filter((c) => c.assignment_id === a.id)
      .map((c) => ({ card_id: c.card_id, acked_seq: c.acked_seq })),
  );
  expect(view.runs).toContainEqual(
    expect.objectContaining({
      id: r?.id,
      model: r?.model,
      agent_cli_version: r?.agent_cli_version,
    }),
  );
  expect(JSON.stringify(view)).not.toContain(f.token(a));
  expect(f.state().cursors).toEqual(state.cursors);
});

test("R06 §8.5: a newly queued Run is the latest even before it has a started_at", async () => {
  await f.start(f.primary.owner);
  await f.finish(f.primary.owner);
  const queued = f.command((s, a, p) =>
    queueRun(
      s,
      a,
      {
        assignment_id: f.primary.owner.id,
        model: "next-model",
        agent_cli_version: "next-cli",
      },
      p,
    ),
  );
  expect(queued.status).toBe("queued");
  expect(queued.started_at).toBeUndefined();
  const view = await read<
    Omit<ExecutionData, "assignments"> & {
      assignments: {
        id: string;
        run: { id: string; status: string; kind: string } | null;
      }[];
    }
  >("/execution");
  expect(
    view.assignments.find((a) => a.id === f.primary.owner.id)?.run,
  ).toMatchObject({ id: queued.id, status: "queued" });
});

test("R07 §8.6: activity filters card/role/type and paginates older events without repeating the boundary", async () => {
  const other = await second();
  const first = await f.agentComment("first"),
    last = await f.agentComment("second");
  await f.start(other.owner);
  await f.mcp(other.owner, "post_comment", {
    card_id: other.card.id,
    body: "coder on another card",
  });
  const human = f.command((s, a, p) =>
    postComment(
      s,
      a,
      { card_id: other.card.id, body: "human on another card" },
      p,
    ),
  );
  const eventId = (card: Card["id"], seq: number) =>
    f.state().events.find((e) => e.card_id === card && e.seq === seq)?.id;
  const filter = `/activity?card_id=${f.card.id}&role=coder&type=comment_posted&limit=1`;
  const page = await read<ActivityData>(filter);
  expect(page.events.map((e) => e.id)).toEqual([
    eventId(f.card.id, last.event_seq),
  ]);
  expect(page.counts).toEqual({ returned: 1, matched: 2 });
  const older = await read<ActivityData>(
    `${filter}&before=${page.next_before}`,
  );
  expect(older.events.map((e) => e.id)).toEqual([
    eventId(f.card.id, first.event_seq),
  ]);
  expect(older.next_before).toBeNull();
  const byHuman = await read<ActivityData>(
    "/activity?role=human&type=comment_posted",
  );
  expect(byHuman.events.map((e) => e.id)).toEqual([
    eventId(other.card.id, human?.event_seq as number),
  ]);
});

interface Change {
  id: string;
  stream: string;
  seq: number;
  type: string;
}
interface Stream {
  readonly received: Change[];
  close(): Promise<void>;
}
async function openStream(after?: string): Promise<Stream> {
  const controller = new AbortController(),
    received: Change[] = [];
  const response = await fetch(
    f.web.url +
      f.projectPath(
        `/stream${after === undefined ? "" : `?after=${encodeURIComponent(after)}`}`,
      ),
    {
      headers: { cookie: f.cookie(), "last-event-id": "ignored:999999" },
      signal: controller.signal,
    },
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing SSE body");
  let failure: unknown;
  const pump = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      while (buffer.includes("\n\n")) {
        const at = buffer.indexOf("\n\n");
        const frame = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (frame.startsWith("event: change\n")) {
          const raw = frame
            .split("\n")
            .find((line) => line.startsWith("data: "))
            ?.slice(6);
          if (raw) received.push(JSON.parse(raw) as Change);
        }
      }
    }
  })().catch((error) => {
    if (!controller.signal.aborted) failure = error;
  });
  const stream = {
    received,
    close: async () => {
      controller.abort();
      await pump;
      if (failure) throw failure;
    },
  };
  streams.push(stream);
  return stream;
}
const waitForIds = async (stream: Stream, ids: readonly string[]) =>
  expect
    .poll(() => ids.every((id) => stream.received.some((e) => e.id === id)), {
      timeout: 3000,
      interval: 15,
    })
    .toBe(true);
const quiet = () => new Promise((resolve) => setTimeout(resolve, 70));

test("R08 §3.3: SSE replays each stream independently, discovers new streams, deduplicates and never ACKs", async () => {
  const other = await second();
  await f.agentComment("initial");
  f.command((s, a, p) =>
    postComment(s, a, { card_id: other.card.id, body: "second stream" }, p),
  );
  f.command((s, a, p) => requestDecision(s, a, question, p));
  const last = f
    .state()
    .events.filter((e) => e.card_id === f.card.id)
    .at(-1)?.seq as number;
  await f.mcp(f.primary.owner, "ack_events", {
    card_id: f.card.id,
    up_to_seq: last,
  });
  const before = f.state(),
    first = await openStream("project:0");
  await waitForIds(
    first,
    before.events.map((e) => e.id),
  );
  await quiet();
  expect(new Set(first.received.map((e) => `${e.stream}:${e.seq}`)).size).toBe(
    first.received.length,
  );
  const cursors = new Map<string, number>();
  for (const e of first.received)
    cursors.set(e.stream, Math.max(cursors.get(e.stream) ?? 0, e.seq));
  await first.close();
  await f.agentComment("after disconnect");
  f.command((s, a, p) =>
    postComment(
      s,
      a,
      { card_id: other.card.id, body: "other stream while disconnected" },
      p,
    ),
  );
  f.command((s, a, p) =>
    requestDecision(s, a, { ...question, question: "New project decision" }, p),
  );
  await second();
  const ids = new Set(before.events.map((e) => e.id)),
    missed = f.state().events.filter((e) => !ids.has(e.id));
  const resumed = await openStream(
    [...cursors].map(([s, n]) => `${s}:${n}`).join(","),
  );
  await waitForIds(
    resumed,
    missed.map((e) => e.id),
  );
  await quiet();
  expect(resumed.received.map((e) => e.id).sort()).toEqual(
    missed.map((e) => e.id).sort(),
  );
  for (const stream of new Set(resumed.received.map((e) => e.stream))) {
    const seqs = resumed.received
      .filter((e) => e.stream === stream)
      .map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  }
  expect(f.state().cursors).toEqual(before.cursors);
});

test("R09 §3.3: a new stream without after starts at now and emits subsequent changes", async () => {
  const before = new Set<string>(f.state().events.map((e) => e.id)),
    stream = await openStream();
  await quiet();
  expect(stream.received).toEqual([]);
  const comment = await f.agentComment("new event"),
    event = f
      .state()
      .events.find(
        (e) => e.card_id === f.card.id && e.seq === comment.event_seq,
      );
  await waitForIds(stream, [event?.id as string]);
  expect(stream.received.some((e) => before.has(e.id))).toBe(false);
});

test("R10 §8.1: project reads isolate card numbers and return empty collections for a new project", async () => {
  await f.cli("project", "create", "empty-project");
  const projects = await f.call("/api/projects");
  expect(projects.status).toBe(200);
  expect(
    (projects.json as { projects: { id: string }[] }).projects
      .map((p) => p.id)
      .sort(),
  ).toEqual([f.project.project_id, "empty-project"].sort());
  const empty = await f.call("/api/projects/empty-project/cards");
  expect(empty.json).toMatchObject({
    cards: [],
    counts: { total: 0, needs_me: 0, agent: 0 },
  });
  expect(
    (await f.call(`/api/projects/empty-project/cards/${f.card.id}`)).status,
  ).toBe(404);
  expect((await f.call(f.projectPath("/cards/C-999999"))).status).toBe(404);
  const snapshot = await f.call("/api/projects/empty-project/snapshot");
  expect(snapshot.json).toMatchObject({
    cards: [],
    in_progress: [],
    in_review: [],
    blocked: [],
    recent_deliveries: [],
  });
});

test.each([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/svg+xml",
  "text/html",
])(
  "R11 §3.2: downloaded %s preserves bytes, is scoped and only bitmap MIME types are inline",
  async (mime) => {
    const body = "Attachment bytes with <script>untrusted()</script>",
      attachment = await f.attachment(mime, body),
      detail = await read<CardDetail>(`/cards/${f.card.id}`),
      metadata = detail.attachments.find((a) => a.id === attachment.id);
    const inline = !["image/svg+xml", "text/html"].includes(mime);
    expect(metadata).toMatchObject({
      mime,
      size: Buffer.byteLength(body),
      sha256: attachment.sha256,
      inline,
    });
    const path = metadata?.download_path as string,
      downloaded = await f.call(path);
    expect(downloaded.status).toBe(200);
    expect(downloaded.text).toBe(body);
    expect(downloaded.headers["content-type"]).toBe(mime);
    expect(downloaded.headers["content-disposition"]).toMatch(
      inline ? /^inline;/ : /^attachment;/,
    );
    expect(downloaded.headers["x-content-type-options"]).toBe("nosniff");
    if (!inline)
      expect(downloaded.headers["content-security-policy"]).toContain(
        "sandbox",
      );
    expect((await f.call(path, { anonymous: true })).status).toBe(401);
    await f.cli("project", "create", "attachment-other");
    expect(
      (
        await f.call(
          `/api/projects/attachment-other/attachments/${attachment.id}`,
        )
      ).status,
    ).toBe(404);
  },
);
