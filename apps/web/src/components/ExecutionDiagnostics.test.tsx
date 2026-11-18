// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { CardiganClient } from "../api.js";
import { fakeClient } from "../testing/fixtures.js";
import {
  ExecutionDiagnosticsAlert,
  ExecutionDiagnosticsStatus,
  useExecutionDiagnostics,
} from "./ExecutionDiagnostics.js";

afterEach(cleanup);

/** Mirrors ExecutionPage: header status and the attention row share one read. */
function Harness({
  client,
  onOpen = () => {},
}: {
  client: CardiganClient;
  onOpen?: (id: string, trigger: HTMLElement) => void;
}) {
  const diagnostics = useExecutionDiagnostics(client, "fixture");
  return (
    <>
      <header>
        <ExecutionDiagnosticsStatus diagnostics={diagnostics} />
      </header>
      <ExecutionDiagnosticsAlert diagnostics={diagnostics} onOpen={onOpen} />
    </>
  );
}
const openStatus = async (state: string) => {
  fireEvent.click(
    await screen.findByRole("button", { name: `启动与运行诊断：${state}` }),
  );
  return screen.findByRole("dialog", { name: "启动与运行诊断" });
};

test("configuration, waiting, unknown and exit remain separate with explicit recovery paths", async () => {
  const onOpen = vi.fn();
  const client = fakeClient({
    executionDiagnostics: async () => ({
      configuration: [
        {
          profile: "synthetic-long-profile".repeat(3),
          code: "codex_approval",
          message: "审批策略可能等待交互确认；请由主机管理员核对生效配置。",
        },
      ],
      sessions: [
        "waiting_confirmation",
        "waiting_interaction",
        "runtime_exited",
        "unknown",
      ].map((cause, i) => ({
        assignment_id: `A-${i + 1}`,
        cause,
        action: "wait",
        evidence: [],
      })),
    }),
  });
  render(<Harness client={client} onOpen={onOpen} />);
  const toggle = await screen.findByRole("button", {
    name: "启动与运行诊断（5）",
  });
  // Warnings own one compact row; the header status gives way to it.
  expect(
    screen.queryByRole("button", { name: /^启动与运行诊断：/u }),
  ).toBeNull();
  expect(
    screen.getAllByRole("region", { name: "启动与运行诊断" }),
  ).toHaveLength(1);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  const body = document.getElementById(
    toggle.getAttribute("aria-controls") ?? "",
  );
  expect(body?.hidden).toBe(true);
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(body?.hidden).toBe(false);
  expect(screen.getByText("等待交互确认")).toBeTruthy();
  expect(screen.getByText("运行原因未知")).toBeTruthy();
  expect(screen.getByText(/停止已完成的会话可手工恢复/)).toBeTruthy();
  expect(screen.getByText(/synthetic-long-profile/)).toBeTruthy();
  expect(screen.queryByText("线路连接失败")).toBeNull();
  const button = screen.getByRole("button", { name: "查看 A-1" });
  fireEvent.click(button);
  expect(onOpen).toHaveBeenCalledWith("A-1", button);
  fireEvent.click(toggle);
  expect(body?.hidden).toBe(true);
});

