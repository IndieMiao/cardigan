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
import type { ExecutionCapacity } from "../api.js";
import { fakeClient } from "../testing/fixtures.js";
import { ExecutionCapacityPanel } from "./ExecutionCapacityPanel.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const agent: ExecutionCapacity["agents"][number] = {
  machine_id: "local",
  label: "Workstation",
  running: 5,
  limit: 6,
  max_limit: 16,
  queued: 2,
  merge_check_slots: 0,
};
const capacity: ExecutionCapacity = {
  agents: [agent],
  merge_checks: [{ machine_id: "test-ci", running: 1, limit: 3, queued: 4 }],
  merge_config_invalid: false,
};

test.each([16, 8, 24])(
  "the input enforces the server ceiling %s and permits its boundary",
  async (maximum) => {
    const setRunLimit = vi.fn(async () => {});
    render(
      <ExecutionCapacityPanel
        client={fakeClient({
          executionCapacity: async () => ({
            ...capacity,
            agents: [{ ...agent, label: "本机", max_limit: maximum }],
          }),
          setRunLimit,
        })}
        projectId="p"
        revision={0}
      />,
    );
    const input = await screen.findByRole<HTMLInputElement>("spinbutton", {
      name: "本机 Agent 并发上限",
    });
    expect(input.max).toBe(String(maximum));
    fireEvent.change(input, { target: { value: String(maximum + 1) } });
    expect(screen.getByText(`并发上限不能超过 ${maximum}。`)).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "保存" }).disabled,
    ).toBe(true);
    fireEvent.submit(screen.getByRole("form", { name: "本机 Agent 并发" }));
    expect(setRunLimit).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: String(maximum) } });
    expect(screen.queryByText(`并发上限不能超过 ${maximum}。`)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText("已保存，下一轮调度生效。");
    expect(setRunLimit).toHaveBeenCalledWith(
      "p",
      "local",
      maximum,
      expect.any(String),
    );
  },
);

test("distinct machine counts, human save, validation and a stable key after uncertain failure", async () => {
  let current = structuredClone(capacity);
  const setRunLimit = vi
    .fn()
    .mockRejectedValueOnce(new Error("network unavailable"))
    .mockImplementation(async (_p, _m, limit) => {
      current = { ...current, agents: [{ ...agent, limit }] };
    });
  const client = fakeClient({
    executionCapacity: async () => current,
    setRunLimit,
  });
  render(<ExecutionCapacityPanel client={client} projectId="p" revision={0} />);
  const input = await screen.findByRole("spinbutton", {
    name: "Workstation Agent 并发上限",
  });
  expect(screen.getByText("运行中 5 / 上限 6 / 排队 2")).toBeTruthy();
  expect(screen.getByText("运行中 1 / 上限 3 / 排队 4")).toBeTruthy();
  expect(screen.getByText("需要主机预置，找张良")).toBeTruthy();
  expect(screen.getAllByRole("spinbutton")).toHaveLength(1);
  fireEvent.change(input, { target: { value: "0" } });
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "保存" }).disabled,
  ).toBe(true);
  fireEvent.change(input, { target: { value: "2" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await screen.findByRole("alert");
  expect((input as HTMLInputElement).value).toBe("2");
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await screen.findByText("已保存，下一轮调度生效。");
  await screen.findByText("运行中 5 / 上限 2 / 排队 2");
  expect(setRunLimit.mock.calls).toEqual([
    ["p", "local", 2, expect.any(String)],
    ["p", "local", 2, setRunLimit.mock.calls[0]?.[3]],
  ]);
});

test("cross-project polling refreshes counts without overwriting the draft and stops on unmount", async () => {
  vi.useFakeTimers();
  let current = capacity;
  const read = vi.fn(async () => current);
  const view = render(
    <ExecutionCapacityPanel
      client={fakeClient({ executionCapacity: read })}
      projectId="p"
      revision={0}
    />,
  );
  await act(async () => {});
  const input = screen.getByRole<HTMLInputElement>("spinbutton");
  fireEvent.change(input, { target: { value: "9" } });
  current = {
    ...capacity,
    agents: [{ ...agent, running: 4, limit: 8 }],
  };
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(screen.getByText("运行中 4 / 上限 8 / 排队 2")).toBeTruthy();
  expect(input.value).toBe("9");
  view.unmount();
  await vi.advanceTimersByTimeAsync(10000);
  expect(read).toHaveBeenCalledTimes(2);
});

test("loading failures can retry and invalid host configuration cannot be saved", async () => {
  const read = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({
      ...capacity,
      agents: [{ ...agent, limit: 0 }],
      merge_config_invalid: true,
    });
  render(
    <ExecutionCapacityPanel
      client={fakeClient({ executionCapacity: read })}
      projectId="p"
      revision={0}
    />,
  );
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await waitFor(() =>
    expect(screen.getByRole<HTMLInputElement>("spinbutton").disabled).toBe(
      true,
    ),
  );
  expect(screen.getByText("合并检查配置无效，请联系主机管理员。")).toBeTruthy();
});
