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
import { afterEach, describe, expect, test, vi } from "vitest";
import { App } from "../App.js";
import type { PreferencesView, SystemReminderPolicy } from "../api.js";
import type { StreamCallbacks } from "../stream.js";
import { fakeClient, project } from "../testing/fixtures.js";
import { SettingsPage } from "./SettingsPage.js";
import { resetSettingWrites } from "./useSettingWrite.js";

// C-455 review (V-2162): write ordering, idempotency keys and feedback.
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
  // Let queued hashchange events and traversals end before the next test.
  await new Promise((r) => setTimeout(r, 50));
});

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

test("pressing the timeout switch during a minutes write changes nothing; off afterwards wins", async () => {
  const { s, writes } = slowTimeout(10);
  const toggle = await screen.findByRole("switch", { name: "超时自动合并" });
  const minutes = screen.getByLabelText("等待分钟数") as HTMLInputElement;
  // Keyboard: Tab commits the minutes, then Space on the switch while saving.
  enter(minutes, "1");
  expect(toggle.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(toggle.getAttribute("aria-disabled")).not.toBe("true"),
  );
  expect(writes).toEqual([1]);
  expect(on(toggle)).toBe(true);
  fireEvent.click(toggle);
  await waitFor(() => expect(on(toggle)).toBe(false));
  expect(writes).toEqual([1, null]);
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

/** Timeout merge at 10 minutes whose first write waits for `release`. */
async function heldTimeout() {
  let minutes: number | null = 10;
  const first = Promise.withResolvers<void>();
  const writes: (number | null)[] = [];
  const setPreferences = vi.fn(async (_p: string, next: number | null) => {
    writes.push(next);
    if (writes.length === 1) await first.promise;
    minutes = next;
  });
  render(
    <SettingsPage
      projectId="p-1"
      client={fakeClient({
        preferences: async () => ({
          ...base,
          auto_merge_after_minutes: minutes,
        }),
        setPreferences,
      })}
    />,
  );
  const toggle = await screen.findByRole("switch", { name: "超时自动合并" });
  const input = screen.getByLabelText("等待分钟数") as HTMLInputElement;
  return {
    toggle,
    input,
    writes,
    release: () => act(async () => first.resolve()),
    state: () => minutes,
  };
}

test("while minutes save, the switch and the read-only field write nothing more", async () => {
  const f = await heldTimeout();
  act(() => f.input.focus());
  fireEvent.change(f.input, { target: { value: "1" } });
  act(() => f.toggle.focus());
  expect(f.writes).toEqual([1]);
  fireEvent.click(f.toggle);
  act(() => f.input.focus());
  expect(f.input.readOnly).toBe(true);
  act(() => f.input.blur());
  await f.release();
  await settle();
  expect(f.writes).toEqual([1]);
  expect(f.state()).toBe(1);
  expect(on(f.toggle)).toBe(true);
});

test("a press that leaves the switch does not block later minute edits", async () => {
  const f = await heldTimeout();
  fireEvent.pointerDown(f.toggle, { button: 0, pointerType: "mouse" });
  fireEvent.pointerMove(document.body, { buttons: 1, pointerType: "mouse" });
  fireEvent.pointerUp(document.body, { button: 0, pointerType: "mouse" });
  act(() => f.input.focus());
  fireEvent.change(f.input, { target: { value: "120" } });
  fireEvent.keyDown(f.input, { key: "Enter" });
  expect(f.writes).toEqual([120]);
  act(() => f.input.blur());
  await f.release();
  await waitFor(() => expect(f.state()).toBe(120));
  expect(f.writes).toEqual([120]);
});

test("focus moving onto the switch after release turns it off without the draft", async () => {
  const f = await heldTimeout();
  act(() => f.input.focus());
  fireEvent.change(f.input, { target: { value: "1" } });
  fireEvent.pointerDown(f.toggle, { pointerType: "touch" });
  fireEvent.pointerUp(f.toggle, { pointerType: "touch" });
  act(() => f.toggle.focus());
  fireEvent.click(f.toggle);
  expect(f.writes).toEqual([null]);
  await f.release();
  await waitFor(() => expect(on(f.toggle)).toBe(false));
  expect(f.state()).toBeNull();
});

test("a failed minutes write keeps the edit so blurring again retries it", async () => {
  const setReviewMaxRounds = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("offline"))
    .mockResolvedValue(undefined);
  render(
    <SettingsPage
      projectId="p-1"
      client={fakeClient({ setReviewMaxRounds })}
    />,
  );
  const input = await screen.findByLabelText("普通审核轮数上限（轮）");
  enter(input, "7");
  await screen.findByRole("alert");
  act(() => input.focus());
  act(() => input.blur());
  await waitFor(() => expect(setReviewMaxRounds).toHaveBeenCalledTimes(2));
  expect(setReviewMaxRounds.mock.calls[1]?.[3]).toBe(
    setReviewMaxRounds.mock.calls[0]?.[3],
  );
});

test("after an interrupted press ends, blurring an edited minutes field saves it", async () => {
  const f = await heldTimeout();
  fireEvent.pointerDown(f.toggle, { button: 0, pointerType: "mouse" });
  fireEvent.pointerUp(document.body, { button: 0, pointerType: "mouse" });
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  act(() => f.input.focus());
  fireEvent.change(f.input, { target: { value: "120" } });
  act(() => f.input.blur());
  expect(f.writes).toEqual([120]);
  await f.release();
  await waitFor(() => expect(f.state()).toBe(120));
});

const nextTask = () =>
  act(() => new Promise((resolve) => setTimeout(resolve, 0)));

test("a touch tap on the switch turns it off without writing the unsaved minutes", async () => {
  const f = await heldTimeout();
  act(() => f.input.focus());
  fireEvent.change(f.input, { target: { value: "1" } });
  // Chromium touch tap: pointer events, then later compat mouse events.
  fireEvent.pointerDown(f.toggle, { pointerType: "touch" });
  fireEvent.pointerUp(f.toggle, { pointerType: "touch" });
  await nextTask();
  fireEvent.mouseDown(f.toggle);
  act(() => f.input.blur());
  fireEvent.mouseUp(f.toggle);
  fireEvent.click(f.toggle);
  expect(f.writes).toEqual([null]);
  await f.release();
  await waitFor(() => expect(on(f.toggle)).toBe(false));
  expect(f.state()).toBeNull();
});

test("an abandoned touch press is ended by the next tap elsewhere", async () => {
  const f = await heldTimeout();
  act(() => f.input.focus());
  fireEvent.change(f.input, { target: { value: "120" } });
  fireEvent.pointerDown(f.toggle, { pointerType: "touch" });
  fireEvent.pointerUp(document.body, { pointerType: "touch" });
  await nextTask();
  fireEvent.pointerDown(document.body, { pointerType: "touch" });
  act(() => f.input.blur());
  expect(f.writes).toEqual([120]);
  await f.release();
});

test("after turning off with an unsaved draft, tabbing through the minutes field cannot re-enable it", async () => {
  const f = await heldTimeout();
  act(() => f.input.focus());
  fireEvent.change(f.input, { target: { value: "1" } });
  fireEvent.pointerDown(f.toggle, { button: 0, pointerType: "mouse" });
  act(() => f.toggle.focus());
  fireEvent.pointerUp(f.toggle, { button: 0, pointerType: "mouse" });
  fireEvent.click(f.toggle);
  expect(f.writes).toEqual([null]);
  act(() => f.input.focus());
  act(() => f.input.blur());
  await f.release();
  await settle();
  expect(f.writes).toEqual([null]);
  expect(f.state()).toBeNull();
  expect(on(f.toggle)).toBe(false);
  // The draft stays visible and is what a later activation writes.
  expect(f.input.value).toBe("1");
  fireEvent.click(f.toggle);
  await waitFor(() => expect(f.writes).toEqual([null, 1]));
});

test("an off after a failed minutes write is not reversed by tabbing through the field", async () => {
  let minutes: number | null = 10;
  const writes: (number | null)[] = [];
  const first = Promise.withResolvers<void>();
  render(
    <SettingsPage
      projectId="p-1"
      client={fakeClient({
        preferences: async () => ({
          ...base,
          auto_merge_after_minutes: minutes,
        }),
        setPreferences: async (_p, next) => {
          writes.push(next);
          if (writes.length === 1) await first.promise;
          minutes = next;
        },
      })}
    />,
  );
  const toggle = await screen.findByRole("switch", { name: "超时自动合并" });
  const input = screen.getByLabelText("等待分钟数") as HTMLInputElement;
  act(() => input.focus());
  fireEvent.change(input, { target: { value: "1" } });
  act(() => toggle.focus()); // Tab: blur commits 1
  fireEvent.click(toggle); // Space while saving: ignored
  await act(async () => first.reject(new Error("first write rejected")));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(on(toggle)).toBe(true);
  fireEvent.click(toggle); // an explicit off once idle
  await waitFor(() => expect(on(toggle)).toBe(false));
  act(() => input.focus());
  act(() => input.blur()); // Tab through; no new edit
  await settle();
  expect({ writes, minutes }).toEqual({ writes: [1, null], minutes: null });
});

test("another project's settings do not share the queue", async () => {
  const writes: string[] = [];
  const first = Promise.withResolvers<void>();
  const client = fakeClient({
    setPreferences: async (project, next) => {
      writes.push(`${project}:${next}`);
      if (writes.length === 1) await first.promise;
    },
  });
  const view = render(<SettingsPage client={client} projectId="p-1" />);
  enter(await screen.findByLabelText("等待分钟数"), "1");
  fireEvent.click(screen.getByRole("switch", { name: "超时自动合并" }));
  view.unmount();
  render(<SettingsPage client={client} projectId="p-2" />);
  fireEvent.click(await screen.findByRole("switch", { name: "超时自动合并" }));
  // p-1's write is still held; p-2 writes immediately.
  await waitFor(() => expect(writes).toEqual(["p-1:1", "p-2:10"]));
  await act(async () => first.resolve());
});

const timeoutName = "超时自动合并";

// V-2186 (attachment-6495): a read after another window turned it off is what
// the returning page edits; editing minutes alone writes nothing.
test("a post-write read of off is not re-enabled by editing minutes alone", async () => {
  let stored: number | null = null;
  const snapshots: (number | null)[] = [];
  const first = Promise.withResolvers<void>();
  const writes: (number | null)[] = [];
  const client = fakeClient({
    preferences: async () => {
      snapshots.push(stored);
      return { ...base, auto_merge_after_minutes: stored };
    },
    setPreferences: async (_project, next) => {
      writes.push(next);
      if (writes.length === 1) await first.promise;
      stored = next;
    },
  });
  const settings = () => <SettingsPage client={client} projectId="p-1" />;
  const view = render(settings());
  const sw = await screen.findByRole("switch", { name: timeoutName });
  fireEvent.change(screen.getByLabelText("等待分钟数"), {
    target: { value: "120" },
  });
  fireEvent.click(sw);
  expect(writes).toEqual([120]);
  view.unmount();
  await act(async () => first.resolve());
  stored = null; // another window turned it off
  render(settings());
  const back = await screen.findByRole("switch", { name: timeoutName });
  expect(on(back)).toBe(false);
  const input = screen.getByLabelText("等待分钟数");
  fireEvent.change(input, { target: { value: "60" } });
  fireEvent.blur(input);
  await settle();
  expect({ writes, stored }).toEqual({ writes: [120], stored: null });
});

// C-455 review (V-2184): an off-page confirmation must not override a read
// that started after it.
// Only the first save's acknowledgement differs between the two cases.
// All writes finish before the next editor starts; no concurrent editing.
for (const background of [false, true])
  test(`a fresh read after an ${background ? "off-page" : "on-page"} acknowledgement supplies the next policy draft`, async () => {
    let policy: SystemReminderPolicy = {
      min_minutes: 1,
      max_minutes: 60,
      min_count: 1,
      max_count: 4,
      unassigned_ready_after_minutes: 15,
      pre_merge_check_pending_after_minutes: 20,
      repeat: false,
      repeat_interval_minutes: null,
      max_reminders: 1,
    };
    const heldWrite = Promise.withResolvers<void>(),
      extraRead = Promise.withResolvers<void>();
    const readsOnReturn: number[] = [];
    let returning = false,
      writes = 0;
    const client = fakeClient({
      preferences: async () => {
        const snapshot = { ...policy };
        if (returning) {
          readsOnReturn.push(snapshot.max_minutes);
          if (readsOnReturn.length === 2) await extraRead.promise;
        }
        return {
          auto_merge_after_minutes: null,
          merge_gate_enabled: true,
          system_reminder_policy: snapshot,
        };
      },
      setSystemRules: async (_project, patch) => {
        if (++writes === 1) await heldWrite.promise;
        policy = { ...(patch.system_reminder_policy as SystemReminderPolicy) };
      },
    });
    const page = () => <SettingsPage client={client} projectId="p-1" />;
    const open = async () => {
      fireEvent.click(
        await screen.findByRole("button", { name: "编辑催办阈值" }),
      );
      return within(await screen.findByRole("dialog", { name: "催办阈值" }));
    };
    const view = render(page());
    let dialog = await open();
    fireEvent.change(dialog.getByLabelText(/就绪未指派：等待分钟数/), {
      target: { value: "18" },
    });
    fireEvent.click(dialog.getByRole("button", { name: "保存催办阈值" }));
    expect(writes).toBe(1);
    if (background) view.unmount();
    await act(async () => heldWrite.resolve());
    if (!background) view.unmount();
    expect(policy.unassigned_ready_after_minutes).toBe(18);
    // Another settings window completes its save while this one is away.
    policy = { ...policy, max_minutes: 120 };
    returning = true;
    render(page());
    dialog = await open();
    expect(readsOnReturn[0]).toBe(120);
    // Release any additional refresh *before* the user changes anything.
    await act(async () => extraRead.resolve());
    const shown = Number(
      (dialog.getByLabelText("允许的最多分钟数") as HTMLInputElement).value,
    );
    fireEvent.change(dialog.getByLabelText(/就绪未指派：等待分钟数/), {
      target: { value: "25" },
    });
    fireEvent.click(dialog.getByRole("button", { name: "保存催办阈值" }));
    await act(async () => {});
    expect({
      shown,
      storedMax: policy.max_minutes,
      storedWait: policy.unassigned_ready_after_minutes,
    }).toEqual({ shown: 120, storedMax: 120, storedWait: 25 });
  });

// C-455#326: leaving never waits. A save still in flight completes; a failure
// the reader no longer sees is reported once with a way back, success adds
// nothing, and history is never touched.
const h = (name: string, query = "") => `#/p/p-1/${name}${query}`;
const tick = (ms = 40) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
function seed([first, ...rest]: string[]) {
  history.replaceState(null, "", h(first ?? "cards"));
  for (const page of rest) history.pushState(null, "", h(page));
}
const alerts = () =>
  screen
    .queryAllByRole("alert")
    .map((e) => e.textContent)
    .join(" ");
const settingsShown = () => !!screen.queryByRole("heading", { name: "设置" });
const helpLink = () => screen.getByRole("link", { name: "帮助", exact: true });

/** App on p-1 settings with the next timeout write held. */
async function timeoutApp() {
  const write = Promise.withResolvers<void>();
  const setPreferences = vi.fn(() => write.promise);
  render(<App client={fakeClient({ setPreferences })} />);
  fireEvent.click(await screen.findByRole("switch", { name: timeoutName }));
  expect(setPreferences).toHaveBeenCalledOnce();
  return write;
}

/** App on p-1 authorization with 对外发布 delegated and its revocation held. */
async function revocationApp() {
  let publish = true;
  const write = Promise.withResolvers<void>();
  const setDelegation = vi.fn(async (_p: string, _c: string, next: boolean) => {
    await write.promise;
    publish = next;
  });
  render(
    <App
      client={fakeClient({
        preferences: async () => ({
          ...base,
          decision_delegation: { publish },
        }),
        setDelegation,
      })}
    />,
  );
  const control = await screen.findByRole("switch", { name: /^对外发布/ });
  expect(on(control)).toBe(true);
  fireEvent.click(control);
  expect(setDelegation).toHaveBeenCalledOnce();
  return { write, publish: () => publish };
}

test("leaving while a setting saves is immediate; success adds no notice", async () => {
  window.location.hash = h("settings");
  const write = await timeoutApp();
  const unload = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);
  fireEvent.click(helpLink());
  await waitFor(() => expect(settingsShown()).toBe(false));
  expect(location.hash).toBe(h("help"));
  await act(async () => write.resolve());
  await tick();
  expect(alerts()).toBe("");
  const later = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(later);
  expect(later.defaultPrevented).toBe(false);
});

