// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./App.js";
import {
  type CardiganClient,
  HttpCardiganClient,
  type NeedsDecision,
  type NeedsPage,
  type RunView,
} from "./api.js";
import { CommentBox } from "./components/CommentBox.js";
import { type StreamFactory, subscribeProject } from "./stream.js";
import { fakeClient, loggedIn, project } from "./testing/fixtures.js";
import { ActivityPage } from "./views/ActivityPage.js";
import { ExecutionPage } from "./views/ExecutionPage.js";
import { NeedsYouPage } from "./views/NeedsYouPage.js";

/**
 * M5.T2 cross-acceptance for M5.4 (plan phase-1-m5 §3.6, §8.2, §8.5, §8.6, M5.4).
 *
 * Oracles: the M5 plan, development plan §8.2/§8.5/§8.6 and §14. The Workbench
 * is rendered as the browser would run it: the real `HttpCardiganClient` against
 * an intercepted `fetch`, so the tests assert the requests the UI actually makes.
 */

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.location.hash = "";
});

const NOW = "2026-01-01T00:00:00.000Z";
const decision = (overrides: Partial<NeedsDecision> = {}): NeedsDecision => ({
  id: "q(1)",
  card_id: "C-1",
  affected_cards: ["C-1"],
  question: "要发布吗？",
  context: "发布前的背景",
  why: "等待发布确认",
  status: "open",
  blocking: true,
  decider: "human",
  options: [
    { key: "merge", description: "合并", impact: "更新基线" },
    { key: "hold", description: "暂缓", impact: "保留工作树" },
  ],
  recommended: "merge",
  waited_ms: 120_000,
  trigger: null,
  category: "general",
  assignment_id: null,
  related_cards: [{ id: "C-1", title: "发布卡" }],
  merge_confirmation: null,
  ...overrides,
});
const action = {
  id: "h(1)",
  card_id: "C-1",
  why: "需要连接设备",
  instructions: "连接后运行 **检查**。",
  expected_return: "连接结果",
  due: null,
  waited_ms: 300_000,
  blocked_work_items: [],
};
const page = (overrides: Partial<NeedsPage> = {}): NeedsPage => ({
  decisions: [decision()],
  human_actions: [action],
  incidents: [],
  ...overrides,
});

