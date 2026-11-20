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
import type { CardiganClient, ExecutionCapacity } from "../api.js";
import { CapacityProvider, useCapacity } from "../components/Capacity.js";
import { RequestFeedback } from "../components/RequestFeedback.js";
import { fakeClient } from "../testing/fixtures.js";
import {
  AgentLimitReadOnly,
  AgentLimitRow,
  MergeCheckCapacity,
} from "./AgentLimit.js";
import { resetSettingWrites } from "./useSettingWrite.js";

/**
 * C-511: the row once on 并发与容量, now in each machine detail. Here it is
 * fed by the shared capacity read (also a tracked settings read), one row per
 * machine with the counts the panel showed, so its save rules stay covered.
 */
function Limits({
  client,
  projectId,
}: {
  client: CardiganClient;
  projectId: string;
}) {
  const resource = useCapacity();
  const data = resource?.error ? undefined : resource?.data;
  return (
    <>
      <RequestFeedback error={resource?.error} retry={resource?.reload} />
      {data?.agents.map((agent) =>
        resource?.canEdit ? (
          <AgentLimitRow
            key={`${projectId}:${agent.machine_id}`}
            client={client}
            projectId={projectId}
            machineId={agent.machine_id}
            label={agent.label}
            limit={agent.limit}
            max={agent.max_limit}
            mergeCheckSlots={agent.merge_check_slots}
            description={`全部 ${agent.total_running} · 非常驻 ${agent.running} / 上限 ${agent.limit || "不可用"} / 排队 ${agent.queued}`}
            source={data}
            saved={resource.reload}
          />
        ) : (
          <AgentLimitReadOnly key={agent.machine_id} limit={agent.limit} />
        ),
      )}
      <MergeCheckCapacity />
    </>
  );
}

function Settings({
  client,
  projectId,
  revision,
  canEdit = true,
}: {
  client: CardiganClient;
  projectId: string;
  revision: number;
  canEdit?: boolean;
}) {
  return (
    <CapacityProvider
      client={client}
      projectId={projectId}
      revision={revision}
      canEdit={canEdit}
    >
      <Limits client={client} projectId={projectId} />
    </CapacityProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetSettingWrites();
});
const agent: ExecutionCapacity["agents"][number] = {
  machine_id: "local",
  label: "Workstation",
  running: 5,
  total_running: 7,
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
      <Settings
        client={fakeClient({
          executionCapacity: async () => ({
            ...capacity,
            agents: [{ ...agent, label: "local", max_limit: maximum }],
          }),
          setRunLimit,
        })}
        projectId="p"
        revision={0}
      />,
    );
    const input = await screen.findByRole<HTMLInputElement>("spinbutton", {
      name: "local Agent 并发上限",
    });
    expect(input.max).toBe(String(maximum));
    fireEvent.change(input, { target: { value: String(maximum + 1) } });
    expect(screen.getByText(`并发上限不能超过 ${maximum}。`)).toBeTruthy();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    fireEvent.blur(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(setRunLimit).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: String(maximum) } });
    expect(screen.queryByText(`并发上限不能超过 ${maximum}。`)).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByText("并发上限已保存，下一轮调度生效");
    expect(setRunLimit).toHaveBeenCalledWith(
      "p",
      "local",
      maximum,
      expect.any(String),
    );
  },
);

test("distinct machine counts, instant save, validation and a stable key after uncertain failure", async () => {
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
  render(<Settings client={client} projectId="p" revision={0} />);
  const input = await screen.findByRole<HTMLInputElement>("spinbutton", {
    name: "Workstation Agent 并发上限",
  });
  expect(screen.getByText("全部 7 · 非常驻 5 / 上限 6 / 排队 2")).toBeTruthy();
  expect(screen.getByText("运行中 1 / 排队 4")).toBeTruthy();
  expect(screen.getByText("上限 3")).toBeTruthy();
  expect(screen.getByRole("button", { name: "test-ci说明" })).toBeTruthy();
  expect(screen.getAllByRole("spinbutton")).toHaveLength(1);
  // A blur without an edit writes nothing; 0 is not a valid limit.
  fireEvent.blur(input);
  fireEvent.change(input, { target: { value: "0" } });
  expect(screen.getByText("并发上限必须为正整数。")).toBeTruthy();
  fireEvent.blur(input);
  expect(setRunLimit).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: "2" } });
  fireEvent.blur(input);
  await screen.findByText(/未能保存“Workstation Agent 并发上限”/);
  expect(input.value).toBe("2");
  // The failed edit stays for another commit with the same key.
  fireEvent.keyDown(input, { key: "Enter" });
  await screen.findByText("并发上限已保存，下一轮调度生效");
  await screen.findByText("全部 7 · 非常驻 5 / 上限 2 / 排队 2");
  expect(setRunLimit.mock.calls).toEqual([
    ["p", "local", 2, expect.any(String)],
    ["p", "local", 2, setRunLimit.mock.calls[0]?.[3]],
  ]);
});