test("a revocation that fails after leaving is reported once, and leads back to the actual value", async () => {
  window.location.hash = h("settings", "?tab=authorization");
  const f = await revocationApp();
  fireEvent.click(helpLink());
  await waitFor(() => expect(settingsShown()).toBe(false));
  await act(async () => f.write.reject(new Error("测试：授权未保存")));
  await waitFor(() =>
    expect(alerts()).toContain("未能撤销“对外发布”授权，请回到设置重试"),
  );
  expect(f.publish()).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "回到设置" }));
  const control = await screen.findByRole("switch", { name: /^对外发布/ });
  expect(on(control)).toBe(true);
  expect(location.hash).toBe(h("settings", "?tab=authorization"));
  expect(alerts()).not.toContain("请回到设置重试");
});

test("a failure answered before the route handles the click is still reported", async () => {
  window.location.hash = h("settings");
  const write = await timeoutApp();
  await act(async () => {
    fireEvent.click(helpLink());
    write.reject(new Error("测试：超时合并未保存"));
  });
  await waitFor(() => expect(settingsShown()).toBe(false));
  expect(location.hash).toBe(h("help"));
  expect(alerts()).toContain("未能保存“超时自动合并”，请回到设置重试");
});

for (const step of ["back", "forward"] as const)
  test(`a failure answered between a native ${step} and its hashchange is reported`, async () => {
    const settings = "settings?tab=authorization";
    seed(step === "back" ? ["cards", settings] : [settings, "help"]);
    if (step === "forward") {
      history.back();
      await tick();
    }
    expect(location.hash).toBe(h(settings));
    const f = await revocationApp();
    window.addEventListener(
      "popstate",
      () => f.write.reject(new Error("测试：授权未保存")),
      { once: true, capture: true },
    );
    if (step === "back") history.back();
    else history.forward();
    await waitFor(() => expect(settingsShown()).toBe(false));
    expect(location.hash).toBe(h(step === "back" ? "cards" : "help"));
    await waitFor(() =>
      expect(alerts()).toContain("未能撤销“对外发布”授权，请回到设置重试"),
    );
    expect(f.publish()).toBe(true);
  });

