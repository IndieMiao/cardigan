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
import { App } from "../App.js";
import type { ExecutionCapacity } from "../api.js";
import { findHelpDocument, helpDocuments } from "../help-content.js";
import { fakeClient } from "../testing/fixtures.js";
import {
  CAPACITY_HELP_SLUG,
  CapacityProvider,
  useCapacity,
} from "./Capacity.js";
import { PageTitle } from "./Foundation.js";

const capacity: ExecutionCapacity = {
  agents: [
    {
      machine_id: "local",
      label: "工作机",
      running: 3,
      total_running: 5,
      limit: 6,
      max_limit: 16,
      queued: 2,
      merge_check_slots: 2,
    },
    {
      machine_id: "worker",
      label: "第二台工作机",
      running: 1,
      total_running: 1,
      limit: 4,
      max_limit: 8,
      queued: 0,
      merge_check_slots: 0,
    },
  ],
  merge_checks: [{ machine_id: "ci-test", running: 1, limit: 3, queued: 4 }],
  merge_config_invalid: false,
};
const cellText = (cell: Element) => cell.textContent?.trim() ?? "";
/** The cells of the table row whose first cell is exactly `name`. */
const rowCells = (scope: HTMLElement, name: string) => {
  const row = within(scope)
    .getAllByRole("row")
    .find((r) => r.firstElementChild?.textContent === name);
  if (!row) throw new Error(`No row ${name}`);
  return Array.from(row.children, cellText);
};
afterEach(() => {
  cleanup();
  window.location.hash = "";
});

// All real page titles consume the same shell resource, including the team tab.
test.each([
  ["cards", "卡片"],
  ["execution", "执行视图"],
  ["needs-you", "Needs You"],
  ["cards/C-1", "测试目标"],
  ["settings", "设置"],
  ["snapshot", "项目快照"],
  ["activity", "项目动态"],
  ["help", "帮助"],
  ["decision-history", "拍板历史"],
])("%s shows the shared capacity status in its title", async (route) => {
  window.location.hash = `#/p/p-1/${route}`;
  // Keep cold route compilation outside the capacity query's existing deadline.
  if (route === "execution") await import("../views/ExecutionPage.js");
  render(
    <App client={fakeClient({ executionCapacity: async () => capacity })} />,
  );
  if (route === "cards/C-1") {
    await screen.findByRole("article", { name: "卡片 C-1" });
    expect(document.querySelector(".card-header .capacity-status")).toBeNull();
    return;
  }
  const button = await screen.findByRole("button", {
    name:
      route === "execution"
        ? "工作机 3/6 · 第二台工作机 1/4，查看并发与容量详情"
        : "Agent 4/10 · 排队 2 · CI 1/3，查看并发与容量详情",
  });
  expect(button.closest(".page-title")?.querySelector("h1")).toBeTruthy();
  expect(document.querySelectorAll(".capacity-status")).toHaveLength(1);
  if (route === "settings") {
    fireEvent.click(screen.getByRole("button", { name: "员工" }));
    expect(screen.getByRole("button", { name: /Agent 4\/10/u })).toBeTruthy();
    // C-511: the machine page, where each machine's detail edits its
    // limit; merge check targets stay listed, read only. C-576 removed the
    // duplicate 并发与容量 entry.
    fireEvent.click(screen.getByRole("button", { name: "机器" }));
    await screen.findByRole("heading", { name: "机器" });
    expect(window.location.hash).toContain("tab=machines");
    expect(screen.getByRole("heading", { name: "合并检查" })).toBeTruthy();
  }
});

