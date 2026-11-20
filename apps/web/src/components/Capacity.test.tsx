// @vitest-environment jsdom
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
import type { ExecutionCapacity } from "../api.js";
import { fakeClient } from "../testing/fixtures.js";
import { CapacityProvider, useCapacity } from "./Capacity.js";
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
    fireEvent.click(screen.getByRole("button", { name: "并发与容量" }));
    await screen.findByRole("heading", { name: "并发与容量" });
    expect(screen.getAllByRole("spinbutton")).toHaveLength(2);
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
  expect(tooltip.textContent).toContain("第二台工作机 · Agent");
  expect(tooltip.textContent).toContain("全部 5 · 非常驻 3 / 上限 6 / 排队 2");
  expect(tooltip.textContent).toContain("全部 1 · 非常驻 1 / 上限 4 / 排队 0");
  expect(tooltip.textContent).toContain("本机 CI 另占 2 个 Agent 名额");
  expect(tooltip.textContent).toContain(
    "常驻 PM（Office / Ops）和主机运维不占额度",
  );
  expect(tooltip.textContent).toContain("运行中 1 / 上限 3 / 排队 4");
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
    expect(
      screen.getByText(
        executor_type === "github"
          ? /GitHub · 同项目可并行/u
          : executor_type === "ssh"
            ? /SSH · 每项目一个检查，目标配置上限 3/u
            : /本机 · 每项目一个检查/u,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        `运行中 1 / 上限 ${data.merge_checks[0]?.limit} / 排队 2`,
      ),
    ).toBeTruthy();
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