test("a failure in a panel switched away from is reported, and leads back to that panel", async () => {
  window.location.hash = h("settings", "?tab=authorization");
  const f = await revocationApp();
  fireEvent.click(screen.getByRole("button", { name: "偏好", exact: true }));
  expect(screen.getByRole("heading", { name: "偏好" })).toBeTruthy();
  await act(async () => f.write.reject(new Error("测试：授权未保存")));
  await waitFor(() =>
    expect(alerts()).toContain("未能撤销“对外发布”授权，请回到设置重试"),
  );
  fireEvent.click(screen.getByRole("button", { name: "回到设置" }));
  await waitFor(() =>
    expect(screen.getByRole("heading", { name: "授权" })).toBeTruthy(),
  );
  // The row shows the failure itself; the reminder is gone.
  expect(alerts()).toContain("测试：授权未保存");
  expect(alerts()).not.toContain("请回到设置重试");
});

for (const ok of [true, false])
  test(`a two-entry Back while saving goes there at once and keeps history (${ok ? "success" : "failure"})`, async () => {
    seed(["cards", "help", "needs-you", "settings"]);
    const write = await timeoutApp();
    history.go(-2);
    await waitFor(() => expect(location.hash).toBe(h("help")));
    await act(async () => {
      if (ok) write.resolve();
      else write.reject(new Error("设置未保存"));
    });
    await tick();
    expect(alerts().includes("请回到设置重试")).toBe(!ok);
    history.back();
    await waitFor(() => expect(location.hash).toBe(h("cards")));
    history.go(3);
    await waitFor(() => expect(location.hash).toBe(h("settings")));
  });