test("without warnings there is no separate block, only the header status", async () => {
  render(
    <Harness
      client={fakeClient({
        executionDiagnostics: async () => ({
          available: true,
          configuration: [],
          sessions: [],
        }),
      })}
    />,
  );
  const panel = await openStatus("无告警");
  expect(panel.textContent).toContain("没有告警");
  expect(screen.queryByRole("region", { name: "启动与运行诊断" })).toBeNull();
  fireEvent.keyDown(panel, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("checking stays compact and its refresh cannot fire twice", async () => {
  const read = vi.fn(() => new Promise<never>(() => {}));
  render(<Harness client={fakeClient({ executionDiagnostics: read })} />);
  const panel = await openStatus("检查中");
  const refresh = screen.getByRole("button", { name: "检查中" });
  expect(panel.contains(refresh)).toBe(true);
  expect(refresh.getAttribute("aria-disabled")).toBe("true");
  refresh.focus();
  fireEvent.click(refresh);
  expect(document.activeElement).toBe(refresh);
  expect(screen.queryByRole("region", { name: "启动与运行诊断" })).toBeNull();
  expect(read).toHaveBeenCalledTimes(1);
});

test("unavailable observations are never shown as healthy; refresh retries", async () => {
  const read = vi
    .fn()
    .mockRejectedValueOnce(new Error("synthetic-secret"))
    .mockResolvedValue({ configuration: [], sessions: [] });
  render(<Harness client={fakeClient({ executionDiagnostics: read })} />);
  const panel = await openStatus("不可用");
  expect(panel.textContent).toContain("诊断不可用");
  expect(panel.textContent).not.toContain("没有告警");
  expect(screen.queryByText(/synthetic-secret/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "刷新诊断" }));
  await screen.findByRole("button", { name: "启动与运行诊断：无告警" });
  expect(read).toHaveBeenCalledTimes(2);
});

test("a pending refresh never shows the previous result as current", async () => {
  let resolve: (value: unknown) => void = () => {};
  const read = vi
    .fn()
    .mockResolvedValueOnce({ configuration: [], sessions: [] })
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
  render(<Harness client={fakeClient({ executionDiagnostics: read })} />);
  const panel = await openStatus("无告警");
  fireEvent.click(screen.getByRole("button", { name: "刷新诊断" }));
  await screen.findByRole("button", { name: "启动与运行诊断：检查中" });
  expect(panel.textContent).toContain("检查中");
  expect(panel.textContent).not.toContain("没有告警");
  resolve({ configuration: [], sessions: [] });
  await screen.findByRole("button", { name: "启动与运行诊断：无告警" });
});

test("a refresh keeps existing warnings in place until the new result arrives", async () => {
  let resolve: (value: unknown) => void = () => {};
  const warning = {
    configuration: [
      { profile: "fixture", code: "codex_approval", message: "审批策略待核对" },
    ],
    sessions: [],
  };
  const read = vi
    .fn()
    .mockResolvedValueOnce(warning)
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
  render(<Harness client={fakeClient({ executionDiagnostics: read })} />);
  await screen.findByRole("button", { name: "启动与运行诊断（1）" });
  fireEvent.click(screen.getByRole("button", { name: "刷新诊断" }));
  expect(
    screen.getByRole("button", { name: "启动与运行诊断（1）" }),
  ).toBeTruthy();
  expect(
    screen
      .getByRole("button", { name: "检查中" })
      .getAttribute("aria-disabled"),
  ).toBe("true");
  resolve({ configuration: [], sessions: [] });
  await screen.findByRole("button", { name: "启动与运行诊断：无告警" });
  expect(screen.queryByRole("region", { name: "启动与运行诊断" })).toBeNull();
});

test("expired runtime evidence disappears while configuration warnings remain", async () => {
  render(
    <Harness
      client={fakeClient({
        executionDiagnostics: async () => ({
          expires_at: "2000-01-01T00:00:00Z",
          configuration: [
            {
              profile: "fixture",
              code: "codex_approval",
              message: "审批策略待核对",
            },
          ],
          sessions: [
            {
              assignment_id: "A-1",
              cause: "waiting_confirmation",
              action: "wait",
              evidence: [],
            },
          ],
        }),
      })}
    />,
  );
  await screen.findByText("运行诊断已过期，请刷新");
  expect(
    screen.getByRole("button", { name: "启动与运行诊断（1）" }),
  ).toBeTruthy();
  expect(screen.queryByText("等待交互确认")).toBeNull();
  expect(screen.getByText("审批策略待核对")).toBeTruthy();
});

test("expired results without remaining warnings stay in the header as stale", async () => {
  render(
    <Harness
      client={fakeClient({
        executionDiagnostics: async () => ({
          expires_at: "2000-01-01T00:00:00Z",
          configuration: [],
          sessions: [
            {
              assignment_id: "A-1",
              cause: "waiting_confirmation",
              action: "wait",
              evidence: [],
            },
          ],
        }),
      })}
    />,
  );
  const panel = await openStatus("已过期");
  expect(panel.textContent).toContain("运行诊断已过期，请刷新");
  expect(panel.textContent).not.toContain("没有告警");
});

test("an unconfigured reader never reports no warnings as a successful observation", async () => {
  render(
    <Harness
      client={fakeClient({
        executionDiagnostics: async () => ({
          available: false,
          configuration: [],
          sessions: [],
        }),
      })}
    />,
  );
  const panel = await openStatus("不可用");
  expect(panel.textContent).toContain("诊断不可用");
  expect(screen.queryByText("没有告警")).toBeNull();
});

test("legacy or malformed successful responses do not crash the execution page", async () => {
  render(
    <Harness
      client={fakeClient({
        executionDiagnostics: async () =>
          ({ assignments: [], runs: [] }) as never,
      })}
    />,
  );
  const panel = await openStatus("不可用");
  expect(panel.textContent).toContain("诊断不可用");
  expect(screen.queryByText("没有告警")).toBeNull();
});

test("clients without a diagnostics reader render nothing", () => {
  const client = fakeClient({});
  delete (client as { executionDiagnostics?: unknown }).executionDiagnostics;
  const view = render(<Harness client={client} />);
  expect(view.container.textContent).toBe("");
});

const warningResult = {
  configuration: [
    { profile: "fixture", code: "codex_approval", message: "审批策略待核对" },
  ],
  sessions: [],
};
const emptyResult = { configuration: [], sessions: [] };
/** First read resolves immediately, the refresh waits for the returned resolver. */
function pendingSecondRead(first: unknown) {
  const control: { resolve: (value: unknown) => void } = { resolve: () => {} };
  const read = vi
    .fn()
    .mockResolvedValueOnce(first)
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          control.resolve = r;
        }),
    );
  return { read, control };
}

