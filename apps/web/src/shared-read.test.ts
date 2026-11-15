// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { HttpCardiganClient, type NeedsPage } from "./api.js";
import { clearSharedReads, sharePendingRead } from "./shared-read.js";
import { fakeClient } from "./testing/fixtures.js";
import { useNeedsResource } from "./useNeedsResource.js";

const data = (n: number): NeedsPage => ({
  decisions: [],
  human_actions: [],
  incidents: [],
  attention: [],
  counts: { decisions: n, human_actions: 0, notices_unread: 0 },
});
afterEach(() => {
  clearSharedReads();
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
function sharingBrowser() {
  const channels = new Set<Channel>();
  class Channel {
    onmessage?: (event: { data: unknown }) => void;
    constructor(readonly name: string) {
      channels.add(this);
    }
    postMessage(data: unknown) {
      for (const c of channels)
        if (c !== this && c.name === this.name)
          c.onmessage?.({ data: structuredClone(data) });
    }
    close() {
      channels.delete(this);
    }
  }
  const queues = new Map<string, Promise<unknown>>();
  const request = vi.fn(
    (
      name: string,
      options: LockOptions | (() => Promise<unknown>),
      callback?: () => Promise<unknown>,
    ) => {
      const run = typeof options === "function" ? options : callback;
      const signal = typeof options === "function" ? undefined : options.signal;
      const next = (queues.get(name) ?? Promise.resolve())
        .catch(() => {})
        .then(() => {
          if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
          return run?.();
        });
      queues.set(name, next);
      return next;
    },
  );
  vi.stubGlobal("BroadcastChannel", Channel);
  vi.spyOn(navigator, "locks", "get").mockReturnValue({
    request,
  } as unknown as LockManager);
  return { channels, request };
}

test("overlapping tab consumers share only the same live scope, project and invalidation; completed results are not retained", async () => {
  // jsdom has no Web Locks; define the feature on this test's navigator.
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    get: () => undefined,
  });
  const { channels } = sharingBrowser();
  const pending = deferred<NeedsPage>();
  const load = vi.fn(() => pending.promise);
  const first = sharePendingRead("session", "project", "C-1:1", load);
  const second = sharePendingRead("session", "project", "C-1:1", load);
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  pending.resolve(data(1));
  expect(await first).toEqual(data(1));
  expect(await second).toEqual(data(1));
  await waitFor(() => expect(channels.size).toBe(0));
  const fresh = vi.fn(async () => data(2));
  await sharePendingRead("session", "project", "C-1:1", fresh);
  expect(fresh).toHaveBeenCalledOnce();
  const separate = vi.fn(async () => data(3));
  await Promise.all([
    sharePendingRead("other-session", "project", "C-1:1", separate),
    sharePendingRead("session", "other-project", "C-1:1", separate),
    sharePendingRead("session", "project", "C-1:2", separate),
  ]);
  expect(separate).toHaveBeenCalledTimes(3);
});

test("failed shared requests release the lock and channel and allow retry", async () => {
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    get: () => undefined,
  });
  const { channels } = sharingBrowser();
  await expect(
    sharePendingRead("s", "p", "k", async () => {
      throw new Error("failed");
    }),
  ).rejects.toThrow("failed");
  expect(channels.size).toBe(0);
  await expect(
    sharePendingRead("s", "p", "k", async () => data(1)),
  ).resolves.toEqual(data(1));
  const failure = deferred<NeedsPage>();
  const first = sharePendingRead(
    "s",
    "p",
    "queued-failure",
    () => failure.promise,
  );
  const following = sharePendingRead("s", "p", "queued-failure", async () =>
    data(3),
  );
  const rejected = expect(first).rejects.toThrow("queued failure");
  failure.reject(new Error("queued failure"));
  await rejected;
  await expect(following).resolves.toEqual(data(3));
  await waitFor(() => expect(channels.size).toBe(0));
});

test("HTTP sharing reads the server version, rejects scope changes, and preserves unsupported-browser reads", async () => {
  vi.stubGlobal("BroadcastChannel", undefined);
  const calls: string[] = [];
  let authenticated = true,
    responseScope = "scope";
  const client = new HttpCardiganClient(async (input) => {
    const path = String(input);
    calls.push(path);
    if (path === "/api/session")
      return new Response(
        JSON.stringify({
          authenticated: true,
          password_configured: true,
          read_scope: "scope",
        }),
      );
    if (path.endsWith("/version"))
      return authenticated
        ? new Response(
            JSON.stringify({
              revision: "server-version",
              read_scope: "scope",
              at: "2026-01-01T00:00:00.000Z",
            }),
          )
        : new Response(
            JSON.stringify({
              error: { code: "unauthorized", message: "login" },
            }),
            { status: 401 },
          );
    return new Response(JSON.stringify(data(1)), {
      headers: { "x-cardigan-read-scope": responseScope },
    });
  });
  await client.session();
  await client.needsYou("p", "local-history-a");
  responseScope = "changed";
  await expect(client.needsYou("p", "local-history-b")).rejects.toMatchObject({
    code: "read_context_changed",
  });
  authenticated = false;
  await expect(client.needsYou("p", "ready")).rejects.toMatchObject({
    status: 401,
  });
  expect(calls).toEqual([
    "/api/session",
    "/api/projects/p/needs-you/version",
    "/api/projects/p/needs-you",
    "/api/projects/p/needs-you/version",
    "/api/projects/p/needs-you",
    "/api/projects/p/needs-you/version",
  ]);
});

