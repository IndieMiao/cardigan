// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
  ApiError,
  type CardiganClient,
  type ExecutionAssignment,
  type RunView,
} from "../api.js";
import { fakeClient } from "../testing/fixtures.js";
import { ExecutionPage } from "../views/ExecutionPage.js";
import { patchFiles } from "./AssignmentOps.js";

// C-703: 启动会话 / 重启会话 / 停止执行… / 查看改动 in the execution drawer.
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverMock);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

const base: ExecutionAssignment = {
  id: "A-1",
  role_id: "coder",
  role_version: 2,
  status: "active",
  runtime_state: "idle",
  machine_id: "local",
  standing_mode: null,
  card_id: "C-1",
  card_status: "in_progress",
  card_title: "Fixture card",
  work_item_id: "W-1",
  worktree_path: "/fixture/worktree",
  branch: "agent/work",
  session_ref: "session-fixture",
  runtime_ref: { terminal_ref: "terminal-fixture", runtime_machine: "local" },
  last_mcp_activity_at: null,
  cursors: [],
  employee: { id: "E-1", name: "李逵" } as never,
};
const finished: RunView = {
  id: "R-10",
  assignment_id: "A-1",
  status: "completed",
  kind: "initial",
  model: "fixture-model",
  role_version: 2,
  agent_cli_version: "1.0",
  summary: "done",
};

async function open(
  a: ExecutionAssignment,
  overrides: Partial<CardiganClient>,
  runs: RunView[] = [finished],
) {
  window.location.hash = "#/p/p-1/execution?view=all";
  render(
    <ExecutionPage
      client={fakeClient({
        execution: async () => ({ assignments: [a], runs, machines: [] }),
        ...overrides,
      })}
      projectId="p-1"
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "查看 A-1 详情" }));
  await screen.findByRole("dialog", { name: /A-1/ });
  return screen.getByRole("region", { name: "当前" });
}

test("启动会话 writes only on click, shows progress and the result, and retries a failure with the same key", async () => {
  let fail = true;
  let release: () => void = () => undefined;
  const startAssignment = vi.fn(
    async (_p: string, _a: string, _restart: boolean, _key: string) => {
      if (fail) {
        fail = false;
        throw new ApiError(
          409,
          "illegal_transition",
          "卡片已暂停，请先解除暂停",
        );
      }
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { run_id: "R-11" };
    },
  );
  const current = await open(base, { startAssignment });
  expect(startAssignment).not.toHaveBeenCalled();
  const start = within(current).getByRole("button", { name: "启动会话" });
  expect(start.classList.contains("ui-button-emphasis")).toBe(true);
  fireEvent.click(start);
  // The server's reason, with a retry.
  const alert = await within(current).findByRole("alert");
  expect(alert.textContent).toContain("卡片已暂停，请先解除暂停");
  fireEvent.click(within(alert).getByRole("button", { name: "重试" }));
  await waitFor(() =>
    expect(
      within(current).getByRole("button", { name: "正在启动…" }),
    ).toHaveProperty("disabled", true),
  );
  expect(startAssignment).toHaveBeenCalledTimes(2);
  const [first, second] = startAssignment.mock.calls;
  expect(first?.slice(0, 3)).toEqual(["p-1", "A-1", false]);
  expect(second?.[3]).toBe(first?.[3]);
  release();
  await waitFor(() =>
    expect(current.textContent).toContain("已启动 A-1：R-11 等待派发"),
  );
  // A later start is a new request.
  fireEvent.click(within(current).getByRole("button", { name: "启动会话" }));
  await waitFor(() => expect(startAssignment).toHaveBeenCalledTimes(3));
  release();
  expect(startAssignment.mock.calls[2]?.[3]).not.toBe(first?.[3]);
});

