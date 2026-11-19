// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { flowLayout, installLayoutStyles } from "../../test-support/layout.js";
import { App } from "../App.js";
import type {
  CardiganClient,
  ExecutionAssignment,
  NeedsPage,
  TemplateView,
} from "../api.js";
import { changeControl } from "../testing/controls.js";
import { card, fakeClient } from "../testing/fixtures.js";
import { fixtureNeedsCounts } from "../testing/needs-fixture.js";
import { ActivityPage } from "./ActivityPage.js";
import { CardDetailPage } from "./CardDetailPage.js";
import { CardListPage } from "./CardListPage.js";
import { DecisionHistoryPage } from "./DecisionHistoryPage.js";
import { ExecutionPage } from "./ExecutionPage.js";
import { NeedsYouPage } from "./NeedsYouPage.js";
import { SettingsPage } from "./SettingsPage.js";
import { SnapshotPage } from "./SnapshotPage.js";

let removeStyles: () => void;
beforeAll(() => {
  removeStyles = installLayoutStyles();
});
afterAll(() => removeStyles());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
  window.localStorage.clear();
});

const needs: NeedsPage = {
  decisions: [],
  incidents: [],
  human_actions: [
    {
      id: "H-1",
      card_id: "C-1",
      why: "检查发布结果",
      instructions: "查看发布结果后回报。",
      expected_return: "检查结果",
      waited_ms: 0,
      due: null,
      blocked_work_items: [],
    },
  ],
};
const assignment: ExecutionAssignment = {
  id: "A-1",
  role_id: "coder",
  role_version: 1,
  status: "active",
  runtime_state: "idle",
  machine_id: "local",
  standing_mode: null,
  card_id: "C-1",
  card_status: "in_progress",
  work_item_id: "W-1",
  worktree_path: null,
  branch: null,
  session_ref: null,
  runtime_ref: { terminal_ref: "fixture", runtime_machine: "local" },
  last_mcp_activity_at: null,
  cursors: [],
};
const template: TemplateView = {
  id: "general",
  title: "通用任务",
  description: "记录结果",
  requires_repo: false,
  merge: "none",
  require_acceptance_criteria: false,
  work_items: [],
  primary_work_item_key: null,
  completion: { mode: "human_mark_done" },
  version: 1,
  builtin: true,
  status: "active",
};
const defaults = fakeClient();
const fixture = fakeClient({
  needsYou: async () => needs,
  execution: async () => ({
    assignments: [assignment],
    runs: [],
    machines: [],
  }),
  snapshot: async () => ({
    ...(await defaults.snapshot("p-1")),
    cards: [card],
    in_progress: [card],
  }),
  roles: async () => ({
    ...(await defaults.roles("p-1")),
    roles: [
      {
        role_id: "coder",
        display_name: "开发",
        kind: "produce",
        status: "active",
        version: 1,
        harness: "codex",
        launch_profile_ref: "fixture",
      },
    ],
  }),
  templates: async () => ({ templates: [template] }),
});

type ReadMethod =
  | "needsYouSection"
  | "cards"
  | "card"
  | "execution"
  | "preferences"
  | "roles"
  | "templates"
  | "activity"
  | "decisionHistory"
  | "snapshot";