test("hover, keyboard and touch expose machine/CI details; Escape dismisses", async () => {
  render(
    <CapacityProvider
      client={fakeClient({ executionCapacity: async () => capacity })}
      projectId="p"
      revision={0}
      canEdit
    >
      <PageTitle title="执行视图" />
    </CapacityProvider>,
  );
  const button = await screen.findByRole("button", { name: /Agent 4\/10/u });
  fireEvent.pointerEnter(button, { pointerType: "mouse" });
  let tooltip = await screen.findByRole("tooltip");
  // C-824: one compact table; the header appears once.
  expect(within(tooltip).getAllByRole("columnheader").map(cellText)).toEqual([
    "名称",
    "占用/上限",
    "排队",
    "资源",
  ]);
  // C-576: 占用 adds this host's CI slots (3 + 2), as the scheduler does.
  expect(rowCells(tooltip, "工作机")).toEqual([
    "工作机",
    "5/6",
    "2",
    "本机 CI 2",
  ]);
  expect(rowCells(tooltip, "第二台工作机")).toEqual([
    "第二台工作机",
    "1/4",
    "0",
    "",
  ]);
  expect(rowCells(tooltip, "ci-test")).toEqual(["ci-test", "1/3", "4", ""]);
  // No paragraphs of counting rules; they are one link away.
  expect(tooltip.textContent).not.toContain("常驻 PM");
  expect(tooltip.textContent).not.toContain("尚未确认结束");
  expect(tooltip.textContent).not.toContain("全部 5");
  expect(
    within(tooltip)
      .getByRole("link", { name: "口径说明" })
      .getAttribute("href"),
  ).toBe("#/p/p/help?doc=07-capacity");
  expect(
    within(tooltip)
      .getByRole("link", { name: "修改上限" })
      .getAttribute("href"),
  ).toBe("#/p/p/settings?tab=machines");
  expect(button.getAttribute("aria-describedby")).toBe(tooltip.id);
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  fireEvent.focus(button);
  await screen.findByRole("tooltip");
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  fireEvent.click(button);
  tooltip = await screen.findByRole("tooltip");
  expect(tooltip.querySelector("input")).toBeNull();
});

test("C-824 marks full or queued rows and full resources; idle ones are muted", async () => {
  const data: ExecutionCapacity = {
    agents: [
      {
        machine_id: "ci-host",
        label: "cardigan-ci",
        running: 4,
        total_running: 4,
        limit: 12,
        max_limit: 16,
        queued: 1,
        merge_check_slots: 0,
        resources: [
          { key: "android.emulator", occupied: 1, limit: 1 },
          { key: "blender", occupied: 0, limit: 1 },
          { key: "godot", occupied: 1, limit: 2 },
          { key: "ios.simulator", occupied: 0, limit: 0 },
        ],
      },
      {
        machine_id: "local",
        label: "local",
        running: 2,
        total_running: 3,
        limit: 4,
        max_limit: 8,
        queued: 0,
        merge_check_slots: 0,
      },
      {
        machine_id: "full",
        label: "full-host",
        running: 1,
        total_running: 1,
        limit: 2,
        max_limit: 8,
        queued: 0,
        merge_check_slots: 1,
      },
      {
        machine_id: "off",
        label: "offline-host",
        running: 0,
        total_running: 0,
        limit: 0,
        max_limit: 8,
        queued: 0,
        merge_check_slots: 0,
      },
    ],
    merge_checks: [
      { machine_id: "github-actions", running: 2, limit: 16, queued: 0 },
      { machine_id: "github-actions-sensen", running: 4, limit: 4, queued: 0 },
    ],
    merge_config_invalid: false,
  };
  render(
    <CapacityProvider
      client={fakeClient({ executionCapacity: async () => data })}
      projectId="p"
      revision={0}
      canEdit
    >
      <PageTitle title="卡片" />
    </CapacityProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: /Agent 7\/—/u }));
  const tooltip = await screen.findByRole("tooltip");
  const row = (name: string) =>
    within(tooltip)
      .getAllByRole("row")
      .find((r) => r.firstElementChild?.textContent === name);
  const attention = (name: string) =>
    row(name)?.getAttribute("data-attention") === "true";
  const tones = (name: string) =>
    Array.from(row(name)?.children ?? [], (c) => c.getAttribute("data-tone"));
  // Queued: only the queue count is in the status colour.
  expect(attention("cardigan-ci")).toBe(true);
  expect(tones("cardigan-ci")).toEqual([null, null, "wait", null]);
  // Below the limit and nothing queued: muted.
  expect(attention("local")).toBe(false);
  expect(tones("local")).toEqual([null, null, null, null]);
  // CI slots fill the limit (1 + 1 of 2).
  expect(attention("full-host")).toBe(true);
  expect(rowCells(tooltip, "full-host").slice(1, 2)).toEqual(["2/2"]);
  expect(tones("full-host")).toEqual([null, "wait", null, null]);
  // An unknown limit never reads as free capacity.
  expect(attention("offline-host")).toBe(true);
  expect(rowCells(tooltip, "offline-host").slice(1, 2)).toEqual(["0/—"]);
  expect(tones("offline-host")[1]).toBe("wait");
  expect(attention("github-actions")).toBe(false);
  expect(attention("github-actions-sensen")).toBe(true);
  const tags = Array.from(
    row("cardigan-ci")?.querySelectorAll("[data-ui=badge]") ?? [],
    (tag) => [tag.textContent, tag.getAttribute("data-state")],
  );
  expect(tags).toEqual([
    ["android.emulator 1/1", "full"],
    ["blender 0/1", "idle"],
    ["godot 1/2", "used"],
    ["ios.simulator 0/0", "idle"],
  ]);
  // Two groups under a single header row.
  expect(within(tooltip).getAllByRole("columnheader")).toHaveLength(4);
  expect(within(tooltip).getByText("Agent")).toBeTruthy();
  expect(within(tooltip).getByText("CI")).toBeTruthy();
  // Following a link closes the popover.
  fireEvent.click(within(tooltip).getByRole("link", { name: "口径说明" }));
  await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
});

