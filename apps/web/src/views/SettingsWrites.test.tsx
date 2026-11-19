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
import type { PreferencesView } from "../api.js";
import { fakeClient } from "../testing/fixtures.js";
import { SettingsPage } from "./SettingsPage.js";

// C-455 review (V-2162): write ordering, idempotency keys and feedback.
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);
afterEach(cleanup);

const on = (control: HTMLElement) =>
  control.getAttribute("aria-checked") === "true";
const settle = () => act(async () => {});
const enter = (input: HTMLElement, value: string) => {
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
};

/** A persistent synthetic server whose reads can be held back. */
function server(initial: PreferencesView) {
  let state: PreferencesView = { ...initial };
  let hold = false;
  const held: (() => void)[] = [];
  return {
    get state() {
      return state;
    },
    patch(next: Partial<PreferencesView>) {
      state = { ...state, ...next };
    },
    hold() {
      hold = true;
    },
    async release() {
      hold = false;
      await act(async () => {
        for (const resolve of held.splice(0)) resolve();
      });
    },
    preferences: () =>
      hold
        ? new Promise<PreferencesView>((resolve) =>
            held.push(() => resolve({ ...state })),
          )
        : Promise.resolve({ ...state }),
  };
}
const base: PreferencesView = {
  auto_merge_after_minutes: null,
  merge_gate_enabled: true,
};

test("system rule switches send only their own field, so a quick second change keeps the first", async () => {
  const s = server({
    ...base,
    system_auto_assign_verifiers: false,
    system_reminders: false,
  });
  const setSystemRules = vi.fn(async (_p: string, input: object) =>
    s.patch(input),
  );
  render(
    <SettingsPage
      projectId="p-1"
      client={fakeClient({ preferences: s.preferences, setSystemRules })}
    />,
  );
  const assign = await screen.findByRole("switch", { name: "自动指派验证项" });
  s.hold();
  fireEvent.click(assign);
  await settle();
  // The acknowledged write shows before the confirming read returns.
  expect(on(assign)).toBe(true);
  fireEvent.click(screen.getByRole("switch", { name: "催办提醒" }));
  await settle();
  expect(setSystemRules.mock.calls.map((call) => call[1])).toEqual([
    { system_auto_assign_verifiers: true },
    { system_reminders: true },
  ]);
  expect(s.state.system_auto_assign_verifiers).toBe(true);
  expect(s.state.system_reminders).toBe(true);
  await s.release();
  expect(on(screen.getByRole("switch", { name: "自动指派验证项" }))).toBe(true);
  expect(on(screen.getByRole("switch", { name: "催办提醒" }))).toBe(true);
});

test("timeout merge minutes can be chosen while off; enabling writes them in one request", async () => {
  const s = server(base);
  const setPreferences = vi.fn(async (_p: string, minutes: number | null) =>
    s.patch({ auto_merge_after_minutes: minutes }),
  );
  render(
    <SettingsPage
      projectId="p-1"
      client={fakeClient({ preferences: s.preferences, setPreferences })}
    />,
  );
  const toggle = await screen.findByRole("switch", { name: "超时自动合并" });
  const minutes = screen.getByLabelText("等待分钟数") as HTMLInputElement;
  expect(minutes.value).toBe("10");
  enter(minutes, "120");
  await settle();
  expect(setPreferences).not.toHaveBeenCalled();
  fireEvent.click(toggle);
  await waitFor(() => expect(on(toggle)).toBe(true));
  expect(setPreferences).toHaveBeenCalledExactlyOnceWith(
    "p-1",
    120,
    expect.any(String),
  );
  expect(minutes.value).toBe("120");
  // Turning it off keeps the chosen minutes for the next activation.
  fireEvent.click(toggle);
  await waitFor(() => expect(on(toggle)).toBe(false));
  expect(setPreferences).toHaveBeenLastCalledWith(
    "p-1",
    null,
    expect.any(String),
  );
  expect(minutes.value).toBe("120");
  // An invalid choice cannot be enabled.
  enter(minutes, "0");
  fireEvent.click(toggle);
  await settle();
  expect(setPreferences).toHaveBeenCalledTimes(2);
  expect(on(toggle)).toBe(false);
});