type Case = {
  name: string;
  method: ReadMethod;
  component: (props: {
    client: CardiganClient;
    projectId: string;
    revision: number;
  }) => ReactElement;
  target: string;
  tab?: string;
};
const cases: Case[] = [
  {
    name: "Needs You",
    method: "needsYouSection",
    component: (p) => <NeedsYouPage {...p} />,
    target: ".needs-group",
  },
  {
    name: "card list",
    method: "cards",
    component: (p) => <CardListPage {...p} view="list" />,
    target: "table",
  },
  {
    name: "board",
    method: "cards",
    component: (p) => <CardListPage {...p} view="board" />,
    target: ".board",
  },
  {
    name: "card detail",
    method: "card",
    component: (p) => <CardDetailPage {...p} cardId="C-1" />,
    target: ".card-header",
  },
  {
    name: "execution",
    method: "execution",
    component: (p) => <ExecutionPage {...p} />,
    target: "table",
  },
  {
    name: "preferences",
    method: "preferences",
    component: (p) => <SettingsPage {...p} />,
    target: "#preferences [data-settings-group]",
  },
  {
    name: "authorization",
    method: "preferences",
    component: (p) => <SettingsPage {...p} />,
    target: "#authorization",
    tab: "授权",
  },
  {
    name: "roles",
    method: "roles",
    component: (p) => <SettingsPage {...p} />,
    target: ".role-table",
    tab: "角色",
  },
  {
    name: "templates",
    method: "templates",
    component: (p) => <SettingsPage {...p} />,
    target: ".template-table-scroll",
    tab: "卡片模板",
  },
  {
    name: "activity",
    method: "activity",
    component: (p) => <ActivityPage {...p} />,
    target: ".empty",
  },
  {
    name: "decision history",
    method: "decisionHistory",
    component: (p) => <DecisionHistoryPage {...p} />,
    target: ".empty",
  },
  {
    name: "snapshot",
    method: "snapshot",
    component: (p) => <SnapshotPage {...p} />,
    target: ".card-table",
  },
];

// No synthetic offsetTop: compare real in-flow box structure and CSS before,
// during and after refresh. Also assert that the original content stays mounted.
test.each(cases)(
  "$name keeps its layout through background refresh, slow feedback, failure and manual retry",
  async ({ method, component, target, tab }) => {
    const result =
      method === "card"
        ? await fixture.card("p-1", "C-1")
        : method === "cards"
          ? await fixture.cards("p-1", "all")
          : method === "needsYouSection"
            ? await fixture.needsYouSection("p-1", "actions")
            : await fixture[method]("p-1");
    let request = Promise.withResolvers<typeof result>();
    const read = vi
      .fn()
      .mockResolvedValueOnce(result)
      .mockImplementation(() => request.promise);
    const client = fakeClient({ ...fixture, [method]: read });
    const props = { client, projectId: "p-1", revision: 0 };
    const view = render(component(props));
    if (tab)
      fireEvent.click(screen.getByRole("button", { name: tab, exact: true }));
    await act(async () => {});
    const content = view.container.querySelector(target) as Element;
    expect(content).not.toBeNull();
    const layout = () => {
      const boxes = flowLayout(view.container, content);
      // The dedicated card status slot intentionally changes its text. Keep
      // comparing the slot's sizing and every other in-flow box and content.
      return method === "cards"
        ? JSON.parse(
            JSON.stringify(boxes, (_key, box) =>
              box?.class?.split(" ").includes("cards-refresh-status")
                ? { ...box, content: [] }
                : box,
            ),
          )
        : boxes;
    };
    const before = layout();
    const stable = () => {
      expect(view.container.querySelector(target)).toBe(content);
      expect(layout()).toEqual(before);
    };
    vi.useFakeTimers();
    view.rerender(component({ ...props, revision: 1 }));
    if (method === "cards") {
      expect(read).toHaveBeenCalledTimes(1);
      changeControl(screen.getByLabelText("自动刷新"), {
        target: { value: "10000" },
      });
      await act(async () => vi.advanceTimersByTimeAsync(10000));
      expect(
        getComputedStyle(
          view.container.querySelector(".cards-refresh-status") as Element,
        ).minHeight,
      ).toBe("46px");
    }
    expect(read).toHaveBeenCalledTimes(2);
    const feedback = () =>
      document.querySelector(
        method === "cards"
          ? ".cards-refresh-status"
          : ".request-feedback-region",
      )?.textContent;
    const progress = method === "cards" ? "正在刷新" : "正在加载";
    stable();
    act(() => vi.advanceTimersByTime(999));
    if (method === "cards") expect(feedback()).toContain(progress);
    else expect(feedback()).toBe("");
    act(() => vi.advanceTimersByTime(1));
    expect(feedback()).toContain(progress);
    stable();
    await act(async () => request.resolve(result));
    stable();
    expect(feedback()).toBe("");
    request = Promise.withResolvers<typeof result>();
    view.rerender(component({ ...props, revision: 2 }));
    if (method === "cards") {
      expect(read).toHaveBeenCalledTimes(2);
      await act(async () => vi.advanceTimersByTimeAsync(10000));
    }
    await act(async () => request.reject(new Error("刷新失败")));
    expect(screen.getByRole("alert").textContent).toContain("刷新失败");
    stable();
    request = Promise.withResolvers<typeof result>();
    fireEvent.click(screen.getByRole("button", { name: "重试", exact: true }));
    expect(feedback()).toContain(progress);
    stable();
    await act(async () => request.resolve(result));
    stable();
  },
);