test("hidden pages pause reads; resuming and project changes discard abandoned responses and explicit retry is fresh", async () => {
  let hidden = false;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  const pending = deferred<NeedsPage>();
  const read = vi
    .fn()
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValue(data(2));
  const client = fakeClient({ needsYou: read });
  const hook = renderHook(
    ({ project, revision }) =>
      useNeedsResource(client, project, revision, `C-1:${revision}`),
    { initialProps: { project: "p", revision: 0 } },
  );
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  act(() => {
    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  hook.rerender({ project: "p", revision: 1 });
  hook.rerender({ project: "p", revision: 2 });
  expect(read).toHaveBeenCalledTimes(1);
  act(() => {
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await waitFor(() =>
    expect(hook.result.current.data?.counts?.decisions).toBe(2),
  );
  await act(async () => pending.resolve(data(99)));
  expect(hook.result.current.data?.counts?.decisions).toBe(2);
  expect(read).toHaveBeenLastCalledWith("p", "C-1:2");
  hook.rerender({ project: "other", revision: 0 });
  expect(hook.result.current.data).toBeUndefined();
  await waitFor(() => expect(read).toHaveBeenLastCalledWith("other", "C-1:0"));
  act(() => hook.result.current.reload());
  await waitFor(() => expect(read).toHaveBeenCalledTimes(4));
  expect(read.mock.calls.at(-1)?.[1]).not.toBe("C-1:0");
});

test("validated completed responses are reused, cleared on revision/context change, and released when hidden", async () => {
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    get: () => undefined,
  });
  const { channels } = sharingBrowser();
  const load = vi.fn(async () => data(1));
  await sharePendingRead("s", "p", "server-1", load, true);
  await sharePendingRead("s", "p", "server-1", load, true);
  expect(load).toHaveBeenCalledTimes(1);
  await sharePendingRead("s", "p", "server-2", load, true);
  expect(load).toHaveBeenCalledTimes(2);
  await sharePendingRead("new-session", "p", "server-2", load, true);
  expect(load).toHaveBeenCalledTimes(3);
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  document.dispatchEvent(new Event("visibilitychange"));
  await waitFor(() => expect(channels.size).toBe(0));
});

test("a completed old request cannot replace the newer validated cache, and concurrent holders are all released", async () => {
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    get: () => undefined,
  });
  const { channels } = sharingBrowser();
  const pending = deferred<NeedsPage>();
  const old = sharePendingRead("s", "p", "old", () => pending.promise, true);
  await waitFor(() => expect(channels.size).toBe(1));
  await sharePendingRead("s", "p", "new", async () => data(2), true);
  pending.resolve(data(1));
  await old;
  const load = vi.fn(async () => data(99));
  await expect(sharePendingRead("s", "p", "new", load, true)).resolves.toEqual(
    data(2),
  );
  expect(load).not.toHaveBeenCalled();
  clearSharedReads();
  const simultaneous = deferred<NeedsPage>();
  const first = sharePendingRead(
    "s",
    "p",
    "same",
    () => simultaneous.promise,
    true,
  );
  const second = sharePendingRead(
    "s",
    "p",
    "same",
    () => simultaneous.promise,
    true,
  );
  simultaneous.resolve(data(3));
  await Promise.all([first, second]);
  clearSharedReads();
  await waitFor(() => expect(channels.size).toBe(0));
});

test("HTTP consumers with unrelated local histories reuse only freshly revalidated server data and discard revoked contexts", async () => {
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    get: () => undefined,
  });
  const { channels } = sharingBrowser();
  let revision = "one",
    permitted = true,
    reads = 0;
  const fetcher: typeof fetch = async (input) => {
    const path = String(input);
    if (path === "/api/session")
      return new Response(
        JSON.stringify({
          authenticated: true,
          password_configured: true,
          read_scope: "scope",
        }),
      );
    if (path.endsWith("/version"))
      return permitted
        ? new Response(
            JSON.stringify({
              revision,
              read_scope: "scope",
              at: "2026-01-01T00:00:00.000Z",
            }),
          )
        : new Response(
            JSON.stringify({
              error: { code: "unauthorized", message: "login" },
            }),
            { status: 401 },
          );
    reads++;
    return new Response(JSON.stringify(data(revision === "one" ? 1 : 2)), {
      headers: {
        "x-cardigan-read-scope": "scope",
        "x-cardigan-read-at": "2026-01-01T00:00:00.000Z",
      },
    });
  };
  const a = new HttpCardiganClient(fetcher),
    b = new HttpCardiganClient(fetcher);
  await a.session();
  await b.session();
  await a.needsYou("p", "historical-A");
  expect((await b.needsYou("p", "late-ready-B")).counts?.decisions).toBe(1);
  expect(reads).toBe(1);
  revision = "two";
  expect((await b.needsYou("p", "same-local-key")).counts?.decisions).toBe(2);
  expect(reads).toBe(2);
  permitted = false;
  await expect(a.needsYou("p", "ready")).rejects.toMatchObject({ status: 401 });
  await waitFor(() => expect(channels.size).toBe(0));
});