test("停止执行… confirms in a dialog: 返回 writes nothing; a failure stays with its reason; success closes it", async () => {
  const running = { ...base, runtime_state: "running" };
  const stopAssignment = vi
    .fn<CardiganClient["stopAssignment"]>()
    .mockRejectedValueOnce(
      new ApiError(
        409,
        "stop_failed",
        "未能确认 A-1 的原会话已退出：原终端仍在运行。",
      ),
    )
    .mockResolvedValueOnce({ released: true, aborted: true, held: false });
  const current = await open(running, { stopAssignment }, [
    { ...finished, id: "R-12", status: "running" },
  ]);
  const trigger = within(current).getByRole("button", { name: "停止执行…" });
  trigger.focus();
  fireEvent.click(trigger);
  let dialog = await screen.findByRole("dialog", { name: /停止执行/ });
  expect(dialog.textContent).toContain("R-12");
  expect(dialog.textContent).toContain("李逵");
  expect(dialog.textContent).toContain("C-1");
  expect(dialog.textContent).toContain("终端关闭，当前执行记为已取消");
  fireEvent.click(within(dialog).getByRole("button", { name: "返回" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: /停止执行/ })).toBeNull(),
  );
  expect(stopAssignment).not.toHaveBeenCalled();
  await waitFor(() => expect(document.activeElement).toBe(trigger));

  fireEvent.click(trigger);
  dialog = await screen.findByRole("dialog", { name: /停止执行/ });
  const confirm = within(dialog).getByRole("button", {
    name: "停止并取消执行",
  });
  expect(confirm.classList.contains("ui-button-destructive")).toBe(true);
  fireEvent.click(confirm);
  const alert = await within(dialog).findByRole("alert");
  expect(alert.textContent).toContain("原终端仍在运行");
  expect(screen.getByRole("dialog", { name: /停止执行/ })).toBe(dialog);
  fireEvent.click(
    within(dialog).getByRole("button", { name: "停止并取消执行" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: /停止执行/ })).toBeNull(),
  );
  expect(stopAssignment).toHaveBeenCalledTimes(2);
  expect(stopAssignment.mock.calls[1]?.[2]).toBe(
    stopAssignment.mock.calls[0]?.[2],
  );
  await waitFor(() =>
    expect(current.textContent).toContain(
      "已停止 A-1：终端已释放，当前执行已取消",
    ),
  );
});

test("while stopping, the dialog cannot be dismissed", async () => {
  let finish: () => void = () => undefined;
  const stopAssignment = vi.fn(
    () =>
      new Promise<{ released: boolean; aborted: boolean }>((resolve) => {
        finish = () => resolve({ released: true, aborted: false });
      }),
  );
  const current = await open(
    { ...base, runtime_state: "running" },
    { stopAssignment },
    [{ ...finished, status: "running" }],
  );
  fireEvent.click(within(current).getByRole("button", { name: "停止执行…" }));
  const dialog = await screen.findByRole("dialog", { name: /停止执行/ });
  fireEvent.click(
    within(dialog).getByRole("button", { name: "停止并取消执行" }),
  );
  const stopping = await within(dialog).findByRole("button", {
    name: "正在停止…",
  });
  expect(stopping).toHaveProperty("disabled", true);
  expect(within(dialog).getByRole("button", { name: "返回" })).toHaveProperty(
    "disabled",
    true,
  );
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.getByRole("dialog", { name: /停止执行/ })).toBe(dialog);
  finish();
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: /停止执行/ })).toBeNull(),
  );
  expect(current.textContent).toContain("已停止 A-1：终端已释放");
});

test("a lost session restarts in place and the menu offers the stop last", async () => {
  const startAssignment = vi.fn(async () => ({ run_id: "R-13" }));
  const current = await open(
    { ...base, runtime_state: "lost" },
    { startAssignment },
  );
  expect(current.hasAttribute("data-mine")).toBe(true);
  fireEvent.click(within(current).getByRole("button", { name: "重启会话" }));
  await waitFor(() =>
    expect(current.textContent).toContain("已重启 A-1：R-13 等待派发"),
  );
  expect(startAssignment).toHaveBeenCalledWith(
    "p-1",
    "A-1",
    true,
    expect.any(String),
  );
});

test("a standing Assignment keeps the copied commands, without start or stop buttons", async () => {
  const current = await open(
    {
      ...base,
      work_item_id: null,
      card_id: null,
      card_status: null,
      standing_mode: "ops",
      role_id: "pm",
    },
    {},
    [],
  );
  expect(
    within(current).getByRole("button", { name: "复制启动命令" }),
  ).toBeTruthy();
  expect(
    within(current).queryByRole("button", { name: "启动会话" }),
  ).toBeNull();
  expect(
    within(current).queryByRole("button", { name: "查看改动" }),
  ).toBeNull();
});

