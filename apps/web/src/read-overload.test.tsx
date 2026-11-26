// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ApiError, describeError, HttpCardiganClient } from "./api.js";
import {
  isReadOverload,
  READ_OVERLOAD_RETRY_DELAYS_MS,
  SERVICE_RETRY_DELAYS_MS,
  ServiceUpdatingNotice,
} from "./service-retry.js";
import { cardDetail, fakeClient } from "./testing/fixtures.js";
import { useNeedsResource } from "./useNeedsResource.js";
import { RESOURCE_OVERLOAD_COOLDOWN_MS, useResource } from "./useResource.js";
import { CardDetailPage } from "./views/CardDetailPage.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** The read pool's JSON refusal (apps/server/src/web/read-pool.ts). */
const overloaded = (code: "read_timeout" | "read_busy" = "read_timeout") =>
  new Response(
    JSON.stringify({ error: { code, message: "读取超时，请稍后重试" } }),
    {
      status: 503,
      headers: { "content-type": "application/json", "retry-after": "1" },
    },
  );
const proxyDown = () =>
  new Response("<html>Service Unavailable</html>", {
    status: 503,
    headers: { "content-type": "text/html" },
  });
const ok = () =>
  Response.json({ authenticated: true, password_configured: true });

function client(replies: (() => Response)[], delays?: readonly number[]) {
  const queue = [...replies];
  const fetchImpl = vi.fn<typeof fetch>(async () => (queue.shift() ?? ok)());
  const notice = new ServiceUpdatingNotice();
  const waits: number[] = [];
  const noticeDuringSleep: boolean[] = [];
  const http = new HttpCardiganClient(fetchImpl, undefined, {
    notice,
    sleep: async (ms) => {
      waits.push(ms);
      noticeDuringSleep.push(notice.active());
    },
    ...(delays ? { readOverloadDelaysMs: delays } : {}),
  });
  return { http, fetchImpl, waits, noticeDuringSleep, notice };
}

test("C-775: an overloaded read is not retried by default (C-775#15)", () => {
  expect(READ_OVERLOAD_RETRY_DELAYS_MS).toEqual([]);
});

test.each(["read_timeout", "read_busy"] as const)(
  "C-775: a read refused with %s fails at once without the restart notice",
  async (code) => {
    const server = client(Array(10).fill(() => overloaded(code)));
    const seen: boolean[] = [];
    server.notice.subscribe(() => seen.push(server.notice.active()));
    const failure = await server.http.session().catch((error) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 503, code });
    // One request, no wait: the retry limit for an overload is zero.
    expect(server.fetchImpl).toHaveBeenCalledTimes(1);
    expect(server.waits).toEqual([]);
    // An overload is not a deployment: no "服务正在更新" notice.
    expect(seen).toEqual([]);
    expect(isReadOverload(failure)).toBe(true);
    expect(describeError(failure)).toBe("服务繁忙，读取超时，请稍后重试。");
  },
);

test("C-775: the restart schedule is still 4 retries after 1, 2, 4 and 8 s (Q-415)", () => {
  expect(SERVICE_RETRY_DELAYS_MS).toEqual([1_000, 2_000, 4_000, 8_000]);
});

test("C-775: a configured overload schedule sets both the waits and the limit", async () => {
  const server = client(
    Array(10).fill(() => overloaded("read_busy")),
    [1_000, 3_000, 9_000],
  );
  await expect(server.http.session()).rejects.toMatchObject({
    code: "read_busy",
  });
  expect(server.waits).toEqual([1_000, 3_000, 9_000]);
  expect(server.fetchImpl).toHaveBeenCalledTimes(4);
});

test("C-775: with a configured schedule a read that recovers returns its data", async () => {
  const server = client([() => overloaded("read_busy"), ok], [2_000]);
  await expect(server.http.session()).resolves.toMatchObject({
    authenticated: true,
  });
  expect(server.waits).toEqual([2_000]);
  expect(server.noticeDuringSleep).toEqual([false]);
});

test("C-775: a proxy 503 during a restart keeps the C-250 schedule and notice", async () => {
  const server = client(Array(10).fill(proxyDown));
  const failure = await server.http.session().catch((error) => error);
  expect(server.waits).toEqual([...SERVICE_RETRY_DELAYS_MS]);
  expect(server.noticeDuringSleep.every(Boolean)).toBe(true);
  expect(isReadOverload(failure)).toBe(false);
  expect(describeError(failure)).toBe(
    "服务正在更新，暂时没有恢复，请几秒后再试。",
  );
});