test("a real SSE invalidation in Workbench refreshes Needs You silently without moving its content", async () => {
  window.history.replaceState(null, "", "#/p/p-1/needs-you");
  let callbacks: Parameters<CardiganClient["subscribe"]>[1] | undefined;
  const request = Promise.withResolvers<NeedsPage>();
  const read = vi
    .fn()
    .mockResolvedValueOnce(needs)
    .mockImplementation(() => request.promise);
  const client = fakeClient({
    needsYouCounts: async () => fixtureNeedsCounts(needs),
    needsYouSection: read,
    subscribe: (_id, events) => {
      callbacks = events;
      events.status("live");
      return () => {};
    },
  });
  const view = render(<App client={client} />);
  await act(async () => {});
  const content = view.container.querySelector(".needs-group");
  expect(content).not.toBeNull();
  const before = flowLayout(view.container);
  vi.useFakeTimers();
  act(() => {
    callbacks?.change({ stream: "C-1", seq: 1 });
    vi.advanceTimersByTime(100);
  });
  expect(read).toHaveBeenCalledTimes(2);
  act(() => vi.advanceTimersByTime(500));
  expect(document.querySelector(".request-feedback-region")?.textContent).toBe(
    "",
  );
  expect(flowLayout(view.container)).toEqual(before);
  await act(async () => request.resolve(needs));
  expect(view.container.querySelector(".needs-group")).toBe(content);
  expect(flowLayout(view.container)).toEqual(before);
  act(() => vi.advanceTimersByTime(1000));
  expect(document.querySelector(".request-feedback-region")?.textContent).toBe(
    "",
  );
});

test("saving preferences reports progress, failure and success without moving the form", async () => {
  let request = Promise.withResolvers<void>();
  const save = vi.fn().mockImplementation(() => request.promise);
  const client = fakeClient({
    preferences: async () => ({
      auto_merge_after_minutes: 30,
      merge_gate_enabled: true,
    }),
    setPreferences: save,
  });
  const view = render(<SettingsPage client={client} projectId="p-1" />);
  await act(async () => {});
  const before = flowLayout(view.container);
  const group = view.container.querySelector("[data-settings-group]");
  const stable = () => {
    expect(view.container.querySelector("[data-settings-group]")).toBe(group);
    expect(flowLayout(view.container)).toEqual(before);
  };
  const minutes = screen.getByLabelText("等待分钟数");
  fireEvent.change(minutes, { target: { value: "45" } });
  stable();
  fireEvent.keyDown(minutes, { key: "Enter" });
  expect(screen.getByText("保存中…")).toBeTruthy();
  stable();
  await act(async () => request.reject(new Error("保存失败")));
  expect(screen.getByRole("alert").textContent).toContain("保存失败");
  stable();
  request = Promise.withResolvers<void>();
  fireEvent.keyDown(minutes, { key: "Enter" });
  expect(screen.getByText("保存中…")).toBeTruthy();
  await act(async () => request.resolve());
  expect(screen.getByText("偏好已保存")).toBeTruthy();
  expect(save.mock.calls[1]).toEqual(save.mock.calls[0]);
  stable();
});