test("C-824 invalid CI config, no CI and no resources keep short facts", async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce({ ...capacity, merge_config_invalid: true })
    .mockResolvedValueOnce({
      ...capacity,
      agents: capacity.agents.map((m) => ({ ...m, merge_check_slots: 0 })),
      merge_checks: [],
    });
  const client = fakeClient({ executionCapacity: read });
  const view = render(
    <CapacityProvider client={client} projectId="p" revision={0} canEdit>
      <PageTitle title="卡片" />
    </CapacityProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: /CI —/u }));
  let tooltip = await screen.findByRole("tooltip");
  expect(within(tooltip).getByRole("alert").textContent).toBe(
    "合并检查配置无效，容量信息不完整",
  );
  expect(within(tooltip).queryByText("ci-test")).toBeNull();
  view.rerender(
    <CapacityProvider client={client} projectId="p" revision={1} canEdit>
      <PageTitle title="卡片" />
    </CapacityProvider>,
  );
  await screen.findByRole("button", { name: /CI 未启用/u });
  tooltip = await screen.findByRole("tooltip");
  expect(within(tooltip).getByText("未启用合并检查")).toBeTruthy();
  // No machine has resources or CI slots: no resource column.
  expect(within(tooltip).getAllByRole("columnheader")).toHaveLength(3);
});

test("unknown limits, invalid CI and failed refreshes never look like idle capacity", async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce({
      ...capacity,
      agents: [{ ...capacity.agents[0], limit: 0 }],
      merge_config_invalid: true,
    })
    .mockRejectedValue(new Error("offline"));
  const client = fakeClient({ executionCapacity: read });
  const view = render(
    <CapacityProvider client={client} projectId="p" revision={0} canEdit>
      <PageTitle title="设置" />
    </CapacityProvider>,
  );
  await screen.findByRole("button", { name: /Agent 3\/— · 排队 2 · CI —/u });
  view.rerender(
    <CapacityProvider client={client} projectId="p" revision={1} canEdit>
      <PageTitle title="设置" />
    </CapacityProvider>,
  );
  const button = await screen.findByRole("button", { name: /容量读取失败/u });
  fireEvent.focus(button);
  expect((await screen.findByRole("tooltip")).textContent).toContain("offline");
  expect(screen.queryByText(/Agent 0\/0/u)).toBeNull();
});

test("unauthenticated and Agent-only clients never reach capacity editing", async () => {
  window.location.hash = "#/p/p-1/settings";
  const read = vi.fn();
  const write = vi.fn();
  render(
    <App
      client={fakeClient({
        session: async () => ({
          authenticated: false,
          password_configured: true,
        }),
        executionCapacity: read,
        setRunLimit: write,
      })}
    />,
  );
  await screen.findByRole("button", { name: "登录" });
  expect(screen.queryByRole("spinbutton")).toBeNull();
  expect(read).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});