test("C-775: a restart followed by an overload stops at the overload", async () => {
  const server = client([proxyDown, ...Array(10).fill(() => overloaded())]);
  await expect(server.http.session()).rejects.toMatchObject({
    code: "read_timeout",
  });
  expect(server.waits).toEqual([1_000]);
  expect(server.fetchImpl).toHaveBeenCalledTimes(2);
});

test("C-775: keyed writes keep the C-250 schedule even for an overload body", async () => {
  const server = client(Array(10).fill(() => overloaded()));
  await expect(
    server.http.recordDecision("p-1", "Q-1", "merge", "确认合并", "k-1"),
  ).rejects.toMatchObject({ status: 503 });
  expect(server.waits).toEqual([...SERVICE_RETRY_DELAYS_MS]);
});

test("C-775: other failures are still not retried", async () => {
  const server = client([
    () => Response.json({ error: { code: "internal" } }, { status: 500 }),
  ]);
  await expect(server.http.session()).rejects.toMatchObject({ status: 500 });
  expect(server.fetchImpl).toHaveBeenCalledTimes(1);
  expect(server.waits).toEqual([]);
});

/** A load whose every call is settled by the test. */
function controlledLoad() {
  const calls: {
    resolve: (v: string) => void;
    reject: (e: unknown) => void;
  }[] = [];
  const load = vi.fn(
    () =>
      new Promise<string>((resolve, reject) => {
        calls.push({ resolve, reject });
      }),
  );
  return { load, calls };
}

test("C-775: automatic reads join the one in flight and run once afterwards", async () => {
  const { load, calls } = controlledLoad();
  const { result, rerender } = renderHook(
    ({ revision }) => useResource(load, revision),
    { initialProps: { revision: 0 } },
  );
  expect(load).toHaveBeenCalledTimes(1);
  for (let revision = 1; revision <= 5; revision++) rerender({ revision });
  act(() => result.current.refresh());
  // Five revisions and a refresh while the first read is open: no new request.
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => calls[0]?.resolve("first"));
  expect(result.current.data).toBe("first");
  // One follow-up read covers every change asked for meanwhile.
  expect(load).toHaveBeenCalledTimes(2);
  expect(result.current.pending).toBe(true);
  await act(async () => calls[1]?.resolve("second"));
  expect(result.current).toMatchObject({ data: "second", pending: false });
  expect(load).toHaveBeenCalledTimes(2);
});

test("C-775: an event during the follow-up read gets one more read after it", async () => {
  const { load, calls } = controlledLoad();
  const { result, rerender } = renderHook(
    ({ revision }) => useResource(load, revision),
    { initialProps: { revision: 0 } },
  );
  rerender({ revision: 1 });
  await act(async () => calls[0]?.resolve("first"));
  expect(load).toHaveBeenCalledTimes(2);
  // The last event arrives while the follow-up is open: it is not lost.
  rerender({ revision: 2 });
  expect(load).toHaveBeenCalledTimes(2);
  await act(async () => calls[1]?.resolve("second"));
  expect(load).toHaveBeenCalledTimes(3);
  await act(async () => calls[2]?.resolve("third"));
  expect(result.current).toMatchObject({ data: "third", pending: false });
  // Nothing changed after the third read started: no fourth.
  expect(load).toHaveBeenCalledTimes(3);
});

test("C-775: events during a slow failing read do not hide its failure", async () => {
  const { load, calls } = controlledLoad();
  const { result, rerender } = renderHook(
    ({ revision }) => useResource(load, revision),
    { initialProps: { revision: 0 } },
  );
  // Project activity every few seconds while a read waits out its timeout.
  for (let revision = 1; revision <= 10; revision++) rerender({ revision });
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () =>
    calls[0]?.reject(new ApiError(503, "read_timeout", "读取超时")),
  );
  expect(result.current).toMatchObject({
    error: "服务繁忙，读取超时，请稍后重试。",
    pending: false,
  });
  // The queued events wait out the overload cooldown instead of reading now.
  expect(load).toHaveBeenCalledTimes(1);
});

