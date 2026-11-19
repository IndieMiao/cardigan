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
import type { PreferencesView, SystemReminderPolicy } from "../api.js";
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
