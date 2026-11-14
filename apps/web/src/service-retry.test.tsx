// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./App.js";
import {
  ApiError,
  describeError,
  describeWriteError,
  HttpCardiganClient,
} from "./api.js";
import { ServiceUpdatingFeedback } from "./components/ServiceUpdatingFeedback.js";
import {
  SERVICE_RETRY_DELAYS_MS,
  SERVICE_UPDATING_MESSAGE,
  ServiceUpdatingNotice,
} from "./service-retry.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

type Outage = "502" | "503" | "refused";

const down = (kind: Outage): Response => {
  if (kind === "refused") throw new TypeError("Failed to fetch");
  return new Response("<html>Bad Gateway</html>", {
    status: Number(kind),
    headers: { "content-type": "text/html" },
  });
};

/**
 * A server behind a proxy: while `outages` lasts the proxy answers instead;
 * once up, writes are applied once per idempotency key (like the real server).
 */
function fakeServer(outages: readonly Outage[]) {
  const queue = [...outages];
  const applied = new Map<string, string>();
  const calls: { method: string; key: string | null; body: string | null }[] =
    [];
  const notice = new ServiceUpdatingNotice();
  const noticeDuringSleep: boolean[] = [];
  const waits: number[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    const key = new Headers(init?.headers).get("Idempotency-Key");
    const body = (init?.body as string | undefined) ?? null;
    calls.push({ method: init?.method ?? "GET", key, body });
    const outage = queue.shift();
    if (outage) return down(outage);
    if (key !== null && !applied.has(key)) applied.set(key, body ?? "");
    return init?.method === "GET"
      ? Response.json({ authenticated: true, password_configured: true })
      : new Response(null, { status: 204 });
  });
  const client = new HttpCardiganClient(fetchImpl, undefined, {
    notice,
    sleep: async (ms) => {
      waits.push(ms);
      noticeDuringSleep.push(notice.active());
    },
  });
  return { client, calls, applied, notice, noticeDuringSleep, waits };
}

test.each<Outage>(["502", "503", "refused"])(
  "a merge confirmation rides out %s and applies once with the same key",
  async (kind) => {
    const server = fakeServer([kind, kind]);
    await server.client.recordDecision(
      "p-1",
      "Q-408",
      "merge",
      "确认合并",
      "k-1",
    );
    expect(server.calls).toHaveLength(3);
    expect(new Set(server.calls.map((c) => c.key))).toEqual(new Set(["k-1"]));
    expect(new Set(server.calls.map((c) => c.body)).size).toBe(1);
    expect(server.applied.size).toBe(1);
    expect(server.waits).toEqual(SERVICE_RETRY_DELAYS_MS.slice(0, 2));
    expect(server.noticeDuringSleep).toEqual([true, true]);
    expect(server.notice.active()).toBe(false);
  },
);

test("a mixed outage on human action confirmation still applies once", async () => {
  const server = fakeServer(["refused", "502", "503"]);
  await server.client.completeAction("p-1", "H-1", "已完成", "k-2");
  expect(server.calls).toHaveLength(4);
  expect(server.applied).toEqual(new Map([["k-2", '{"text":"已完成"}']]));
  expect(server.notice.active()).toBe(false);
});

test("a write that committed before its connection dropped is not applied twice", async () => {
  const applied = new Map<string, string>();
  // The first attempt reaches the server, which applies it; the reply is lost.
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    const key = new Headers(init?.headers).get("Idempotency-Key") ?? "";
    const replayed = applied.has(key);
    if (!replayed) applied.set(key, String(init?.body));
    if (fetchImpl.mock.calls.length === 1) throw new TypeError("reset");
    return new Response(null, { status: 204 });
  });
  const client = new HttpCardiganClient(fetchImpl, undefined, {
    sleep: async () => {},
    notice: new ServiceUpdatingNotice(),
  });
  await client.recordDecision("p-1", "Q-1", "merge", "确认合并", "k-3");
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect([...applied.keys()]).toEqual(["k-3"]);
});

test("a persistent outage gives up, says the write did not take effect, and clears the notice", async () => {
  const outages = Array.from(
    { length: SERVICE_RETRY_DELAYS_MS.length + 1 },
    () => "503" as const,
  );
  const server = fakeServer(outages);
  const failure = await server.client
    .recordDecision("p-1", "Q-408", "merge", "确认合并", "k-4")
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(ApiError);
  expect((failure as ApiError).status).toBe(503);
  expect((failure as ApiError).outcomeUncertain).toBe(false);
  expect(server.calls).toHaveLength(SERVICE_RETRY_DELAYS_MS.length + 1);
  expect(server.applied.size).toBe(0);
  expect(server.notice.active()).toBe(false);
  const text = describeWriteError(failure);
  expect(text).toContain("服务正在更新");
  expect(text).toContain("操作没有生效");
  expect(text).toContain("再点一次");
  expect(text).not.toContain("503");
});