test("Forward while saving goes there at once; the save's result does not move the reader", async () => {
  seed(["cards", "settings", "help"]);
  history.back();
  await tick();
  expect(location.hash).toBe(h("settings"));
  const write = await timeoutApp();
  history.forward();
  await waitFor(() => expect(location.hash).toBe(h("help")));
  await act(async () => write.resolve());
  await tick(100);
  expect(location.hash).toBe(h("help"));
  expect(alerts()).toBe("");
});

test("another project chosen while saving opens with its own values; the failure names the way back", async () => {
  const write = Promise.withResolvers<void>();
  const setPreferences = vi.fn(() => write.promise);
  window.location.hash = h("settings");
  render(
    <App
      client={fakeClient({
        projects: async () => [
          project,
          { ...project, id: "p-2", name: "其它" },
        ],
        preferences: async (p) => ({
          ...base,
          auto_merge_after_minutes: p === "p-2" ? 240 : null,
        }),
        setPreferences,
      })}
    />,
  );
  fireEvent.click(await screen.findByRole("switch", { name: timeoutName }));
  window.location.hash = "#/p/p-2/settings";
  await waitFor(() =>
    expect(
      (screen.getByLabelText("等待分钟数") as HTMLInputElement).value,
    ).toBe("240"),
  );
  expect(on(screen.getByRole("switch", { name: timeoutName }))).toBe(true);
  await act(async () => write.reject(new Error("测试：超时合并未保存")));
  await waitFor(() =>
    expect(alerts()).toContain("未能保存“超时自动合并”，请回到设置重试"),
  );
  // p-2 is untouched by p-1's failure.
  expect(on(screen.getByRole("switch", { name: timeoutName }))).toBe(true);
  expect(setPreferences.mock.calls.map((c) => c[0])).toEqual(["p-1"]);
  fireEvent.click(screen.getByRole("button", { name: "回到设置" }));
  await waitFor(() => expect(location.hash).toBe(h("settings")));
  await waitFor(() =>
    expect(on(screen.getByRole("switch", { name: timeoutName }))).toBe(false),
  );
});

test("a reminder threshold save that fails after leaving is reported once", async () => {
  window.location.hash = h("settings");
  const write = Promise.withResolvers<void>();
  render(
    <App client={fakeClient({ setSystemRules: vi.fn(() => write.promise) })} />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "编辑催办阈值" }));
  const dialog = within(
    await screen.findByRole("dialog", { name: "催办阈值" }),
  );
  fireEvent.click(
    dialog.getByRole("switch", { name: "设置催办阈值和允许范围" }),
  );
  fireEvent.change(dialog.getByLabelText("允许的最少分钟数"), {
    target: { value: "7" },
  });
  fireEvent.click(dialog.getByRole("button", { name: "保存催办阈值" }));
  history.back();
  window.location.hash = h("help");
  await waitFor(() => expect(settingsShown()).toBe(false));
  await act(async () => write.reject(new Error("threshold write rejected")));
  await waitFor(() =>
    expect(alerts()).toContain("未能保存“催办阈值”，请回到设置重试"),
  );
});

