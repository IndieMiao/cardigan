// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./App.js";
import {
  type CardiganClient,
  HttpCardiganClient,
  type PostedComment,
} from "./api.js";
import { type StreamFactory, subscribeProject } from "./stream.js";
import { card, cardDetail, fakeClient, project } from "./testing/fixtures.js";

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
function pool() {
  const all: Connection[] = [];
  const create: StreamFactory = (url) => {
    const c = new Connection(url);
    all.push(c);
    return c;
  };
  return {
    all,
    create,
    get last() {
      const c = all.at(-1);
      if (!c) throw new Error("No stream");
      return c;
    },
  };
}
const change = (stream: string, seq: number) => ({
  stream,
  seq,
  type: "updated",
});
const callbacks = () => ({ change: vi.fn(), ready: vi.fn(), status: vi.fn() });
function live(overrides: Partial<CardiganClient> = {}) {
  const connections = pool();
  return {
    connections,
    client: fakeClient({
      ...overrides,
      subscribe: (id, c) => subscribeProject(id, c, connections.create, 10),
    }),
  };
}
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 140));
  });
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.location.hash = "";
});

test("stream resumes every observed cursor, ignores duplicates/stale sources, and cancels reconnects", () => {
  vi.useFakeTimers();
  const p = pool(),
    c = callbacks();
  const client = new HttpCardiganClient(vi.fn(), p.create),
    stop = client.subscribe("p/a", c);
  expect(p.last.url).toBe("/api/projects/p%2Fa/stream");
  const first = p.last;
  first.emit("open");
  for (const event of [
    change("C-1", 5),
    change("C-2", 2),
    change("project", 4),
    change("C-1", 5),
    change("C-1", 3),
  ])
    first.emit("change", event);
  expect(c.change).toHaveBeenCalledTimes(3);
  first.emit("error");
  expect(first.closed).toBe(true);
  vi.advanceTimersByTime(3000);
  expect(
    new URL(p.last.url, "https://workbench.invalid").searchParams.get("after"),
  ).toBe("C-1:5,C-2:2,project:4");
  first.emit("change", change("C-1", 100));
  expect(c.change).toHaveBeenCalledTimes(3);
  p.last.emit("open");
  p.last.emit("change", change("C-1", 6));
  expect(c.change).toHaveBeenCalledTimes(4);
  // Only the first open re-reads; the resumed one relies on the replay.
  expect(c.ready).toHaveBeenCalledTimes(1);
  p.last.emit("error");
  stop();
  vi.advanceTimersByTime(10000);
  expect(p.all).toHaveLength(2);
});

test("a server shutdown frame drops the connection and resumes on the next server with the same cursors", () => {
  vi.useFakeTimers();
  const p = pool(),
    c = callbacks(),
    stop = subscribeProject("p-1", c, p.create);
  const first = p.last;
  first.emit("open");
  first.emit("change", change("C-3", 9));
  first.emit("change", change("project", 2));
  first.emit("shutdown");
  expect(first.closed).toBe(true);
  expect(c.status).toHaveBeenLastCalledWith("retrying");
  // The next server is not up yet: keep retrying, no page reload needed.
  vi.advanceTimersByTime(3000);
  const second = p.last;
  expect(second).not.toBe(first);
  second.emit("error");
  vi.advanceTimersByTime(3000);
  const third = p.last;
  expect(third).not.toBe(second);
  expect(
    new URL(third.url, "https://workbench.invalid").searchParams.get("after"),
  ).toBe("C-3:9,project:2");
  // A late frame from the old connection is ignored.
  first.emit("shutdown");
  expect(p.all).toHaveLength(3);
  third.emit("open");
  expect(c.status).toHaveBeenLastCalledWith("live");
  expect(c.ready).toHaveBeenCalledTimes(1);
  stop();
});