test("keyboard refresh from the header hands focus to the new attention row", async () => {
  const { read, control } = pendingSecondRead(emptyResult);
  render(<Harness client={fakeClient({ executionDiagnostics: read })} />);
  await openStatus("无告警");
  const refresh = screen.getByRole("button", { name: "刷新诊断" });
  refresh.focus();
  fireEvent.click(refresh);
  // Pending keeps the keyboard position and blocks a second request.
  expect(document.activeElement).toBe(refresh);
  fireEvent.click(refresh);
  expect(read).toHaveBeenCalledTimes(2);
  control.resolve(warningResult);
  const toggle = await screen.findByRole("button", {
    name: "启动与运行诊断（1）",
  });
  await waitFor(() => expect(document.activeElement).toBe(toggle));
  expect(
    screen.queryByRole("button", { name: /^启动与运行诊断：/u }),
  ).toBeNull();
});

test("clearing warnings from the attention row hands focus back to the header status", async () => {
  const { read, control } = pendingSecondRead(warningResult);
  render(<Harness client={fakeClient({ executionDiagnostics: read })} />);
  await screen.findByRole("button", { name: "启动与运行诊断（1）" });
  const refresh = screen.getByRole("button", { name: "刷新诊断" });
  refresh.focus();
  fireEvent.click(refresh);
  expect(document.activeElement).toBe(refresh);
  control.resolve(emptyResult);
  const status = await screen.findByRole("button", {
    name: "启动与运行诊断：无告警",
  });
  await waitFor(() => expect(document.activeElement).toBe(status));
  expect(screen.queryByRole("region", { name: "启动与运行诊断" })).toBeNull();
});

test("focus is not taken back after the user has moved elsewhere", async () => {
  const { read, control } = pendingSecondRead(emptyResult);
  render(
    <>
      <button type="button">其它控件</button>
      <Harness client={fakeClient({ executionDiagnostics: read })} />
    </>,
  );
  await openStatus("无告警");
  const refresh = screen.getByRole("button", { name: "刷新诊断" });
  refresh.focus();
  fireEvent.click(refresh);
  const other = screen.getByRole("button", { name: "其它控件" });
  fireEvent.pointerDown(other);
  other.focus();
  control.resolve(warningResult);
  await screen.findByRole("button", { name: "启动与运行诊断（1）" });
  expect(document.activeElement).toBe(other);
});

test("a pointer press outside before the swap leaves focus where the user put it", async () => {
  const { read, control } = pendingSecondRead(warningResult);
  render(<Harness client={fakeClient({ executionDiagnostics: read })} />);
  await screen.findByRole("button", { name: "启动与运行诊断（1）" });
  const refresh = screen.getByRole("button", { name: "刷新诊断" });
  refresh.focus();
  fireEvent.click(refresh);
  fireEvent.pointerDown(document.body);
  refresh.blur();
  control.resolve(emptyResult);
  await screen.findByRole("button", { name: "启动与运行诊断：无告警" });
  expect(document.activeElement).toBe(document.body);
});

test("initial warnings never steal focus on page load", async () => {
  render(
    <>
      <button type="button">其它控件</button>
      <Harness
        client={fakeClient({ executionDiagnostics: async () => warningResult })}
      />
    </>,
  );
  await screen.findByRole("button", { name: "启动与运行诊断（1）" });
  expect(document.activeElement).toBe(document.body);
});