// C-455 review (V-2193): a returning view takes a detached failure over, and a
// read confirming the value retires it everywhere.
describe("save failure notice lifecycle", () => {
  const settings = "#/p/p-1/settings?tab=authorization";
  const alerts = () =>
    screen
      .queryAllByRole("alert")
      .map((el) => el.textContent)
      .join(" ");
  const row = () => screen.findByRole("switch", { name: /^对外发布/ });
  const tab = (s: string) =>
    screen.getByRole("button", { name: s, exact: true });
  async function leave() {
    fireEvent.click(screen.getByRole("link", { name: "帮助", exact: true }));
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "设置", exact: true }),
      ).toBeNull(),
    );
  }
  function setup(applied = false) {
    location.hash = settings;
    const write = Promise.withResolvers<void>();
    const read = Promise.withResolvers<void>();
    let holdRead = false,
      publish = true,
      stream: StreamCallbacks | undefined;
    const preferences = vi.fn(async () => {
      if (holdRead) await read.promise;
      return {
        auto_merge_after_minutes: null,
        merge_gate_enabled: true,
        decision_delegation: { publish },
      };
    });
    const setDelegation = vi.fn(
      async (_project: string, _category: string, next: boolean) => {
        if (applied) publish = next;
        await write.promise;
      },
    );
    render(
      <App
        client={fakeClient({
          preferences,
          setDelegation,
          subscribe: (_, s) => {
            stream = s;
            s.status("live");
            return () => {};
          },
        })}
      />,
    );
    return {
      read,
      write,
      hold: () => {
        holdRead = true;
        preferences.mockClear();
      },
      preferences,
      setDelegation,
      refresh: () =>
        stream?.change({
          type: "preferences_updated",
          stream: "project",
          seq: 1,
        }),
    };
  }
  const failed = "未能撤销“对外发布”授权";
  for (const sameTurn of [true, false])
    test(`quick return to authorization receives the detached failure (${sameTurn ? "read and failure together" : "control: read first"})`, async () => {
      const f = setup();
      fireEvent.click(await row());
      expect(f.setDelegation).toHaveBeenCalledTimes(1);
      await leave();
      f.hold();
      history.back();
      await waitFor(() => expect(f.preferences).toHaveBeenCalled());
      expect(location.hash).toBe(settings);
      expect(screen.queryByRole("switch", { name: /^对外发布/ })).toBeNull();
      if (!sameTurn) {
        await act(async () => f.read.resolve());
        await row();
      }
      await act(async () => {
        f.write.reject(new Error("撤销未保存"));
        f.read.resolve();
      });
      expect((await row()).getAttribute("aria-checked")).toBe("true");
      expect(alerts()).toMatch(/未能撤销|撤销未保存/);
    });

  test("a read confirming revocation must not be followed by an old failure on Help", async () => {
    const f = setup(true);
    fireEvent.click(await row());
    expect(f.setDelegation).toHaveBeenCalledTimes(1);
    fireEvent.click(tab("偏好"));
    await act(async () => f.write.reject(new TypeError("reply lost")));
    // Q-928: the read after the write shows the revocation took effect, so
    // the lost reply is not reported (6531 expected a notice before a manual
    // refresh confirmed it).
    expect(alerts()).not.toContain(failed);
    fireEvent.click(tab("授权"));
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: /^对外发布/ })
          .getAttribute("aria-checked"),
      ).toBe("false"),
    );
    act(() => f.refresh());
    await waitFor(() => expect(alerts().trim()).toBe(""));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 550));
    });
    fireEvent.click(tab("偏好"));
    await leave();
    expect(f.setDelegation).toHaveBeenCalledTimes(1);
    expect(alerts()).not.toContain(failed);
  });

  test("a failure seen on the page is not reported again on a later leave", async () => {
    const f = setup();
    fireEvent.click(await row());
    await act(async () => f.write.reject(new Error("撤销未保存")));
    expect(alerts()).toContain("撤销未保存");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 550));
    });
    fireEvent.click(tab("偏好"));
    await leave();
    expect(alerts()).not.toContain(failed);
  });
});

// C-455 review (V-2195): one request per project and setting across views, and
// every failed request listed.
describe("requests across views", () => {
  afterEach(async () => {
    cleanup();
    resetSettingWrites();
    history.replaceState(null, "", "#/p/p-1/cards");
    await new Promise((r) => setTimeout(r, 30));
  });
  async function start() {
    history.replaceState(null, "", "#/p/p-1/settings?tab=authorization");
    const stored: Record<string, boolean> = { spending: false, publish: true };
    const writes: {
      p: string;
      c: string;
      next: boolean;
      key?: string;
      req: ReturnType<typeof Promise.withResolvers<void>>;
    }[] = [];
    const reads: string[] = [];
    const client = fakeClient({
      preferences: async (p) => {
        reads.push(p);
        return {
          merge_gate_enabled: true,
          auto_merge_after_minutes: null,
          decision_delegation: { ...stored },
        };
      },
      setDelegation: async (p, c, next, key) => {
        const req = Promise.withResolvers<void>();
        writes.push({ p, c, next, key, req });
        await req.promise;
        stored[c] = next;
      },
    });
    render(<App client={client} />);
    await screen.findByRole("switch", { name: /^对外发布/ });
    return { stored, writes, reads };
  }
  const sw = (name: RegExp) => screen.getByRole("switch", { name });
  const alerts = () =>
    screen
      .queryAllByRole("alert")
      .map((a) => a.textContent ?? "")
      .join(" ");
  async function leave() {
    fireEvent.click(screen.getByRole("link", { name: "帮助", exact: true }));
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "设置", exact: true }),
      ).toBeNull(),
    );
  }
  async function back() {
    fireEvent.click(screen.getByRole("link", { name: "设置", exact: true }));
    fireEvent.click(
      await screen.findByRole("button", { name: "授权", exact: true }),
    );
    await screen.findByRole("switch", { name: /^花钱/ });
  }
  for (const remount of [false, true])
    test(`same project and same setting have at most one outstanding grant (leave and return: ${remount})`, async () => {
      const f = await start();
      fireEvent.click(sw(/^花钱/));
      expect(f.writes).toHaveLength(1);
      if (remount) {
        await leave();
        await back();
      }
      // Both reads legitimately returned false: the first write has not finished yet.
      expect(sw(/^花钱/).getAttribute("aria-checked")).toBe("false");
      fireEvent.click(sw(/^花钱/));
      const accepted = f.writes.map((w) => [w.p, w.c, w.next]);
      await act(async () => {
        f.writes[0]?.req.resolve();
        await Promise.resolve();
        for (const w of f.writes.slice(1))
          w.req.reject(Error("花钱授权未保存"));
      });
      expect(f.stored.spending).toBe(true);
      if (f.writes.length > 1)
        expect(new Set(f.writes.map((w) => w.key)).size).toBe(2); // observed duplicate has a distinct request key
      expect(accepted).toEqual([["p-1", "spending", true]]);
    });
  for (const both of [false, true])
    test(`each failed request is identifiable after navigation (second independent setting: ${both})`, async () => {
      const f = await start();
      fireEvent.click(sw(/^对外发布/));
      if (both) fireEvent.click(sw(/^花钱/));
      expect(f.writes[0]?.c).toBe("publish");
      await leave();
      // Record every failure actually rendered; a future UI can combine, stack, or
      // show notices separately. Only writes which really left the App are counted.
      const seen = new Set<string>();
      const record = () => {
        const t = alerts();
        if (t) seen.add(t);
      };
      const ob = new MutationObserver(record);
      ob.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
      });
      try {
        await act(async () => {
          for (const w of f.writes) w.req.reject(Error(`${w.c} refused`));
        });
        record();
        const text = [...seen].join(" ");
        expect(f.stored).toMatchObject({ spending: false, publish: true });
        expect(text).toMatch(/对外发布|publish/);
        if (f.writes.some((w) => w.c === "spending"))
          expect(text).toMatch(/花钱|spending/);
      } finally {
        ob.disconnect();
      }
    });

  test("a view shown again waits for the first request, then shows its outcome", async () => {
    const f = await start();
    fireEvent.click(sw(/^花钱/));
    await leave();
    await back();
    expect(sw(/^花钱/).getAttribute("aria-disabled")).toBe("true");
    await act(async () => f.writes[0]?.req.resolve());
    await waitFor(() =>
      expect(sw(/^花钱/).getAttribute("aria-checked")).toBe("true"),
    );
    expect(sw(/^花钱/).getAttribute("aria-disabled")).not.toBe("true");
    expect(f.writes).toHaveLength(1);
  });

  test("two failed settings are listed separately; each leads back on its own", async () => {
    const f = await start();
    fireEvent.click(sw(/^对外发布/));
    fireEvent.click(sw(/^花钱/));
    await leave();
    await act(async () => {
      for (const w of f.writes) w.req.reject(Error(`${w.c} refused`));
    });
    const buttons = await screen.findAllByRole("button", { name: "回到设置" });
    expect(buttons).toHaveLength(2);
    expect(alerts()).toContain("未能撤销“对外发布”授权");
    expect(alerts()).toContain("未能开启“花钱”授权");
    fireEvent.click(buttons[0] as HTMLElement);
    await screen.findByRole("switch", { name: /^花钱/ });
    // Back in view, both rows take their failures over; no reminders remain.
    await waitFor(() => expect(alerts()).not.toContain("请回到设置重试"));
    expect(alerts()).toContain("publish refused");
    expect(alerts()).toContain("spending refused");
  });
});