test.each(["github", "ssh", "local"] as const)(
  "C-316 capacity distinguishes %s admission from configured target capacity",
  async (executor_type) => {
    const data = {
      ...capacity,
      merge_checks: [
        {
          machine_id: "fixture-target",
          executor_type,
          target_limit: 3,
          limit: executor_type === "github" ? 3 : 1,
          running: 1,
          queued: 2,
        },
      ],
    };
    render(
      <CapacityProvider
        client={fakeClient({ executionCapacity: async () => data })}
        projectId="p-1"
        revision={0}
        canEdit={false}
      >
        <PageTitle title="执行视图" />
      </CapacityProvider>,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /查看并发与容量详情/u }),
    );
    // C-824: the admission rule per executor moved to the help page; the
    // row shows the admission limit the scheduler compares with.
    const tooltip = screen.getByRole("tooltip");
    expect(rowCells(tooltip, "fixture-target")).toEqual([
      "fixture-target",
      `1/${data.merge_checks[0]?.limit}`,
      "2",
      "",
    ]);
    expect(tooltip.textContent).not.toMatch(/同项目可并行|每项目一个检查/u);
    const help =
      findHelpDocument(helpDocuments, CAPACITY_HELP_SLUG)?.source ?? "";
    expect(help).toContain(
      executor_type === "github"
        ? "GitHub：同项目可并行"
        : executor_type === "ssh"
          ? "SSH：每个项目同时一个检查"
          : "本机：每个项目同时一个检查",
    );
  },
);

type Seen = { stale: boolean; pending: boolean; error: boolean };
/** Records what the shared capacity read reports on every render. */
function StaleProbe({
  seen,
  onReload,
}: {
  seen: Seen[];
  onReload: (reload: (() => void) | undefined) => void;
}) {
  const c = useCapacity();
  onReload(c?.reload);
  if (c) seen.push({ stale: c.stale, pending: c.pending, error: !!c.error });
  return <span>{c?.stale ? "stale" : "usable"}</span>;
}

test("C-512 (Q-1017): stale holds from a failed read until a later read succeeds, not while one is in flight", async () => {
  let fail = false;
  let gate: Promise<void> | undefined;
  const client = fakeClient({
    executionCapacity: async () => {
      if (gate) await gate;
      if (fail) throw new Error("合成容量读取失败");
      return capacity;
    },
  });
  const seen: Seen[] = [];
  let reload: (() => void) | undefined;
  const probe = (
    <StaleProbe
      seen={seen}
      onReload={(r) => {
        reload = r;
      }}
    />
  );
  const at = (revision: number) => (
    <CapacityProvider
      client={client}
      projectId="p-1"
      revision={revision}
      canEdit
    >
      {probe}
    </CapacityProvider>
  );
  const view = render(at(0));
  expect(await screen.findByText("usable")).toBeTruthy();
  // A background refresh without an earlier failure is never stale.
  let held = Promise.withResolvers<void>();
  gate = held.promise;
  seen.length = 0;
  view.rerender(at(1));
  await waitFor(() => expect(seen.some((s) => s.pending)).toBe(true));
  expect(seen.every((s) => !s.stale)).toBe(true);
  gate = undefined;
  await act(async () => held.resolve());
  // A failure makes it stale.
  fail = true;
  view.rerender(at(2));
  expect(await screen.findByText("stale")).toBeTruthy();
  // The retry in flight keeps it stale (the error is cleared meanwhile).
  fail = false;
  held = Promise.withResolvers<void>();
  gate = held.promise;
  seen.length = 0;
  act(() => reload?.());
  await waitFor(() =>
    expect(seen.some((s) => s.pending && !s.error)).toBe(true),
  );
  expect(seen.filter((s) => s.pending).every((s) => s.stale)).toBe(true);
  // A completed read without error makes it usable again.
  gate = undefined;
  await act(async () => held.resolve());
  expect(await screen.findByText("usable")).toBeTruthy();
});
