import { expect, test } from "vitest";
import type { DeviceEnablementPrompt } from "../entities.js";
import { cancelHumanAction, deviceActionKey } from "../index.js";
import {
  type DeviceActionInput,
  type DeviceActionOpen,
  reconcileDeviceAction,
} from "./device-actions.js";
import { listNeedsYou } from "./queries.js";
import { actor, apply, fixture, human, ports, value } from "./test-fixtures.js";

const KEY = deviceActionKey(
  "enable",
  "mac-mini",
  "android.device",
  "WGC6R21609003324",
);
const prompt = (
  phase: DeviceEnablementPrompt["phase"],
  failure?: string,
): DeviceEnablementPrompt => ({
  machine_id: "mac-mini",
  type: "android.device",
  device_id: "WGC6R21609003324",
  label: "安卓真机",
  model: "MRR-W39",
  projects: ["sensen"],
  preselected: "sensen",
  steps: ["插电常亮", "关闭动画", "关闭锁屏"],
  phase,
  ...(failure ? { failure } : {}),
});
const open = (
  phase: DeviceEnablementPrompt["phase"],
  failure?: string,
): DeviceActionOpen => ({
  instructions: "mac-mini 发现 MRR-W39，给 sensen 用？",
  why_human: "设备给哪个项目用要由人确认",
  expected_return: "点启用后系统自动初始化",
  device_enablement: prompt(phase, failure),
  reopen_key: phase,
});

test("C-817: a discovered device opens one owner prompt, updated in place and closed by the system", () => {
  const io = ports();
  let state = fixture();
  const system = { kind: "system" as const, project_id: state.project_id };
  const opened = value(
    reconcileDeviceAction(
      state,
      system,
      { key: KEY, open: open("pending") },
      io,
    ),
  );
  expect(opened.events.map((e) => e.type)).toEqual(["human_action_requested"]);
  state = apply(state, opened);
  const [action] = state.human_actions;
  expect(action).toMatchObject({
    requested_by: "system",
    status: "open",
    triage: "human",
    category: "general",
    blocked_work_items: [],
    device_enablement: { phase: "pending", preselected: "sensen" },
  });
  expect(action?.card_id).toBeUndefined();
  expect(
    value(listNeedsYou(state, human)).data.human_actions.map((h) => h.id),
  ).toContain(action?.id);

  // Same prompt: nothing happens.
  expect(
    value(
      reconcileDeviceAction(
        state,
        system,
        { key: KEY, open: open("pending") },
        io,
      ),
    ).events,
  ).toEqual([]);

  // Initialization failed: the same action shows the reason.
  const failed = value(
    reconcileDeviceAction(
      state,
      system,
      { key: KEY, open: open("failed", "“关闭锁屏”没有成功") },
      io,
    ),
  );
  expect(failed.events.map((e) => e.type)).toEqual(["device_action_updated"]);
  state = apply(state, failed);
  expect(state.human_actions).toHaveLength(1);
  expect(state.human_actions[0]?.device_enablement).toMatchObject({
    phase: "failed",
    failure: "“关闭锁屏”没有成功",
  });

  // Enabled: the system completes it with a result (a notice for the owner).
  const done = value(
    reconcileDeviceAction(
      state,
      system,
      { key: KEY, close: { outcome: "done", text: "已启用，给 sensen 用" } },
      io,
    ),
  );
  expect(done.events.map((e) => e.type)).toEqual(["human_action_completed"]);
  state = apply(state, done);
  expect(state.human_actions[0]).toMatchObject({
    status: "done",
    result: { text: "已启用，给 sensen 用" },
  });
  // Closing with nothing open is a no-op.
  expect(
    value(
      reconcileDeviceAction(
        state,
        system,
        { key: KEY, close: { outcome: "cancelled", text: "设备已停用" } },
        io,
      ),
    ).events,
  ).toEqual([]);
  // A later prompt for the same key (e.g. re-enable after a reset) is new.
  state = apply(
    state,
    value(
      reconcileDeviceAction(
        state,
        system,
        { key: KEY, open: open("pending") },
        io,
      ),
    ),
  );
  expect(state.human_actions.map((h) => h.status)).toEqual(["done", "open"]);
});

test("C-817: a prompt a person dismissed is not reopened in the same state", () => {
  const io = ports();
  let state = fixture();
  const system = { kind: "system" as const, project_id: state.project_id };
  state = apply(
    state,
    value(
      reconcileDeviceAction(
        state,
        system,
        { key: KEY, open: open("pending") },
        io,
      ),
    ),
  );
  const id = state.human_actions[0]?.id;
  if (!id) throw new Error("missing action");
  state = apply(
    state,
    value(
      cancelHumanAction(
        state,
        human,
        { human_action_id: id, reason: "先不用" },
        io,
      ),
    ),
  );
  expect(
    value(
      reconcileDeviceAction(
        state,
        system,
        { key: KEY, open: open("pending") },
        io,
      ),
    ).events,
  ).toEqual([]);
  // A new state (the person enabled it from the CLI and it failed) opens again.
  expect(
    value(
      reconcileDeviceAction(
        state,
        system,
        { key: KEY, open: open("failed", "初始化没有返回结果") },
        io,
      ),
    ).events.map((e) => e.type),
  ).toEqual(["human_action_requested"]);
});

test("C-817: only this project's host system writes device to-dos, with valid input", () => {
  const io = ports();
  const state = fixture();
  const system = { kind: "system" as const, project_id: state.project_id };
  for (const caller of [
    human,
    actor(1, "coder"),
    actor(4, "pm"),
    actor(5, "host_ops"),
    { ...system, project_id: "other" },
  ])
    expect(
      reconcileDeviceAction(
        state,
        caller,
        { key: KEY, open: open("pending") },
        io,
      ).ok,
    ).toBe(false);
  const unavailable = deviceActionKey(
    "unavailable",
    "mac-mini",
    "android.device",
    "WGC6R21609003324",
  );
  for (const bad of [
    { key: "device-enable:mac mini:android.device:X", open: open("pending") },
    { key: "worker-helper:mac-mini:x", open: open("pending") },
    // The enable prompt must carry the prompt; other kinds must not.
    {
      key: KEY,
      open: (({ device_enablement: _prompt, ...rest }) => rest)(
        open("pending"),
      ),
    },
    { key: unavailable, open: open("pending") },
    { key: KEY, open: { ...open("pending"), instructions: " " } },
    { key: KEY, close: { outcome: "done" as const, text: "" } },
  ] as DeviceActionInput[])
    expect(reconcileDeviceAction(state, system, bad, io).ok).toBe(false);
  expect(
    reconcileDeviceAction(
      state,
      system,
      {
        key: unavailable,
        open: {
          instructions: "mac-mini 的 MRR-W39 离线，C-1 在等它",
          why_human: "要有人到机器旁重新接好设备",
          expected_return: "设备恢复后自动结项",
          reopen_key: "offline",
        },
      },
      io,
    ).ok,
  ).toBe(true);
});