// C-455 review (V-2197, attachment-6556): a read confirming the change voids a
// later lost reply; a read that started before a write ended is read again.
describe("results ordered by when reads and writes happened", () => {
  afterEach(async () => {
    cleanup();
    resetSettingWrites();
    location.hash = "";
    await new Promise((r) => setTimeout(r, 50));
  });
  const settings = "#/p/p-1/settings?tab=authorization";
  const alerts = () =>
    screen
      .queryAllByRole("alert")
      .map((el) => el.textContent)
      .join(" ");
  const row = () => screen.findByRole("switch", { name: /^对外发布/ });
  const _tab = (s: string) =>
    screen.getByRole("button", { name: s, exact: true });
  async function leave() {
    fireEvent.click(screen.getByRole("link", { name: "帮助", exact: true }));
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "设置", exact: true }),
      ).toBeNull(),
    );
  }
  function setup(applied = false) {
    location.hash = settings;
    const write = Promise.withResolvers<void>();
    let publish = true,
      stream: StreamCallbacks | undefined;
    const preferences = vi.fn(async () => {
      return {
        auto_merge_after_minutes: null,
        merge_gate_enabled: true,
        decision_delegation: { publish },
      };
    });
    const setDelegation = vi.fn(
      async (_project: string, _category: string, next: boolean) => {
        if (applied) publish = next;
        await write.promise;
      },
    );
    render(
      <App
        client={fakeClient({
          preferences,
          setDelegation,
          subscribe: (_, s) => {
            stream = s;
            s.status("live");
            return () => {};
          },
        })}
      />,
    );
    return {
      write,
      preferences,
      setDelegation,
      refresh: () =>
        stream?.change({
          type: "preferences_updated",
          stream: "project",
          seq: 1,
        }),
    };
  }
  const failed = "未能撤销“对外发布”授权";
  // One write, then a fresh project read, then a lost write acknowledgement.
  for (const applied of [false, true])
    test(`confirmed server read before the old reply rejects: applied=${applied}`, async () => {
      const f = setup(applied);
      const sw = await row();
      expect(sw.getAttribute("aria-checked")).toBe("true");
      fireEvent.click(sw);
      expect(f.setDelegation).toHaveBeenCalledTimes(1);
      f.preferences.mockClear();
      act(() => f.refresh());
      await waitFor(() => expect(f.preferences).toHaveBeenCalled());
      const readBack = await f.preferences.mock.results.at(-1)?.value;
      expect(readBack.decision_delegation.publish).toBe(!applied);
      await waitFor(() =>
        expect(sw.getAttribute("aria-checked")).toBe(String(!applied)),
      );
      expect(alerts().trim()).toBe("");
      await leave();
      await act(async () => f.write.reject(new TypeError("reply lost")));
      expect(location.hash).toBe("#/p/p-1/help");
      expect(f.setDelegation).toHaveBeenCalledTimes(1);
      if (applied) expect(alerts()).not.toContain(failed);
      else expect(alerts()).toContain(failed);
    });

  // The first returned read takes a snapshot while revocation is pending. Only
  // delivery of that read differs; there are no subsequent edits or stream events.
  for (const lateRead of [false, true])
    test(`returned authorization reflects an acknowledged write, slow first snapshot=${lateRead}`, async () => {
      location.hash = settings;
      let publish = true,
        returning = false;
      const write = Promise.withResolvers<void>(),
        firstRead = Promise.withResolvers<void>();
      const returnedReads: boolean[] = [];
      const preferences = vi.fn(async () => {
        const snapshot = publish;
        if (returning) {
          returnedReads.push(snapshot);
          if (returnedReads.length === 1) await firstRead.promise;
        }
        return {
          auto_merge_after_minutes: null,
          merge_gate_enabled: true,
          decision_delegation: { publish: snapshot },
        };
      });
      const setDelegation = vi.fn(
        async (_project: string, _c: string, next: boolean) => {
          await write.promise;
          publish = next;
        },
      );
      render(<App client={fakeClient({ preferences, setDelegation })} />);
      const original = await row();
      expect(original.getAttribute("aria-checked")).toBe("true");
      fireEvent.click(original);
      await leave();
      returning = true;
      history.back();
      await waitFor(() => expect(returnedReads).toEqual([true]));
      if (!lateRead) {
        await act(async () => firstRead.resolve());
        expect((await row()).getAttribute("aria-disabled")).toBe("true");
      }
      await act(async () => write.resolve());
      expect(publish).toBe(false);
      if (lateRead) await act(async () => firstRead.resolve());
      await row();
      expect(setDelegation).toHaveBeenCalledTimes(1);
      await waitFor(() =>
        expect(
          screen
            .getByRole("switch", { name: /^对外发布/ })
            .getAttribute("aria-checked"),
          `return read snapshots: ${JSON.stringify(returnedReads)}, server: ${publish}`,
        ).toBe(String(publish)),
      );
    });
});

