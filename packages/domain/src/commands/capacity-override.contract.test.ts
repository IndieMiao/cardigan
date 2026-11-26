import { expect, test, vi } from "vitest";
import type { EventId, MemberId } from "../ids.js";
import {
  type CapacityOverride,
  type CapacityOverrideBase,
  changeCapacityOverride,
} from "./capacity-override.js";

const base: CapacityOverrideBase = {
  valid: true,
  resources: new Map([
    ["godot", 2],
    ["android.emulator", 2],
  ]),
  pinned: new Set(["android.emulator"]),
  maximum: 8,
};
const context = (current?: CapacityOverride, over = {}) => ({
  machines: [{ id: "mac-mini" }],
  projects: ["cardigan", "sensen"],
  current,
  base,
  member_id: "M-1" as MemberId,
  clock: { now: () => "2026-11-26T00:00:00.000Z" },
  ids: {
    nextEventId: vi.fn(() => "event-1" as EventId),
    nextEventSequence: vi.fn(() => 7),
  },
  ...over,
});
const human = { kind: "human" } as const;

test("only a person changes capacity overrides; rejections write no audit", () => {
  const ports = context();
  expect(
    changeCapacityOverride(
      { kind: "system", project_id: "cardigan" },
      { kind: "set_resource", machine_id: "mac-mini", key: "godot", slots: 3 },
      ports,
    ),
  ).toMatchObject({ ok: false, error: { code: "forbidden_tool" } });
  for (const input of [
    { kind: "set_resource", machine_id: "nope", key: "godot", slots: 3 },
    { kind: "set_resource", machine_id: "mac-mini", key: "Bad Key", slots: 3 },
    { kind: "set_resource", machine_id: "mac-mini", key: "godot", slots: 0 },
    { kind: "set_resource", machine_id: "mac-mini", key: "godot", slots: 1.5 },
    // Tied to adb ports or a fixed device: only YAML may change it.
    {
      kind: "set_resource",
      machine_id: "mac-mini",
      key: "android.emulator",
      slots: 3,
    },
    { kind: "clear_resource", machine_id: "mac-mini", key: "godot" },
    { kind: "set_project_quota", machine_id: "mac-mini", project_id: "ghost" },
    {
      kind: "set_project_quota",
      machine_id: "mac-mini",
      project_id: "sensen",
    },
    {
      kind: "set_project_quota",
      machine_id: "mac-mini",
      project_id: "sensen",
      limit: 9,
    },
    {
      kind: "set_project_quota",
      machine_id: "mac-mini",
      project_id: "sensen",
      resources: { godot: 3 },
    },
    {
      kind: "set_project_quota",
      machine_id: "mac-mini",
      project_id: "sensen",
      resources: { "ios.simulator": 1 },
    },
    {
      kind: "clear_project_quota",
      machine_id: "mac-mini",
      project_id: "sensen",
    },
  ] as const)
    expect(changeCapacityOverride(human, input, ports).ok).toBe(false);
  expect(
    changeCapacityOverride(
      human,
      { kind: "set_resource", machine_id: "mac-mini", key: "godot", slots: 3 },
      context(undefined, { base: { ...base, valid: false } }),
    ),
  ).toMatchObject({
    ok: false,
    error: { message: "主机并发配置无效，请联系主机管理员" },
  });
  expect(ports.ids.nextEventId).not.toHaveBeenCalled();
  expect(ports.ids.nextEventSequence).not.toHaveBeenCalled();
});

test("resource and project overrides accumulate, audit old and new values, and clear back to YAML", () => {
  const set = changeCapacityOverride(
    human,
    { kind: "set_resource", machine_id: "mac-mini", key: "godot", slots: 3 },
    context(),
  );
  expect(set).toMatchObject({
    ok: true,
    value: {
      override: {
        machine_id: "mac-mini",
        resources: { godot: 3 },
        projects: {},
        updated_by: "M-1",
      },
      event: {
        type: "run_capacity_override_updated",
        actor: { kind: "human" },
        payload: {
          change: "set_resource",
          key: "godot",
          old_value: null,
          new_value: 3,
        },
      },
    },
  });
  if (!set.ok || !set.value.override) throw new Error("expected override");
  // A quota may use the overridden total, and a new key added by override.
  const quota = changeCapacityOverride(
    human,
    {
      kind: "set_project_quota",
      machine_id: "mac-mini",
      project_id: "sensen",
      limit: 0,
      resources: { godot: 3 },
    },
    context(set.value.override),
  );
  expect(quota).toMatchObject({
    ok: true,
    value: {
      override: {
        resources: { godot: 3 },
        projects: { sensen: { limit: 0, resources: { godot: 3 } } },
      },
    },
  });
  if (!quota.ok || !quota.value.override) throw new Error("expected quota");
  const withNewKey = changeCapacityOverride(
    human,
    { kind: "set_resource", machine_id: "mac-mini", key: "gpu", slots: 1 },
    context(quota.value.override),
  );
  if (!withNewKey.ok || !withNewKey.value.override)
    throw new Error("expected new key");
  const referenced = changeCapacityOverride(
    human,
    {
      kind: "set_project_quota",
      machine_id: "mac-mini",
      project_id: "cardigan",
      resources: { gpu: 1 },
    },
    context(withNewKey.value.override),
  );
  if (!referenced.ok || !referenced.value.override)
    throw new Error("expected reference");
  // A key that only exists as an override cannot vanish under a quota.
  expect(
    changeCapacityOverride(
      human,
      { kind: "clear_resource", machine_id: "mac-mini", key: "gpu" },
      context(referenced.value.override),
    ),
  ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
  // Clearing everything removes the row: YAML is the default again.
  let current: CapacityOverride | null = referenced.value.override;
  for (const input of [
    {
      kind: "clear_project_quota",
      machine_id: "mac-mini",
      project_id: "cardigan",
    },
    { kind: "clear_resource", machine_id: "mac-mini", key: "gpu" },
    {
      kind: "clear_project_quota",
      machine_id: "mac-mini",
      project_id: "sensen",
    },
    { kind: "clear_resource", machine_id: "mac-mini", key: "godot" },
  ] as const) {
    const next = changeCapacityOverride(
      human,
      input,
      context(current ?? undefined),
    );
    if (!next.ok) throw new Error(next.error.message);
    current = next.value.override;
  }
  expect(current).toBeNull();
});