test("C-775: an explicit reload still replaces the read in flight", async () => {
  const { load, calls } = controlledLoad();
  const { result } = renderHook(() => useResource(load));
  act(() => result.current.reload());
  expect(load).toHaveBeenCalledTimes(2);
  await act(async () => calls[0]?.resolve("abandoned"));
  expect(result.current.data).toBeUndefined();
  await act(async () => calls[1]?.resolve("current"));
  expect(result.current.data).toBe("current");
});

const timeout = () => new ApiError(503, "read_timeout", "读取超时");

test("C-775: the overload cooldown defaults to 30 seconds", () => {
  expect(RESOURCE_OVERLOAD_COOLDOWN_MS).toBe(30_000);
});

test("C-775: after an overload, changes wait out the cooldown and then read once", async () => {
  vi.useFakeTimers();
  try {
    const { load, calls } = controlledLoad();
    const { result, rerender } = renderHook(
      ({ revision }) => useResource(load, revision),
      { initialProps: { revision: 0 } },
    );
    await act(async () => calls[0]?.reject(timeout()));
    expect(result.current).toMatchObject({
      error: "服务繁忙，读取超时，请稍后重试。",
      overloaded: true,
      pending: false,
    });
    for (let revision = 1; revision <= 10; revision++) rerender({ revision });
    act(() => result.current.refresh());
    // Live updates during the cooldown neither read nor show "正在加载".
    await act(() => vi.advanceTimersByTimeAsync(29_999));
    expect(load).toHaveBeenCalledTimes(1);
    expect(result.current).toMatchObject({ pending: false, overloaded: true });
    // When it ends, one read covers all of them; the failure stays shown.
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(load).toHaveBeenCalledTimes(2);
    expect(result.current).toMatchObject({
      pending: true,
      error: "服务繁忙，读取超时，请稍后重试。",
    });
    await act(async () => calls[1]?.resolve("back"));
    expect(result.current).toMatchObject({ data: "back", pending: false });
    expect(result.current.error).toBeUndefined();
    expect(result.current.overloaded).toBe(false);
    // Recovered: automatic reads follow changes at once again.
    rerender({ revision: 11 });
    expect(load).toHaveBeenCalledTimes(3);
  } finally {
    vi.useRealTimers();
  }
});