test.each([503, 502])(
  "a write whose reply was lost before a persistent %i is reported as maybe applied",
  async (status) => {
    const applied = new Map<string, string>();
    // V-850: attempt 1 commits then loses its reply; every retry hits the proxy.
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      if (fetchImpl.mock.calls.length === 1) {
        const key = new Headers(init?.headers).get("Idempotency-Key") ?? "";
        applied.set(key, String(init?.body));
        throw new TypeError("Response lost after commit");
      }
      return new Response("Service Unavailable", { status });
    });
    const notice = new ServiceUpdatingNotice();
    const client = new HttpCardiganClient(fetchImpl, undefined, {
      sleep: async () => {},
      notice,
    });
    const failure = await client
      .recordDecision("p-1", "Q-408", "merge", "确认合并", "fixed-key")
      .catch((error: unknown) => error);
    expect(fetchImpl).toHaveBeenCalledTimes(SERVICE_RETRY_DELAYS_MS.length + 1);
    expect([...applied.keys()]).toEqual(["fixed-key"]);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(status);
    expect((failure as ApiError).outcomeUncertain).toBe(true);
    const text = describeWriteError(failure);
    expect(text).toContain("服务正在更新");
    expect(text).toContain("可能已经成功");
    expect(text).not.toContain("没有生效");
    expect(notice.active()).toBe(false);
  },
);

test("a persistent 502 never surfaces only the status code", () => {
  const error = new ApiError(
    502,
    "http_502",
    "POST /api/projects/p/decisions/Q-408/resolve 失败（502）",
  );
  expect(describeWriteError(error)).not.toContain("502");
  expect(describeError(error)).toContain("服务正在更新");
});

test("writes without an idempotency key are never retried", async () => {
  const server = fakeServer(["502", "502"]);
  await expect(server.client.logout()).rejects.toMatchObject({ status: 502 });
  expect(server.calls).toHaveLength(1);
  expect(server.waits).toEqual([]);
  expect(server.notice.active()).toBe(false);
});

test("a write without a key is not retried after a refused connection either", async () => {
  const server = fakeServer(["refused"]);
  await expect(server.client.logout()).rejects.toBeInstanceOf(TypeError);
  expect(server.calls).toHaveLength(1);
});

test("reads are retried", async () => {
  const server = fakeServer(["refused", "503"]);
  await expect(server.client.session()).resolves.toMatchObject({
    authenticated: true,
  });
  expect(server.calls.map((c) => c.method)).toEqual(["GET", "GET", "GET"]);
});

test("other failures are not retried", async () => {
  const fetchImpl = vi.fn<typeof fetch>(
    async () => new Response("{}", { status: 500 }),
  );
  const client = new HttpCardiganClient(fetchImpl, undefined, {
    sleep: async () => {},
    notice: new ServiceUpdatingNotice(),
  });
  await expect(client.session()).rejects.toMatchObject({ status: 500 });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test("the notice shows while any request retries and disappears afterwards", () => {
  const notice = new ServiceUpdatingNotice();
  render(<ServiceUpdatingFeedback notice={notice} />);
  expect(screen.queryByText(SERVICE_UPDATING_MESSAGE)).toBeNull();
  let endA: () => void = () => {};
  let endB: () => void = () => {};
  act(() => {
    endA = notice.begin();
    endB = notice.begin();
  });
  expect(screen.getByRole("status").textContent).toBe(
    "服务正在更新，几秒后自动重试…",
  );
  act(() => endA());
  expect(screen.getByText(SERVICE_UPDATING_MESSAGE)).toBeTruthy();
  act(() => {
    endB();
    endA();
  });
  expect(screen.queryByText(SERVICE_UPDATING_MESSAGE)).toBeNull();
});

test("the Workbench shows the notice during an outage and drops it once the server is back", async () => {
  const notice = new ServiceUpdatingNotice();
  let release: () => void = () => {};
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response("", { status: 502 }))
    .mockResolvedValue(
      Response.json({ authenticated: false, password_configured: true }),
    );
  const client = new HttpCardiganClient(fetchImpl, undefined, {
    notice,
    sleep: () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  });
  render(<App client={client} serviceNotice={notice} />);
  expect(await screen.findByText(SERVICE_UPDATING_MESSAGE)).toBeTruthy();
  act(() => release());
  await waitFor(() =>
    expect(screen.queryByText(SERVICE_UPDATING_MESSAGE)).toBeNull(),
  );
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});