test("SSE revision refreshes counts without overwriting the draft, with no polling", async () => {
  vi.useFakeTimers();
  let current = capacity;
  const read = vi.fn(async () => current);
  const client = fakeClient({ executionCapacity: read });
  const view = render(<Settings client={client} projectId="p" revision={0} />);
  await act(async () => {});
  const input = screen.getByRole<HTMLInputElement>("spinbutton");
  fireEvent.change(input, { target: { value: "9" } });
  current = {
    ...capacity,
    agents: [{ ...agent, running: 4, total_running: 6, limit: 8 }],
  };
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(read).toHaveBeenCalledTimes(1);
  view.rerender(<Settings client={client} projectId="p" revision={1} />);
  await act(async () => {});
  expect(screen.getByText("全部 6 · 非常驻 4 / 上限 8 / 排队 2")).toBeTruthy();
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
    <Settings
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
  expect(screen.getByText("主机并发配置无效，请联系主机管理员")).toBeTruthy();
  expect(screen.getByText("合并检查配置无效，请联系主机管理员。")).toBeTruthy();
});

test("an unchanged value writes nothing and a read-only session has no write control", async () => {
  const setRunLimit = vi.fn();
  const client = fakeClient({
    executionCapacity: async () => capacity,
    setRunLimit,
  });
  const view = render(<Settings client={client} projectId="p" revision={0} />);
  const input = await screen.findByRole<HTMLInputElement>("spinbutton");
  fireEvent.change(input, { target: { value: "9" } });
  fireEvent.change(input, { target: { value: "6" } });
  fireEvent.blur(input);
  expect(setRunLimit).not.toHaveBeenCalled();
  view.rerender(
    <Settings client={client} projectId="p" revision={0} canEdit={false} />,
  );
  expect(screen.queryByRole("spinbutton")).toBeNull();
  expect(screen.getByText("上限 6")).toBeTruthy();
  expect(screen.getByText("仅人类登录会话可修改并发上限。")).toBeTruthy();
  expect(setRunLimit).not.toHaveBeenCalled();
});

test("a limit already shown by a newer read is not reported as failed when only the reply is lost", async () => {
  let current = capacity;
  const write = Promise.withResolvers<void>();
  const setRunLimit = vi.fn(() => write.promise);
  const read = vi.fn(async () => current);
  const client = fakeClient({ executionCapacity: read, setRunLimit });
  const view = render(<Settings client={client} projectId="p" revision={0} />);
  const input = await screen.findByRole<HTMLInputElement>("spinbutton", {
    name: "Workstation Agent 并发上限",
  });
  fireEvent.change(input, { target: { value: "9" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(setRunLimit).toHaveBeenCalledOnce();
  // The server applied it; a live update reads 9 before the reply is lost.
  current = { ...capacity, agents: [{ ...agent, limit: 9 }] };
  view.rerender(<Settings client={client} projectId="p" revision={1} />);
  await screen.findByText("全部 7 · 非常驻 5 / 上限 9 / 排队 2");
  await act(async () => write.reject(new Error("reply lost")));
  await waitFor(() => expect(input.readOnly).toBe(false));
  expect(screen.queryByText(/未能保存/)).toBeNull();
  expect(input.value).toBe("9");
});

test("a failed limit write reads the counts again before the field can be edited", async () => {
  const setRunLimit = vi.fn().mockRejectedValue(new Error("offline"));
  const read = vi.fn(async () => capacity);
  render(
    <Settings
      client={fakeClient({ executionCapacity: read, setRunLimit })}
      projectId="p"
      revision={0}
    />,
  );
  const input = await screen.findByRole<HTMLInputElement>("spinbutton");
  expect(read).toHaveBeenCalledTimes(1);
  fireEvent.change(input, { target: { value: "8" } });
  fireEvent.blur(input);
  await screen.findByText(/未能保存“Workstation Agent 并发上限”/);
  // The write may have taken effect: the shared read runs again.
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(input.readOnly).toBe(false));
  expect(input.value).toBe("8");
});

test("machines sharing a label keep separate saves", async () => {
  const write = Promise.withResolvers<void>();
  const setRunLimit = vi.fn(() => write.promise);
  render(
    <Settings
      client={fakeClient({
        executionCapacity: async () => ({
          ...capacity,
          agents: [
            { ...agent, machine_id: "a", label: "同名", limit: 6 },
            { ...agent, machine_id: "b", label: "同名", limit: 9 },
          ],
        }),
        setRunLimit,
      })}
      projectId="p"
      revision={0}
    />,
  );
  const [first, second] = await screen.findAllByRole<HTMLInputElement>(
    "spinbutton",
    { name: "同名 Agent 并发上限" },
  );
  if (!first || !second) throw new Error("two machines expected");
  fireEvent.change(first, { target: { value: "9" } });
  fireEvent.keyDown(first, { key: "Enter" });
  expect(setRunLimit).toHaveBeenCalledWith("p", "a", 9, expect.any(String));
  expect(first.readOnly).toBe(true);
  expect(second.readOnly).toBe(false);
  fireEvent.change(second, { target: { value: "3" } });
  fireEvent.keyDown(second, { key: "Enter" });
  expect(setRunLimit).toHaveBeenCalledWith("p", "b", 3, expect.any(String));
  await act(async () => write.resolve());
});