test("C-775: with no change during the cooldown nothing is read when it ends", async () => {
  vi.useFakeTimers();
  try {
    const { load, calls } = controlledLoad();
    renderHook(() => useResource(load));
    await act(async () => calls[0]?.reject(timeout()));
    await act(() => vi.advanceTimersByTimeAsync(120_000));
    expect(load).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

test("C-775: an overload again after the cooldown starts a new cooldown", async () => {
  vi.useFakeTimers();
  try {
    const { load, calls } = controlledLoad();
    const { rerender } = renderHook(
      ({ revision }) => useResource(load, revision),
      { initialProps: { revision: 0 } },
    );
    await act(async () => calls[0]?.reject(timeout()));
    rerender({ revision: 1 });
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(load).toHaveBeenCalledTimes(2);
    await act(async () => calls[1]?.reject(timeout()));
    rerender({ revision: 2 });
    await act(() => vi.advanceTimersByTimeAsync(29_000));
    expect(load).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(load).toHaveBeenCalledTimes(3);
  } finally {
    vi.useRealTimers();
  }
});

test("C-775: an explicit retry during the cooldown reads at once", async () => {
  vi.useFakeTimers();
  try {
    const { load, calls } = controlledLoad();
    const { result, rerender } = renderHook(
      ({ revision }) => useResource(load, revision),
      { initialProps: { revision: 0 } },
    );
    await act(async () => calls[0]?.reject(timeout()));
    rerender({ revision: 1 });
    act(() => result.current.reload());
    expect(load).toHaveBeenCalledTimes(2);
    await act(async () => calls[1]?.resolve("back"));
    expect(result.current).toMatchObject({ data: "back", pending: false });
    // The retry ended the cooldown: its pending timer reads nothing more.
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(load).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

test("C-775: a tab shown again after the cooldown reads once", async () => {
  vi.useFakeTimers();
  try {
    const { load, calls } = controlledLoad();
    const { rerender } = renderHook(
      ({ revision, enabled }) => useResource(load, revision, enabled),
      { initialProps: { revision: 0, enabled: true } },
    );
    await act(async () => calls[0]?.reject(timeout()));
    // Hidden during the cooldown: its end reads nothing in the background.
    rerender({ revision: 1, enabled: true });
    rerender({ revision: 1, enabled: false });
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(load).toHaveBeenCalledTimes(1);
    rerender({ revision: 1, enabled: true });
    expect(load).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

test("C-775: the Needs You count recovers after a read timeout (V-3461)", async () => {
  vi.useFakeTimers();
  try {
    let total = 0;
    const needsYouCounts = vi.fn(async () => {
      total++;
      if (total === 2) throw timeout();
      return {
        total_pending: total,
        tabs: {
          decisions: { count: 0, attention: 0 },
          merges: { count: 0, attention: 0 },
          actions: { count: 0, attention: 0 },
          later: { count: 0, attention: 0 },
        },
      };
    });
    const client = fakeClient({ needsYouCounts });
    const { result, rerender } = renderHook(
      ({ revision }) => useNeedsResource(client, "p-1", revision, "k"),
      { initialProps: { revision: 0 } },
    );
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(result.current.data?.total_pending).toBe(1);
    rerender({ revision: 1 });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(result.current.error).toBeDefined();
    for (let revision = 2; revision <= 11; revision++) {
      rerender({ revision });
      await act(() => vi.advanceTimersByTimeAsync(3_000));
    }
    // Ten changes over 30 s: one read when the cooldown ends, and it counts.
    expect(needsYouCounts).toHaveBeenCalledTimes(3);
    expect(result.current.data?.total_pending).toBe(3);
    expect(result.current.error).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});

test("C-775: other failures keep reloading on the next change as before", async () => {
  const { load, calls } = controlledLoad();
  const { result, rerender } = renderHook(
    ({ revision }) => useResource(load, revision),
    { initialProps: { revision: 0 } },
  );
  await act(async () => calls[0]?.reject(new ApiError(500, "internal", "x")));
  expect(result.current.error).toBe("请求失败：x");
  rerender({ revision: 1 });
  expect(load).toHaveBeenCalledTimes(2);
  // A proxy 503 (deployment) is not an overload either.
  await act(async () =>
    calls[1]?.reject(new ApiError(503, "http_503", "GET / 失败（503）")),
  );
  rerender({ revision: 2 });
  expect(load).toHaveBeenCalledTimes(3);
});

test("C-775: a new source abandons the read in flight", async () => {
  const first = controlledLoad();
  const second = controlledLoad();
  const { result, rerender } = renderHook(({ load }) => useResource(load), {
    initialProps: { load: first.load },
  });
  rerender({ load: second.load });
  expect(second.load).toHaveBeenCalledTimes(1);
  await act(async () => first.calls[0]?.resolve("old project"));
  expect(result.current.data).toBeUndefined();
  await act(async () => second.calls[0]?.resolve("new project"));
  expect(result.current.data).toBe("new project");
});

test("C-775: the card detail shows the failure and a retry instead of loading forever", async () => {
  let failing = true;
  const card = vi.fn(async () => {
    if (failing)
      throw new ApiError(503, "read_timeout", "读取超时，请稍后重试");
    return cardDetail();
  });
  const client = fakeClient({ card });
  const { rerender } = render(
    <CardDetailPage
      client={client}
      projectId="p-1"
      cardId="C-1"
      revision={0}
    />,
  );
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain(
    "卡片 C-1 没有加载出来：服务繁忙，读取超时，请稍后重试。",
  );
  expect(screen.queryByText("正在加载卡片 C-1…")).toBeNull();
  // Project activity does not start another read on its own.
  rerender(
    <CardDetailPage
      client={client}
      projectId="p-1"
      cardId="C-1"
      revision={1}
    />,
  );
  expect(card).toHaveBeenCalledTimes(1);
  failing = false;
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(card).toHaveBeenCalledTimes(2);
  expect(
    (await screen.findAllByText(cardDetail().card.title)).length,
  ).toBeGreaterThan(0);
});

test("C-775: other first-load failures keep their message without the card prefix", async () => {
  const card = vi.fn(async () => {
    throw new ApiError(500, "internal", "boom");
  });
  render(
    <CardDetailPage
      client={fakeClient({ card })}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("请求失败：boom");
  expect(alert.textContent).not.toContain("没有加载出来");
});
