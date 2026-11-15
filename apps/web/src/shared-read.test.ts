// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { HttpCardiganClient, type NeedsPage } from "./api.js";
import { sharePendingRead } from "./shared-read.js";
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

test("unsupported browsers use the authenticated read; HTTP client rechecks the session before joining", async () => {
  vi.stubGlobal("BroadcastChannel", undefined);
  const calls: string[] = [];
  let authenticated = true;
  const client = new HttpCardiganClient(async (input) => {
    const path = String(input);
    calls.push(path);
    return new Response(
      JSON.stringify(
        path === "/api/session"
          ? {
              authenticated,
              password_configured: true,
              ...(authenticated ? { read_scope: "scope" } : {}),
            }
          : data(1),
      ),
    );
  });
  await client.session();
  await client.needsYou("p", "key");
  authenticated = false;
  await client.needsYou("p", "key");
  expect(calls).toEqual([
    "/api/session",
    "/api/session",
    "/api/projects/p/needs-you",
    "/api/session",
    "/api/projects/p/needs-you",
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