test("a disconnect before any event reconnects from zero; malformed changes cannot advance a cursor", () => {
  vi.useFakeTimers();
  const p = pool(),
    c = callbacks(),
    stop = subscribeProject("p-1", c, p.create);
  for (const bad of [
    null,
    {},
    change("__proto__", 1),
    change("C-1", -1),
    change("C-1", 1.5),
    change("C-1", Number.MAX_SAFE_INTEGER + 1),
  ])
    p.last.emit("change", bad);
  p.last.dispatchEvent(new MessageEvent("change", { data: "{" }));
  expect(c.change).not.toHaveBeenCalled();
  p.last.emit("error");
  vi.advanceTimersByTime(3000);
  expect(
    new URL(p.last.url, "https://workbench.invalid").searchParams.get("after"),
  ).toBe("project:0");
  stop();
});

test("StrictMode reconnect catches missed UI changes and coalesces a burst into one refresh", async () => {
  window.location.hash = "#/p/p-1/cards";
  let title = "初始数据";
  const cards = vi
    .fn<CardiganClient["cards"]>()
    .mockImplementation(async (id, filter) => ({
      project_id: id,
      filter,
      cards: [{ ...card, title }],
      counts: { total: 1, needs_me: 1, agent: 0 },
    }));
  const { client, connections } = live({ cards });
  render(
    <StrictMode>
      <App client={client} />
    </StrictMode>,
  );
  await screen.findByText("初始数据");
  expect(connections.all.filter((c) => !c.closed)).toHaveLength(1);
  title = "建连窗口里的变化";
  act(() => connections.last.emit("open"));
  await screen.findByText(title);
  const before = cards.mock.calls.length;
  title = "一批事件后的数据";
  act(() => {
    for (const e of [change("C-1", 10), change("C-2", 7), change("project", 4)])
      connections.last.emit("change", e);
  });
  await screen.findByText(title);
  expect(cards).toHaveBeenCalledTimes(before + 1);
  const old = connections.last;
  act(() => old.emit("error"));
  title = "断线期间的变化";
  await waitFor(() => expect(connections.last).not.toBe(old));
  expect(
    new URL(connections.last.url, "https://workbench.invalid").searchParams.get(
      "after",
    ),
  ).toBe("C-1:10,C-2:7,project:4");
  act(() => {
    connections.last.emit("open");
    connections.last.emit("change", change("C-1", 11));
  });
  await screen.findByText(title);
  const count = cards.mock.calls.length;
  act(() => connections.last.emit("change", change("C-1", 11)));
  await settle();
  expect(cards).toHaveBeenCalledTimes(count);
});

test.each(["needs-you", "snapshot", "execution", "activity", "cards"])(
  "%s refreshes on project changes without remounting the view",
  async (view) => {
    window.location.hash = `#/p/p-1/${view}`;
    const defaults = fakeClient(),
      method =
        view === "needs-you"
          ? "needsYou"
          : view === "cards"
            ? "cards"
            : (view as "snapshot" | "execution" | "activity");
    const loader = vi.spyOn(defaults, method);
    const { client, connections } = live({ [method]: loader });
    render(<App client={client} />);
    await waitFor(() => expect(loader).toHaveBeenCalled());
    act(() => connections.last.emit("open"));
    await settle();
    const before = loader.mock.calls.length;
    act(() => connections.last.emit("change", change("project", 1)));
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(before + 1));
  },
);

test("card streams filter unrelated events and preserve a comment draft and pending submission", async () => {
  window.location.hash = "#/p/p-1/cards/C-1";
  const read = vi.fn<CardiganClient["card"]>().mockResolvedValue(cardDetail());
  let finish: (c: PostedComment) => void = () => {};
  const addComment = vi.fn<CardiganClient["addComment"]>().mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { client, connections } = live({ card: read, addComment });
  render(<App client={client} />);
  const field = (await screen.findByLabelText(
    "评论正文",
  )) as HTMLTextAreaElement;
  fireEvent.change(field, { target: { value: "尚未提交的草稿" } });
  act(() => connections.last.emit("open"));
  await settle();
  const before = read.mock.calls.length;
  act(() => connections.last.emit("change", change("C-2", 1)));
  await settle();
  expect(read).toHaveBeenCalledTimes(before);
  act(() => connections.last.emit("change", change("C-1", 1)));
  await waitFor(() => expect(read).toHaveBeenCalledTimes(before + 1));
  expect(screen.getByLabelText("评论正文")).toBe(field);
  expect(field.value).toBe("尚未提交的草稿");
  fireEvent.click(screen.getByRole("button", { name: "发表评论" }));
  await waitFor(() => expect(addComment).toHaveBeenCalledTimes(1));
  act(() => connections.last.emit("change", change("C-1", 2)));
  await settle();
  expect(screen.getByLabelText("评论正文")).toBe(field);
  await act(async () =>
    finish({
      id: "C-1#99",
      body: field.value,
      created_at: "2026-01-01T00:00:00Z",
    }),
  );
  await waitFor(() => expect(field.value).toBe(""));
});