/** Record the requests a component makes and answer them from one handler. */
function http(answer: (path: string, init?: RequestInit) => unknown) {
  const calls: { path: string; init?: RequestInit }[] = [];
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      calls.push({ path, init });
      return new Response(JSON.stringify(answer(path, init)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  );
  return {
    client: new HttpCardiganClient(fetcher as unknown as typeof fetch),
    calls,
    posts: () =>
      calls
        .filter((call) => call.init?.method === "POST")
        .map((call) => ({
          path: call.path,
          body: JSON.parse(String(call.init?.body ?? "null")) as unknown,
          headers: call.init?.headers as Record<string, string>,
          credentials: call.init?.credentials,
        })),
  };
}

test("§3.6: 选方案 posts the human's option and exact words to the decision endpoint", async () => {
  const server = http((path) => (path.endsWith("/needs-you") ? page() : {}));
  render(<NeedsYouPage client={server.client} projectId="p-1" />);
  await screen.findByLabelText("q(1) 原话或补充说明");
  fireEvent.click(screen.getAllByRole("radio")[1] as HTMLInputElement);
  fireEvent.change(screen.getByLabelText("q(1) 原话或补充说明"), {
    target: { value: "先别发，等我确认" },
  });
  fireEvent.click(screen.getByRole("button", { name: "按所选拍板" }));
  await waitFor(() => expect(server.posts()).toHaveLength(1));
  expect(server.posts()[0]).toEqual({
    path: "/api/projects/p-1/decisions/q(1)/resolve",
    body: { option: "hold", raw_quote: "先别发，等我确认" },
    headers: { accept: "application/json", "content-type": "application/json" },
    credentials: "same-origin",
  });
  // The list reloads from the server after a successful write.
  await waitFor(() =>
    expect(
      server.calls.filter((call) => call.path.endsWith("/needs-you")),
    ).toHaveLength(2),
  );
});

test("§3.6: 要求补充信息 / 解释后果 post to the decision comment endpoint; empty input sends just the action", async () => {
  const server = http((path) => (path.endsWith("/needs-you") ? page() : {}));
  render(<NeedsYouPage client={server.client} projectId="p-1" />);
  await screen.findByLabelText("q(1) 原话或补充说明");
  fireEvent.click(screen.getByRole("button", { name: "要求补充信息" }));
  await waitFor(() => expect(server.posts()).toHaveLength(1));
  expect(server.posts()[0]).toMatchObject({
    path: "/api/projects/p-1/decisions/q(1)/comments",
    body: { action: "request_information" },
  });
  fireEvent.change(screen.getByLabelText("q(1) 原话或补充说明"), {
    target: { value: "请解释影响" },
  });
  fireEvent.click(screen.getByRole("button", { name: "请 PM 解释" }));
  await waitFor(() => expect(server.posts()).toHaveLength(2));
  expect(server.posts()[1]).toMatchObject({
    path: "/api/projects/p-1/decisions/q(1)/comments",
    body: { action: "explain", body: "请解释影响" },
  });
});

test("§3.6: 完成待你执行的操作 posts the result through the human action endpoint", async () => {
  const server = http((path) => (path.endsWith("/needs-you") ? page() : {}));
  render(<NeedsYouPage client={server.client} projectId="p-1" />);
  const submit = await screen.findByRole("button", { name: "确认已完成" });
  expect((submit as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("h(1) 执行结果"), {
    target: { value: "设备已连接" },
  });
  fireEvent.click(submit);
  await waitFor(() => expect(server.posts()).toHaveLength(1));
  expect(server.posts()[0]).toMatchObject({
    path: "/api/projects/p-1/human-actions/h(1)/complete",
    body: { text: "设备已连接" },
  });
});

test("U4a: incidents, blocking decisions, merge confirmations, other decisions and actions stay in that order", async () => {
  const data = page({
    incidents: [
      {
        id: "A-3",
        role_id: "coder",
        runtime_state: "lost",
        card_id: "C-1",
        disconnected_at: "2026-01-01T00:00:00.000Z",
        lost_at: "2026-01-01T00:05:00.000Z",
        waited_ms: 60_000,
        last_run: {
          id: "R-9",
          assignment_id: "A-3",
          status: "unknown",
          kind: "followup",
          model: "fixture",
          role_version: 1,
          agent_cli_version: "1",
          summary: "等待恢复",
        },
      },
    ],
    decisions: [
      decision({ id: "q(2)", blocking: false, why: "普通拍板" }),
      decision({
        id: "q(3)",
        blocking: false,
        category: "permission",
        why: "权限确认",
      }),
      decision({ id: "q(1)", blocking: true, why: "阻塞拍板" }),
      decision({
        id: "q(4)",
        blocking: true,
        why: "确认合并",
        trigger: "merge_confirmation",
        merge_confirmation: {
          completion: null,
          deliveries: [],
          reviews: [],
          known_gaps: [],
        },
      }),
    ],
  });
  render(
    <NeedsYouPage
      client={fakeClient({ needsYou: async () => data })}
      projectId="p-1"
    />,
  );
  await screen.findByText("失联");
  expect(screen.getByText("A-3").closest(".id-tag")?.textContent).toBe(
    "A-3 coder",
  );
  expect(
    document
      .querySelector('time[datetime="2026-01-01T00:00:00.000Z"]')
      ?.getAttribute("title"),
  ).toContain("GMT");
  expect(screen.getByText("R-9").closest("p")?.textContent).toContain(
    "最近 Run：R-9",
  );
  expect(screen.queryByRole("button", { name: /接管|替换/ })).toBeNull();
  const regions = [
    "运行异常",
    "阻塞拍板",
    "合并确认",
    "其他拍板",
    "待你执行",
  ].map((name) => screen.getByRole("region", { name }));
  const before = (left: Node, right: Node) =>
    Boolean(
      left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
  for (let index = 1; index < regions.length; index += 1)
    expect(before(regions[index - 1] as Node, regions[index] as Node)).toBe(
      true,
    );
  const blocking = within(screen.getByRole("region", { name: "阻塞拍板" }));
  expect(blocking.getByRole("article", { name: "拍板 q(1)" })).toBeTruthy();
  expect(blocking.queryByRole("article", { name: "拍板 q(3)" })).toBeNull();
  const merges = within(screen.getByRole("region", { name: "合并确认" }));
  expect(merges.getByRole("article", { name: "合并确认 q(4)" })).toBeTruthy();
  const other = within(screen.getByRole("region", { name: "其他拍板" }));
  expect(other.getByRole("article", { name: "拍板 q(2)" })).toBeTruthy();
  expect(other.getByRole("article", { name: "拍板 q(3)" })).toBeTruthy();
  expect(
    screen.getByRole("region", { name: "待你执行" }).textContent,
  ).toContain("连接结果");
});

test("§8.2/M5.4: a stream-triggered refresh keeps the human's draft and shows the new item", async () => {
  const first = page({ incidents: [] });
  const second = page({
    decisions: [
      decision({ id: "q(1)" }),
      decision({ id: "q(4)", question: "新出现的拍板？" }),
    ],
  });
  const needsYou = vi
    .fn<CardiganClient["needsYou"]>()
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce(second)
    .mockResolvedValue(second);
  const client = fakeClient({ needsYou });
  const view = render(
    <NeedsYouPage client={client} projectId="p-1" revision={0} />,
  );
  await screen.findByLabelText("q(1) 原话或补充说明");
  fireEvent.change(screen.getByLabelText("q(1) 原话或补充说明"), {
    target: { value: "还没提交的原话" },
  });
  const field = screen.getByLabelText("q(1) 原话或补充说明");
  view.rerender(<NeedsYouPage client={client} projectId="p-1" revision={1} />);
  await screen.findByText(/新出现的拍板/);
  expect(screen.getByLabelText("q(1) 原话或补充说明")).toBe(field);
  expect((field as HTMLTextAreaElement).value).toBe("还没提交的原话");
  expect(needsYou).toHaveBeenCalledTimes(2);
});

class Connection extends EventTarget {
  closed = false;
  constructor(readonly url: string) {
    super();
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data?: unknown) {
    this.dispatchEvent(
      type === "change"
        ? new MessageEvent(type, { data: JSON.stringify(data) })
        : new Event(type),
    );
  }
}

test("§8.6/M5.4: after a reconnect the Needs You view refetches and catches up without losing the draft", async () => {
  window.location.hash = "#/p/p-1/needs-you";
  const connections: Connection[] = [];
  const create: StreamFactory = (url) => {
    const connection = new Connection(url);
    connections.push(connection);
    return connection;
  };
  let data = page({ incidents: [] });
  const needsYou = vi.fn<CardiganClient["needsYou"]>(async () => data);
  const client = fakeClient({
    needsYou,
    projects: async () => [project],
    session: loggedIn,
    subscribe: (id, callbacks) => subscribeProject(id, callbacks, create, 10),
  });
  render(<App client={client} />);
  await screen.findByLabelText("q(1) 原话或补充说明");
  const field = screen.getByLabelText("q(1) 原话或补充说明");
  fireEvent.change(field, { target: { value: "断线前的草稿" } });
  act(() => connections.at(-1)?.emit("open"));
  await waitFor(() =>
    expect(needsYou.mock.calls.length).toBeGreaterThanOrEqual(2),
  );
  // The change that happened while the stream was down is pulled on reconnect.
  data = page({
    incidents: [],
    decisions: [
      decision(),
      decision({ id: "q(7)", question: "断线期间出现的拍板？" }),
    ],
  });
  const previous = connections.at(-1);
  act(() => previous?.emit("error"));
  await waitFor(() => expect(connections.at(-1)).not.toBe(previous));
  expect(
    new URL(
      connections.at(-1)?.url as string,
      "https://workbench.invalid",
    ).searchParams.get("after"),
  ).toBe("project:0");
  act(() => connections.at(-1)?.emit("open"));
  await screen.findByText(/断线期间出现的拍板/);
  expect(screen.getByLabelText("q(1) 原话或补充说明")).toBe(field);
  expect((field as HTMLTextAreaElement).value).toBe("断线前的草稿");
  expect(previous?.closed).toBe(true);
});

test("§3.2/§14: Agent-written decision text stays text and unsafe links never become links", async () => {
  const hostile = page({
    human_actions: [],
    decisions: [
      decision({
        question:
          '<img src=x onerror="alert(1)"> [点我](javascript:alert(1)) 见 C-1',
        context: '<img src=x onerror="alert(1)"> <script>alert(1)</script>',
        why: "恶意原因",
      }),
    ],
  });
  render(
    <NeedsYouPage
      client={fakeClient({ needsYou: async () => hostile })}
      projectId="p-1"
    />,
  );
  await screen.findByLabelText("q(1) 原话或补充说明");
  expect(document.querySelector("img")).toBeNull();
  expect(document.querySelector("script")).toBeNull();
  expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
  expect(document.body.textContent).toContain('<img src=x onerror="alert(1)">');
  expect(document.body.textContent).toContain("<script>alert(1)</script>");
});

test("§8.6: 项目动态 filters, paginates before the cursor, and shows payloads as escaped text", async () => {
  const event = {
    id: "E-3",
    card_id: "C-1",
    seq: 3,
    type: "instruction_issued",
    role: "human",
    created_at: NOW,
    payload: { body: "<script>alert(1)</script>", work_item_id: "W-1" },
    actor: { kind: "human" },
  };
  const server = http((path) =>
    path.includes("before=")
      ? { events: [], next_before: null, counts: { returned: 0, matched: 0 } }
      : {
          events: [event],
          next_before: "2026-01-01T00:00:00.000Z",
          counts: { returned: 1, matched: 2 },
        },
  );
  render(<ActivityPage client={server.client} projectId="p-1" />);
  await screen.findByText(/指令/);
  fireEvent.change(screen.getByLabelText("卡片编号"), {
    target: { value: "C-1" },
  });
  fireEvent.change(screen.getByLabelText("角色"), {
    target: { value: "human" },
  });
  fireEvent.change(screen.getByLabelText("事件类型"), {
    target: { value: "instruction_issued" },
  });
  await waitFor(() =>
    expect(server.calls.at(-1)?.path).toContain(
      "/activity?card_id=C-1&role=human&type=instruction_issued",
    ),
  );
  const details = document.querySelector("details.event-details");
  expect(details?.open).toBe(false);
  expect(details?.querySelector("script")).toBeNull();
  expect(details?.textContent).toContain("<script>alert(1)</script>");
  fireEvent.click(screen.getByRole("button", { name: "更早的事件" }));
  await waitFor(() =>
    expect(server.calls.at(-1)?.path).toContain(
      "before=2026-01-01T00%3A00%3A00.000Z",
    ),
  );
  await screen.findByText("没有符合条件的事件。调整筛选，或等待新的项目动态。");
});

test("§8.5: the execution view offers copyable commands only and hides start when a Run is unfinished", async () => {
  const base = {
    id: "A-1",
    role_id: "coder",
    role_version: 1,
    status: "active",
    runtime_state: "lost",
    machine_id: "local",
    standing_mode: null,
    card_id: "C-1",
    card_status: "in_progress",
    work_item_id: "W-1",
    worktree_path: "/fixture/worktree",
    branch: "agent/C-1/W-1",
    session_ref: "session-1",
    runtime_ref: { terminal_ref: "terminal-1", runtime_machine: "local" },
    last_mcp_activity_at: null,
    cursors: [],
  };
  const run: RunView = {
    id: "R-9",
    assignment_id: "A-1",
    status: "unknown",
    kind: "followup",
    model: "fixture-model",
    role_version: 1,
    agent_cli_version: "1",
    summary: "等待恢复",
  };
  const server = http(() => ({
    assignments: [base],
    runs: [run],
    machines: [],
  }));
  render(<ExecutionPage client={server.client} projectId="p-1" />);
  const row = await screen.findByRole("article", { name: "执行 A-1" });
  expect(row.textContent).toContain("失联");
  expect(
    screen.queryByRole("button", { name: "复制启动或恢复会话" }),
  ).toBeNull();
  expect(screen.getByRole("button", { name: "复制检查异常" })).toBeTruthy();
  expect(
    screen
      .getByRole("link", { name: "处理拍板、清理或失联事项" })
      .getAttribute("href"),
  ).toBe("#/p/p-1/needs-you");
  // Copying is the only action: the UI never runs the command itself.
  const clipboard = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: clipboard },
    configurable: true,
  });
  fireEvent.click(screen.getByRole("button", { name: "复制查看 Diff" }));
  await waitFor(() => expect(clipboard).toHaveBeenCalledTimes(1));
  expect(clipboard).toHaveBeenCalledWith(
    "cardigan worktree diff 'A-1' --project 'p-1'",
  );
  expect(server.calls.every((call) => call.init?.method === "GET")).toBe(true);
});