test("a numeric value is dirty against the last acknowledged write, not a pending read", async () => {
  const s = server({ ...base, merge_confirm_stall_after_minutes: 60 });
  const save = vi.fn(async (_p: string, value: number) =>
    s.patch({ merge_confirm_stall_after_minutes: value }),
  );
  render(
    <SettingsPage
      projectId="p-1"
      client={fakeClient({
        preferences: s.preferences,
        setMergeConfirmStallAfter: save,
      })}
    />,
  );
  const input = (await screen.findByLabelText(
    "PM 合并确认停留告警（分钟）",
  )) as HTMLInputElement;
  s.hold();
  enter(input, "90");
  await settle();
  enter(input, "60");
  await settle();
  expect(save.mock.calls.map((call) => call[1])).toEqual([90, 60]);
  // An unsaved edit survives the confirming read.
  fireEvent.change(input, { target: { value: "75" } });
  await s.release();
  expect(input.value).toBe("75");
  expect(input.closest("[data-dirty]")).not.toBeNull();
  fireEvent.blur(input);
  await waitFor(() =>
    expect(s.state.merge_confirm_stall_after_minutes).toBe(75),
  );
  expect(input.value).toBe("75");
});

test("the reminder dialog cannot be dismissed while saving; a failure keeps the error and draft", async () => {
  const write = Promise.withResolvers<void>();
  const setSystemRules = vi.fn(() => write.promise);
  render(
    <SettingsPage projectId="p-1" client={fakeClient({ setSystemRules })} />,
  );
  const edit = await screen.findByRole("button", { name: "编辑催办阈值" });
  edit.focus();
  fireEvent.click(edit);
  const dialog = await screen.findByRole("dialog", { name: "催办阈值" });
  fireEvent.click(
    within(dialog).getByRole("switch", { name: "设置催办阈值和允许范围" }),
  );
  fireEvent.change(within(dialog).getByLabelText("允许的最少分钟数"), {
    target: { value: "7" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "保存催办阈值" }));
  await settle();
  fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  fireEvent.keyDown(dialog, { key: "Escape" });
  await settle();
  expect(screen.getByRole("dialog")).toBe(dialog);
  await act(async () => write.reject(new Error("只用于测试的保存失败")));
  expect((await within(dialog).findByRole("alert")).textContent).toContain(
    "只用于测试的保存失败",
  );
  expect(
    (within(dialog).getByLabelText("允许的最少分钟数") as HTMLInputElement)
      .value,
  ).toBe("7");
  fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(edit));
});

test("a lost delegation response confirmed by a read retires its key before the reversal", async () => {
  let state = false;
  const keys: string[] = [];
  const setDelegation = vi.fn(
    async (_p: string, _c: string, next: boolean, key: string) => {
      keys.push(key);
      state = next;
      if (keys.length === 1) throw new Error("Response lost");
    },
  );
  const client = fakeClient({
    preferences: async () => ({
      ...base,
      decision_delegation: { spending: state },
    }),
    setDelegation,
  });
  const { rerender } = render(<SettingsPage client={client} projectId="p-1" />);
  fireEvent.click(screen.getByRole("button", { name: "授权" }));
  fireEvent.click(await screen.findByRole("switch", { name: "花钱 由人拍板" }));
  await screen.findByRole("alert");
  rerender(<SettingsPage client={client} projectId="p-1" revision={1} />);
  const granted = await screen.findByRole("switch", {
    name: "花钱 由 PM 代拍",
  });
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  fireEvent.click(granted);
  await screen.findByRole("switch", { name: "花钱 由人拍板" });
  expect(keys).toHaveLength(2);
  expect(keys[1]).not.toBe(keys[0]);
  expect(state).toBe(false);
});

test("a failed delegation write retried without a read reuses its key", async () => {
  const setDelegation = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("offline"))
    .mockResolvedValue(undefined);
  render(
    <SettingsPage projectId="p-1" client={fakeClient({ setDelegation })} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "授权" }));
  const toggle = await screen.findByRole("switch", { name: "花钱 由人拍板" });
  fireEvent.click(toggle);
  await screen.findByRole("alert");
  fireEvent.click(toggle);
  await waitFor(() => expect(setDelegation).toHaveBeenCalledTimes(2));
  expect(setDelegation.mock.calls[1]?.[3]).toBe(
    setDelegation.mock.calls[0]?.[3],
  );
});

test("a numeric value saved through a lost response gets a new key when chosen again later", async () => {
  let state = 60;
  const seen = new Set<string>();
  const keys: string[] = [];
  const save = vi.fn(async (_p: string, next: number, key: string) => {
    keys.push(key);
    if (seen.has(key)) return;
    seen.add(key);
    state = next;
    if (keys.length === 1) throw new Error("Response lost");
  });
  const client = fakeClient({
    preferences: async () => ({
      ...base,
      merge_confirm_stall_after_minutes: state,
    }),
    setMergeConfirmStallAfter: save,
  });
  const { rerender } = render(<SettingsPage client={client} projectId="p-1" />);
  const input = (await screen.findByLabelText(
    "PM 合并确认停留告警（分钟）",
  )) as HTMLInputElement;
  enter(input, "90");
  await screen.findByRole("alert");
  rerender(<SettingsPage client={client} projectId="p-1" revision={1} />);
  await settle();
  enter(input, "120");
  await waitFor(() => expect(state).toBe(120));
  enter(input, "90");
  await waitFor(() => expect(state).toBe(90));
  expect(keys).toHaveLength(3);
  expect(new Set(keys).size).toBe(3);
  expect(input.value).toBe("90");
});