test("查看改动 reads the changes once, folds them per file and lists untracked files", async () => {
  const assignmentDiff = vi
    .fn<CardiganClient["assignmentDiff"]>()
    .mockRejectedValueOnce(
      new ApiError(409, "unavailable", "worker 暂时无法连接"),
    )
    .mockResolvedValue({
      worktree_path: "/fixture/worktree",
      branch: "agent/work",
      head_sha: "abcdef0123456789",
      tracked: ["src/a.ts", "src/b.ts"],
      untracked: ["notes.md"],
      reachable: false,
      patch: [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1 +1,2 @@",
        "-old",
        "+new",
        "+more",
        "diff --git a/src/b.ts b/src/b.ts",
        "@@ -1 +1 @@",
        "-x",
        "+y",
        "",
      ].join("\n"),
      truncated: true,
    });
  const current = await open(base, { assignmentDiff });
  expect(assignmentDiff).not.toHaveBeenCalled();
  fireEvent.click(within(current).getByRole("button", { name: "查看改动" }));
  const sheet = await screen.findByRole("dialog", { name: /改动/ });
  const alert = await within(sheet).findByRole("alert");
  expect(alert.textContent).toContain("worker 暂时无法连接");
  fireEvent.click(within(alert).getByRole("button", { name: "重试" }));
  const tracked = await within(sheet).findByRole("list", {
    name: "已跟踪改动",
  });
  expect(sheet.textContent).toContain("agent/work");
  expect(sheet.textContent).toContain("abcdef012345");
  expect(sheet.textContent).toContain("不在中心仓库");
  expect(sheet.textContent).toContain("只显示前 512 KB");
  const rows = within(tracked).getAllByRole("button");
  expect(rows.map((row) => row.textContent)).toEqual([
    "src/a.ts+2 −1",
    "src/b.ts+1 −1",
  ]);
  expect(rows[0]?.getAttribute("aria-expanded")).toBe("false");
  expect(sheet.querySelector("pre")).toBeNull();
  fireEvent.click(rows[0] as HTMLElement);
  const patch = within(sheet).getByLabelText("src/a.ts 的改动");
  expect(patch.textContent).toContain("+new");
  expect(patch.textContent).not.toContain("+y");
  expect(
    within(within(sheet).getByRole("list", { name: "未跟踪文件" })).getByText(
      "notes.md",
    ),
  ).toBeTruthy();
  expect(assignmentDiff).toHaveBeenCalledTimes(2);
  fireEvent.click(within(sheet).getByRole("button", { name: "关闭改动" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: /改动/ })).toBeNull(),
  );
  // Closed, the focus is back on the button that opened it.
  await waitFor(() =>
    expect(document.activeElement).toBe(
      within(current).getByRole("button", { name: "查看改动" }),
    ),
  );
});

test("the stop dialog opened from ⋯ gives the focus back to ⋯; without a current Run it says only the terminal closes", async () => {
  const stopAssignment = vi.fn<CardiganClient["stopAssignment"]>();
  await open({ ...base, runtime_state: "lost" }, { stopAssignment });
  const more = screen.getByRole("button", { name: "更多执行操作" });
  fireEvent.keyDown(more, { key: "ArrowDown" });
  const menu = await screen.findByRole("menu", { name: "更多执行操作" });
  fireEvent.click(
    within(menu).getByRole("menuitem", { name: "停止并取消执行…" }),
  );
  const dialog = await screen.findByRole("dialog", { name: /停止执行/ });
  expect(within(dialog).getByText("终端关闭")).toBeTruthy();
  expect(dialog.textContent).not.toContain("当前执行记为已取消");
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: /停止执行/ })).toBeNull(),
  );
  await waitFor(() => expect(document.activeElement).toBe(more));
  expect(stopAssignment).not.toHaveBeenCalled();
});

test("patchFiles splits a patch per file and keeps a path with spaces", () => {
  expect(
    patchFiles(
      "diff --git a/a b.ts b/a b.ts\n+1\ndiff --git a/c.ts b/c.ts\n-2\n",
    ),
  ).toEqual([
    { path: "a b.ts", lines: ["diff --git a/a b.ts b/a b.ts", "+1"] },
    { path: "c.ts", lines: ["diff --git a/c.ts b/c.ts", "-2"] },
  ]);
  expect(patchFiles("")).toEqual([]);
  // git quotes a non-ASCII path with octal UTF-8 bytes (core.quotepath).
  expect(
    patchFiles(
      'diff --git "a/docs/\\350\\256\\241\\345\\210\\222.md" "b/docs/\\350\\256\\241\\345\\210\\222.md"\n+x\n',
    ).map((file) => file.path),
  ).toEqual(["docs/计划.md"]);
  expect(
    patchFiles('diff --git "a/q\\"t.ts" "b/q\\"t.ts"\n').map((f) => f.path),
  ).toEqual(['q"t.ts']);
});

test("panel facts end with the dot, so a wrapped line never starts with it", async () => {
  const current = await open(
    { ...base, last_mcp_activity_at: "2026-01-01T00:00:00Z" },
    {},
  );
  const facts = [
    ...current.querySelectorAll("h2 + div > span"),
  ] as HTMLElement[];
  expect(facts.length).toBe(2);
  expect(facts[0]?.textContent?.endsWith("·")).toBe(true);
  expect(facts[1]?.textContent?.startsWith("·")).toBe(false);
  expect(facts[1]?.textContent).toContain("空闲");
  // The dot sits with the last piece of its fact, which never wraps apart.
  const dot = facts[0]?.lastElementChild?.lastElementChild;
  expect(dot?.textContent).toBe("·");
  expect(dot?.getAttribute("aria-hidden")).toBe("true");
});
