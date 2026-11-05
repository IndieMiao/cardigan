// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
  type ActivityData,
  type ActivityFilter,
  HttpCardiganClient,
} from "../api.js";
import { fakeClient } from "../testing/fixtures.js";
import { ActivityPage } from "./ActivityPage.js";

const event: ActivityData["events"][number] = {
  id: "event-new",
  card_id: "C-1",
  seq: 3,
  type: "instruction_issued",
  role: "pm",
  created_at: "2026-01-01T01:00:00Z",
  payload: { reason: "先完成必要检查", text: '<img src=x onerror="alert(1)">' },
  actor: { kind: "assignment", assignment_id: "A-1" },
};
const data: ActivityData = {
  events: [event],
  next_before: "event-new",
  counts: { returned: 1, matched: 2 },
};
const empty: ActivityData = {
  events: [],
  next_before: null,
  counts: { returned: 0, matched: 0 },
};
afterEach(cleanup);

test("activity is collapsed by default, exposes the actor/reason and escapes event content", async () => {
  const { container } = render(
    <ActivityPage
      client={fakeClient({ activity: async () => data })}
      projectId="p-1"
    />,
  );
  await screen.findByText(/指令 · pm · C-1/);
  expect(container.querySelector("details")?.open).toBe(false);
  expect(container.querySelector("pre")?.textContent).toContain(
    "先完成必要检查",
  );
  expect(container.querySelector("img")).toBeNull();
  expect(
    screen
      .getByRole("link", { name: "C-1", hidden: true })
      .getAttribute("href"),
  ).toBe("#/p/p-1/cards/C-1");
});

test("filters by card, role and type; paging preserves filters and a new filter resets the cursor", async () => {
  const activity = vi
    .fn<(p: string, f: ActivityFilter) => Promise<ActivityData>>()
    .mockResolvedValue(data);
  render(<ActivityPage client={fakeClient({ activity })} projectId="p-1" />);
  await screen.findByText(/最新事件/);
  for (const [label, value] of [
    ["卡片编号", "C-1"],
    ["角色", "pm"],
    ["事件类型", "instruction_issued"],
  ])
    fireEvent.change(screen.getByLabelText(label as string), {
      target: { value },
    });
  fireEvent.click(screen.getByRole("button", { name: "应用筛选" }));
  const filters = { card_id: "C-1", role: "pm", type: "instruction_issued" };
  await waitFor(() =>
    expect(activity).toHaveBeenLastCalledWith("p-1", filters),
  );
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "更早的事件" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "更早的事件" }));
  await waitFor(() =>
    expect(activity).toHaveBeenLastCalledWith("p-1", {
      ...filters,
      before: "event-new",
    }),
  );
  await screen.findByRole("button", { name: "返回最新" });
  fireEvent.click(screen.getByRole("button", { name: "返回最新" }));
  await waitFor(() =>
    expect(activity).toHaveBeenLastCalledWith("p-1", filters),
  );
  fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
  await waitFor(() => expect(activity).toHaveBeenLastCalledWith("p-1", {}));
});

test("activity shows loading and errors, retries, and handles empty results", async () => {
  const activity = vi
    .fn()
    .mockRejectedValueOnce(new Error("事件读取失败"))
    .mockResolvedValue(empty);
  render(<ActivityPage client={fakeClient({ activity })} projectId="p-1" />);
  expect(screen.getByText("正在加载…")).toBeTruthy();
  await screen.findByText("事件读取失败");
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await screen.findByText("没有符合条件的事件。");
  expect(
    (screen.getByRole("button", { name: "更早的事件" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

test("activity client encodes filters and paging without mutating Agent cursors", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(JSON.stringify(empty)));
  await new HttpCardiganClient(fetcher).activity("p/a", {
    card_id: "C-1",
    role: "pm ops",
    type: "instruction_issued",
    before: "event/1",
  });
  const [url, init] = fetcher.mock.calls[0] ?? [];
  const parsed = new URL(String(url), "https://workbench.invalid");
  expect(parsed.pathname).toBe("/api/projects/p%2Fa/activity");
  expect(Object.fromEntries(parsed.searchParams)).toEqual({
    card_id: "C-1",
    role: "pm ops",
    type: "instruction_issued",
    before: "event/1",
  });
  expect(init).toMatchObject({ method: "GET", credentials: "same-origin" });
  expect(init?.body).toBeUndefined();
});