test("PM merge confirmation reports success and stays focusable while saving", async () => {
  const done = Promise.withResolvers<void>();
  const setPmMergeConfirmation = vi.fn(() => done.promise);
  render(
    <SettingsPage
      projectId="p-1"
      client={fakeClient({ setPmMergeConfirmation })}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "授权" }));
  const toggle = await screen.findByRole("switch", {
    name: /合并由 PM 代确认/,
  });
  toggle.focus();
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-disabled")).toBe("true");
  expect((toggle as HTMLButtonElement).disabled).toBe(false);
  expect(document.activeElement).toBe(toggle);
  fireEvent.click(toggle);
  expect(setPmMergeConfirmation).toHaveBeenCalledTimes(1);
  await act(async () => done.resolve());
  expect(await screen.findByText("已关闭 PM 代确认")).toBeTruthy();
});

test("cross-card read sits in the caution group with automatic merging", async () => {
  render(<SettingsPage projectId="p-1" client={fakeClient()} />);
  const caution = await screen.findByRole("region", { name: "需谨慎" });
  expect(
    within(caution).getByRole("switch", { name: "跨卡只读" }),
  ).toBeTruthy();
  expect(
    within(caution).getByRole("switch", { name: "自动合并" }),
  ).toBeTruthy();
  expect(screen.queryByRole("region", { name: "协作" })).toBeNull();
});

/** A synthetic timeout-merge preference whose writes take a while. */
function slowTimeout(initial: number | null) {
  const s = server({ ...base, auto_merge_after_minutes: initial });
  const writes: (number | null)[] = [];
  const setPreferences = vi.fn(async (_p: string, minutes: number | null) => {
    writes.push(minutes);
    await new Promise((resolve) => setTimeout(resolve, 20));
    s.patch({ auto_merge_after_minutes: minutes });
  });
  render(
    <SettingsPage
      projectId="p-1"
      client={fakeClient({ preferences: s.preferences, setPreferences })}
    />,
  );
  return { s, writes };
}

test("pressing the timeout switch right after editing minutes only turns it off", async () => {
  const { s, writes } = slowTimeout(10);
  const toggle = await screen.findByRole("switch", { name: "超时自动合并" });
  const minutes = screen.getByLabelText("等待分钟数") as HTMLInputElement;
  minutes.focus();
  fireEvent.change(minutes, { target: { value: "1" } });
  // Real order: pointerdown on the switch, then the field blurs, then click.
  fireEvent.pointerDown(toggle);
  fireEvent.blur(minutes);
  fireEvent.pointerUp(toggle);
  fireEvent.click(toggle);
  await waitFor(() => expect(on(toggle)).toBe(false));
  expect(writes).toEqual([null]);
  expect(s.state.auto_merge_after_minutes).toBeNull();
});

test("turning the timeout off during a minutes write runs after it, so off wins", async () => {
  const { s, writes } = slowTimeout(10);
  const toggle = await screen.findByRole("switch", { name: "超时自动合并" });
  const minutes = screen.getByLabelText("等待分钟数") as HTMLInputElement;
  // Keyboard: Tab commits the minutes, then Space on the switch while saving.
  enter(minutes, "1");
  fireEvent.click(toggle);
  fireEvent.click(toggle);
  await waitFor(() => expect(writes).toEqual([1, null]));
  await waitFor(() => expect(on(toggle)).toBe(false));
  expect(s.state.auto_merge_after_minutes).toBeNull();
});

test("an invalid minutes draft left after turning off can be corrected and enabled", async () => {
  const { s, writes } = slowTimeout(10);
  const toggle = await screen.findByRole("switch", { name: "超时自动合并" });
  const minutes = screen.getByLabelText("等待分钟数") as HTMLInputElement;
  fireEvent.change(minutes, { target: { value: "0" } });
  fireEvent.click(toggle);
  await waitFor(() => expect(on(toggle)).toBe(false));
  expect(minutes.disabled).toBe(false);
  enter(minutes, "120");
  fireEvent.click(toggle);
  await waitFor(() => expect(on(toggle)).toBe(true));
  expect(writes).toEqual([null, 120]);
  expect(s.state.auto_merge_after_minutes).toBe(120);
});