test("after a server restart the Workbench reconnects without re-reading loaded views or losing a draft", async () => {
  window.location.hash = "#/p/p-1/cards/C-1";
  const read = vi.fn<CardiganClient["card"]>().mockResolvedValue(cardDetail());
  const cards = vi.spyOn(fakeClient(), "cards");
  const { client, connections } = live({ card: read, cards });
  render(<App client={client} />);
  const field = (await screen.findByLabelText(
    "评论正文",
  )) as HTMLTextAreaElement;
  act(() => connections.last.emit("open"));
  act(() => connections.last.emit("change", change("C-1", 4)));
  await settle();
  fireEvent.change(field, { target: { value: "重启期间的草稿" } });
  const reads = read.mock.calls.length,
    lists = cards.mock.calls.length;

  const old = connections.last;
  act(() => old.emit("shutdown"));
  await waitFor(() => expect(connections.last).not.toBe(old));
  expect(
    new URL(connections.last.url, "https://workbench.invalid").searchParams.get(
      "after",
    ),
  ).toBe("C-1:4");
  act(() => connections.last.emit("open"));
  await settle();
  // Nothing changed while away: nothing is fetched again.
  expect(read).toHaveBeenCalledTimes(reads);
  expect(cards).toHaveBeenCalledTimes(lists);
  expect(screen.getByLabelText("评论正文")).toBe(field);
  expect(field.value).toBe("重启期间的草稿");

  // A change replayed by the new server refreshes the card once.
  act(() => connections.last.emit("change", change("C-1", 5)));
  await waitFor(() => expect(read).toHaveBeenCalledTimes(reads + 1));
  expect(field.value).toBe("重启期间的草稿");
});

test("switching project cancels old retries and cursors; expired sessions leave the live Workbench", async () => {
  window.location.hash = "#/p/p-1/cards";
  let authenticated = true;
  const { client, connections } = live({
    projects: async () => [
      project,
      { ...project, id: "p-2", name: "第二项目" },
    ],
    session: async () => ({ authenticated, password_configured: true }),
  });
  render(<App client={client} />);
  await screen.findByLabelText("项目");
  await waitFor(() => expect(connections.all.length).toBe(1));
  const old = connections.last;
  act(() => {
    old.emit("change", change("C-1", 20));
    old.emit("error");
  });
  fireEvent.change(screen.getByLabelText("项目"), { target: { value: "p-2" } });
  await waitFor(() =>
    expect(connections.last.url).toBe("/api/projects/p-2/stream"),
  );
  await settle();
  expect(old.closed).toBe(true);
  expect(connections.all).toHaveLength(2);
  authenticated = false;
  act(() => connections.last.emit("error"));
  await screen.findByRole("button", { name: "登录" });
  const stoppedCount = connections.all.length;
  await settle();
  expect(connections.all).toHaveLength(stoppedCount);
  expect(connections.all.every((c) => c.closed)).toBe(true);
});

test("cross-project queue changes refresh views without fabricating a project event cursor", () => {
  const p = pool(),
    c = callbacks();
  const stop = subscribeProject("p-1", c, p.create);
  p.last.emit("queue");
  expect(c.ready).toHaveBeenCalledOnce();
  expect(c.change).not.toHaveBeenCalled();
  stop();
  p.last.emit("queue");
  expect(c.ready).toHaveBeenCalledOnce();
});
