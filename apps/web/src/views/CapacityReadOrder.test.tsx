// @vitest-environment jsdom
// C-479 review V-2220 (林黛玉, attachment-6678): an older or superseded
// capacity read may not retire a real limit-save failure reported away.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "../App.js";
import type { StreamCallbacks } from "../stream.js";
import { fakeClient } from "../testing/fixtures.js";
import { resetSettingWrites } from "./useSettingWrite.js";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);
afterEach(async () => {
  cleanup();
  resetSettingWrites();
  window.location.hash = "";
  await new Promise((r) => setTimeout(r, 40));
});
test("a superseded capacity read with an old value may not dismiss a true failure after leaving settings", async () => {
  window.location.hash = "#/p/p-1/settings?tab=capacity";
  let limit = 6,
    holdNext = false;
  let stream: StreamCallbacks | undefined;
  const slow = Promise.withResolvers<void>(),
    write = Promise.withResolvers<void>();
  const read = vi.fn(async () => {
    const snapshot = limit;
    if (holdNext) {
      holdNext = false;
      await slow.promise;
    }
    return {
      agents: [
        {
          machine_id: "local",
          label: "本机",
          running: 1,
          total_running: 1,
          limit: snapshot,
          max_limit: 8,
          queued: 0,
          merge_check_slots: 0,
        },
      ],
      merge_checks: [],
      merge_config_invalid: false,
    };
  });
  render(
    <App
      client={fakeClient({
        executionCapacity: read,
        setRunLimit: () => write.promise,
        subscribe: (_, s) => {
          stream = s;
          s.status("live");
          return () => {};
        },
      })}
    />,
  );
  const i = await screen.findByRole<HTMLInputElement>("spinbutton", {
    name: "本机 Agent 并发上限",
  });
  expect(i.value).toBe("6");
  // A reads the prior limit but is slow; a later SSE invalidation reads the current value first.
  holdNext = true;
  await act(async () => stream!.capacity!());
  expect(holdNext).toBe(false);
  limit = 4;
  await act(async () => stream!.capacity!());
  await waitFor(() => expect(i.value).toBe("4"));
  fireEvent.change(i, { target: { value: "6" } });
  fireEvent.keyDown(i, { key: "Enter" });
  expect(i.readOnly).toBe(true);
  fireEvent.click(screen.getByRole("link", { name: "帮助", exact: true }));
  await waitFor(() =>
    expect(
      screen.queryByRole("heading", { name: "设置", exact: true }),
    ).toBeNull(),
  );
  const n = read.mock.calls.length;
  await act(async () => write.reject(new Error("not applied")));
  await screen.findByRole("button", { name: "回到设置" });
  expect(read.mock.calls.length).toBeGreaterThan(n);
  expect((await read.mock.results.at(-1)!.value).agents[0].limit).toBe(4);
  await act(async () => slow.resolve());
  expect(limit).toBe(4);
  expect(screen.queryByRole("button", { name: "回到设置" })).not.toBeNull();
});
test("a read that started before the write cannot confirm it while the actual readback is pending", async () => {
  window.location.hash = "#/p/p-1/settings?tab=capacity";
  let limit = 4;
  let gate: Promise<void> | undefined, stream: StreamCallbacks | undefined;
  const old = Promise.withResolvers<void>(),
    post = Promise.withResolvers<void>(),
    write = Promise.withResolvers<void>();
  const read = vi.fn(async () => {
    const snap = limit;
    const wait = gate;
    gate = undefined;
    if (wait) await wait;
    return {
      agents: [
        {
          machine_id: "local",
          label: "本机",
          running: 1,
          total_running: 1,
          limit: snap,
          max_limit: 8,
          queued: 0,
          merge_check_slots: 0,
        },
      ],
      merge_checks: [],
      merge_config_invalid: false,
    };
  });
  render(
    <App
      client={fakeClient({
        executionCapacity: read,
        setRunLimit: () => write.promise,
        subscribe: (_, s) => {
          stream = s;
          s.status("live");
          return () => {};
        },
      })}
    />,
  );
  const input = await screen.findByRole<HTMLInputElement>("spinbutton", {
    name: "本机 Agent 并发上限",
  });
  expect(input.value).toBe("4");
  limit = 6;
  gate = old.promise;
  await act(async () => stream!.capacity!());
  expect(gate).toBeUndefined();
  limit = 4;
  fireEvent.change(input, { target: { value: "6" } });
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.click(screen.getByRole("link", { name: "帮助", exact: true }));
  await waitFor(() =>
    expect(
      screen.queryByRole("heading", { name: "设置", exact: true }),
    ).toBeNull(),
  );
  gate = post.promise;
  await act(async () => write.reject(new Error("not applied")));
  await screen.findByRole("button", { name: "回到设置" });
  expect(gate).toBeUndefined();
  await act(async () => old.resolve());
  await act(async () => post.resolve());
  expect((await read.mock.results.at(-1)!.value).agents[0].limit).toBe(4);
  expect(screen.queryByRole("button", { name: "回到设置" })).not.toBeNull();
});