// C-455 review (V-2198, attachment-6559): the same orders in both directions,
// and failures taken over by returning rows stay identifiable.
describe("ordering and identifiable failures after a quick return", () => {
  const auth = "#/p/p-1/settings?tab=authorization";
  afterEach(async () => {
    cleanup();
    resetSettingWrites();
    history.replaceState(null, "", "#/p/p-1/cards");
    await new Promise((r) => setTimeout(r, 40));
  });
  const sw = (n: string) =>
    screen.findByRole("switch", { name: new RegExp(`^${n}`) });
  const alerts = () =>
    screen.queryAllByRole("alert").map((el) => el.textContent || "");
  async function leave() {
    fireEvent.click(screen.getByRole("link", { name: "帮助", exact: true }));
    await screen.findByRole("heading", { name: "帮助", exact: true });
  }
  function setup() {
    history.replaceState(null, "", auth);
    const state: Record<string, boolean> = { publish: true, spending: false };
    const writes: {
      p: string;
      c: string;
      next: boolean;
      q: ReturnType<typeof Promise.withResolvers<void>>;
    }[] = [];
    const reads: Record<string, boolean>[] = [];
    const gate = Promise.withResolvers<void>();
    let hold = false,
      stream: StreamCallbacks | undefined;
    render(
      <App
        client={fakeClient({
          subscribe: (_, s) => {
            stream = s;
            s.status("live");
            return () => {};
          },
          preferences: async () => {
            const snap = { ...state };
            reads.push(snap);
            if (hold) await gate.promise;
            return {
              merge_gate_enabled: true,
              auto_merge_after_minutes: null,
              decision_delegation: snap,
            };
          },
          setDelegation: async (p, c, next) => {
            const q = Promise.withResolvers<void>();
            writes.push({ p, c, next, q });
            await q.promise;
            state[c] = next;
          },
        })}
      />,
    );
    return {
      state,
      writes,
      reads,
      hold: () => {
        hold = true;
      },
      release: () => {
        hold = false;
        gate.resolve();
      },
      refresh: () =>
        stream?.change({
          type: "project_preferences_updated",
          stream: "project",
          seq: 9,
        }),
    };
  }
  const network = () => new TypeError("Failed to fetch");
  for (const readFirst of [true, false])
    test(`return GET samples before commit, arrives ${readFirst ? "before" : "after"} write completion`, async () => {
      const f = setup();
      fireEvent.click(await sw("花钱"));
      expect(f.writes).toHaveLength(1);
      await leave();
      f.hold();
      history.back();
      await waitFor(() => expect(f.reads.length).toBe(2));
      expect(f.reads[1]?.spending).toBe(false);
      if (readFirst) {
        await act(async () => f.release());
        await sw("花钱");
      }
      await act(async () => f.writes[0]?.q.resolve());
      expect(f.state.spending).toBe(true);
      if (!readFirst) await act(async () => f.release());
      const row = await sw("花钱");
      expect(f.writes).toHaveLength(1);
      // No writes/replay are needed: the returned value must match the committed grant.
      await waitFor(
        () =>
          expect({
            checked: row.getAttribute("aria-checked"),
            busy: row.getAttribute("aria-disabled"),
          }).toEqual({ checked: "true", busy: "false" }),
        { onTimeout: (e) => e },
      );
    });
  for (const returnFirst of [false, true])
    test(`both connection failures remain identifiable (back before replies: ${returnFirst})`, async () => {
      const f = setup();
      fireEvent.click(await sw("对外发布"));
      fireEvent.click(await sw("花钱"));
      expect(f.writes.map((w) => [w.c, w.next])).toEqual([
        ["publish", false],
        ["spending", true],
      ]);
      await leave();
      if (returnFirst) {
        history.back();
        await sw("对外发布");
      }
      await act(async () => {
        for (const w of f.writes) w.q.reject(network());
      });
      const items = screen.queryAllByRole("alert");
      expect(items).toHaveLength(2);
      // Accept a named alert, an explicit accessible label, or a visible inline error in its named setting row.
      const context = items.map((el) =>
        [
          el.textContent,
          el.getAttribute("aria-label"),
          ...(el.getAttribute("aria-labelledby") ?? "")
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent),
          el.closest("[data-settings-row]")?.textContent,
        ]
          .filter(Boolean)
          .join(" "),
      );
      expect(context.some((x) => x.includes("对外发布"))).toBe(true);
      expect(context.some((x) => x.includes("花钱"))).toBe(true);
    });
  for (const applied of [false, true])
    test(`late response loss after a fresh ${applied ? "confirming" : "nonconfirming"} read and navigation`, async () => {
      const f = setup();
      fireEvent.click(await sw("对外发布"));
      if (applied) f.state.publish = false;
      act(() => f.refresh());
      await waitFor(() => expect(f.reads.length).toBeGreaterThanOrEqual(2));
      const row = await sw("对外发布");
      await waitFor(() =>
        expect(row.getAttribute("aria-checked")).toBe(String(!applied)),
      );
      await leave();
      await act(async () => f.writes[0]?.q.reject(network()));
      expect(f.writes).toHaveLength(1);
      expect(alerts().some((x) => x.includes("未能撤销"))).toBe(!applied);
    });
});