test("§8.2: a comment with a pasted image posts the entry first and attaches the upload to it", async () => {
  const server = http((path) =>
    path.endsWith("/comments")
      ? { id: "C-1#9", body: "看这个 @A-1", created_at: NOW, project_id: "p-1" }
      : { id: "F-1" },
  );
  const onPosted = vi.fn();
  render(
    <CommentBox
      client={server.client}
      projectId="p-1"
      cardId="C-1"
      onPosted={onPosted}
    />,
  );
  const field = screen.getByLabelText("评论正文");
  fireEvent.change(field, { target: { value: "看这个 @A-1" } });
  const image = new File([new Uint8Array([1, 2, 3])], "shot.png", {
    type: "image/png",
  });
  fireEvent.paste(field, { clipboardData: { files: [image] } });
  await screen.findByText(/已捕获 1 张图片/);
  fireEvent.click(screen.getByRole("button", { name: "发表评论" }));
  await waitFor(() => expect(server.posts()).toHaveLength(2));
  expect(server.posts()[0]).toMatchObject({
    path: "/api/projects/p-1/cards/C-1/comments",
    body: { body: "看这个 @A-1", mentions: ["A-1"] },
  });
  expect(server.posts()[1]).toMatchObject({
    path: "/api/projects/p-1/cards/C-1/attachments",
    body: {
      mime: "image/png",
      kind: "evidence",
      attach_to: { kind: "timeline_entry", id: "C-1#9" },
      file: "AQID",
    },
  });
  await waitFor(() => expect(onPosted).toHaveBeenCalledTimes(1));
});

test("§3.6: the cleanup decision offers the copyable worktree diff command", async () => {
  const cleanup = decision({
    id: "q(5)",
    trigger: "worktree_cleanup",
    category: "data_deletion",
    assignment_id: "A-2",
    blocking: false,
    why: "工作树有未提交改动",
    options: [
      { key: "keep", description: "保留", impact: "保留文件" },
      { key: "force_clean", description: "强制清理", impact: "先备份" },
    ],
    recommended: "keep",
  });
  const server = http(() => ({
    decisions: [decision(), cleanup],
    human_actions: [],
    incidents: [],
  }));
  render(<NeedsYouPage client={server.client} projectId="p-1" />);
  await screen.findByLabelText("q(5) 原话或补充说明");
  const command = "cardigan worktree diff 'A-2' --project 'p-1'";
  expect(screen.getByText(command)).toBeTruthy();
  // The merge confirmation is not a cleanup item and gets no diff command.
  const merge = screen.getByRole("article", { name: "拍板 q(1)" });
  expect(within(merge).queryByText(/worktree diff/u)).toBeNull();
  const clipboard = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: clipboard },
    configurable: true,
  });
  fireEvent.click(screen.getByRole("button", { name: "复制查看 Diff" }));
  await waitFor(() => expect(clipboard).toHaveBeenCalledWith(command));
});