// C-455 review (V-2199, attachment-6569): a return read known to be older than
// the last write cannot seed an edit; the setting stays busy until the read
// again arrives.
describe("a known-old read cannot seed an edit", () => {
  afterEach(async () => {
    cleanup();
    resetSettingWrites();
    location.hash = "";
    await new Promise((r) => setTimeout(r, 50));
  });
  const dialogName = { name: "催办阈值" };
  const editName = { name: "编辑催办阈值" };
  const settleWith = (f: () => void) =>
    act(async () => {
      f();
    });
  for (const openEarly of [false, true])
    test(`late, known-stale return read cannot seed a policy edit (open before recheck: ${openEarly})`, async () => {
      history.replaceState(null, "", "#/p/p-1/help");
      history.pushState(null, "", "#/p/p-1/settings");
      let policy: SystemReminderPolicy = {
        min_minutes: 1,
        max_minutes: 60,
        min_count: 1,
        max_count: 4,
        unassigned_ready_after_minutes: 15,
        pre_merge_check_pending_after_minutes: 20,
        repeat: false,
        repeat_interval_minutes: null,
        max_reminders: 1,
      };
      const commit = Promise.withResolvers<void>(),
        oldRead = Promise.withResolvers<void>(),
        recheck = Promise.withResolvers<void>();
      const samples: number[] = [];
      const sent: SystemReminderPolicy[] = [];
      let returning = false;
      const client = fakeClient({
        preferences: async () => {
          const snapshot = { ...policy };
          if (returning) {
            samples.push(snapshot.max_minutes);
            if (samples.length === 1) await oldRead.promise;
            else if (samples.length === 2) await recheck.promise;
          }
          return {
            auto_merge_after_minutes: null,
            merge_gate_enabled: true,
            system_reminder_policy: snapshot,
          };
        },
        setSystemRules: async (_p, patch) => {
          const next = patch.system_reminder_policy;
          if (!next) throw new Error("expected a reminder policy");
          sent.push({ ...next });
          if (sent.length === 1) await commit.promise;
          policy = { ...next };
        },
      });
      render(<App client={client} />);
      fireEvent.click(await screen.findByRole("button", editName));
      let d = within(await screen.findByRole("dialog", dialogName));
      fireEvent.change(d.getByLabelText("允许的最多分钟数"), {
        target: { value: "120" },
      });
      fireEvent.click(d.getByRole("button", { name: "保存催办阈值" }));
      expect(sent.map((v) => v.max_minutes)).toEqual([120]);
      history.back();
      await screen.findByRole("heading", { name: "帮助", exact: true });
      returning = true;
      history.forward();
      await waitFor(() => expect(samples).toEqual([60]));
      await settleWith(() => commit.resolve());
      expect(policy.max_minutes).toBe(120);
      await settleWith(() => oldRead.resolve());
      await waitFor(() => expect(samples).toEqual([60, 120]));
      // Same single project and window. No edit overlaps the first write. Allow
      // a safe implementation to withhold the editor until its recheck finishes.
      if (openEarly) {
        const edit = screen.queryByRole("button", editName);
        if (edit) fireEvent.click(edit);
      }
      await settleWith(() => recheck.resolve());
      if (!screen.queryByRole("dialog", dialogName))
        fireEvent.click(await screen.findByRole("button", editName));
      d = within(await screen.findByRole("dialog", dialogName));
      const displayedMax = (
        d.getByLabelText("允许的最多分钟数") as HTMLInputElement
      ).value;
      fireEvent.change(d.getByLabelText(/就绪未指派：等待分钟数/), {
        target: { value: "25" },
      });
      fireEvent.click(d.getByRole("button", { name: "保存催办阈值" }));
      await waitFor(() => expect(sent).toHaveLength(2));
      expect({
        displayedMax,
        sentMax: sent[1]?.max_minutes,
        storedMax: policy.max_minutes,
        wait: policy.unassigned_ready_after_minutes,
      }).toEqual({
        displayedMax: "120",
        sentMax: 120,
        storedMax: 120,
        wait: 25,
      });
    });

  test("a switch shown with a known-old read sends nothing until the read again arrives", async () => {
    history.replaceState(null, "", "#/p/p-1/help");
    history.pushState(null, "", "#/p/p-1/settings");
    let reminders = false;
    const commit = Promise.withResolvers<void>(),
      oldRead = Promise.withResolvers<void>(),
      recheck = Promise.withResolvers<void>();
    let reads = 0;
    let returning = false;
    const sent: boolean[] = [];
    const client = fakeClient({
      preferences: async () => {
        const snapshot = reminders;
        if (returning) {
          reads++;
          if (reads === 1) await oldRead.promise;
          else if (reads === 2) await recheck.promise;
        }
        return {
          auto_merge_after_minutes: null,
          merge_gate_enabled: true,
          system_reminders: snapshot,
        };
      },
      setSystemRules: async (_p, patch) => {
        const next = patch.system_reminders === true;
        sent.push(next);
        if (sent.length === 1) await commit.promise;
        reminders = next;
      },
    });
    render(<App client={client} />);
    fireEvent.click(await screen.findByRole("switch", { name: "催办提醒" }));
    expect(sent).toEqual([true]);
    history.back();
    await screen.findByRole("heading", { name: "帮助", exact: true });
    returning = true;
    history.forward();
    await waitFor(() => expect(reads).toBe(1));
    await settleWith(() => commit.resolve());
    await settleWith(() => oldRead.resolve());
    await waitFor(() => expect(reads).toBe(2));
    const toggle = await screen.findByRole("switch", { name: "催办提醒" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.getAttribute("aria-disabled")).toBe("true");
    // Nothing is saving: the page shows its own loading, the row no saving state.
    expect(screen.queryByText("正在保存…")).toBeNull();
    fireEvent.click(toggle);
    await settleWith(() => {});
    expect(sent).toEqual([true]);
    await settleWith(() => recheck.resolve());
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: "催办提醒" })
          .getAttribute("aria-checked"),
      ).toBe("true"),
    );
    expect(
      screen
        .getByRole("switch", { name: "催办提醒" })
        .getAttribute("aria-disabled"),
    ).not.toBe("true");
    fireEvent.click(screen.getByRole("switch", { name: "催办提醒" }));
    await waitFor(() => expect(sent).toEqual([true, false]));
  });
});
