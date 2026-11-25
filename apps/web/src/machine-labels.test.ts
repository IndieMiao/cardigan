import { expect, test } from "vitest";
import type { ExecutionMachine } from "./api.js";
import {
  candidateReasons,
  capabilityState,
  exclusionReason,
  healthBlockerLabel,
  machineHealth,
  requirementParts,
  selectionSummary,
} from "./machine-labels.js";

// `undefined` stands for an older server that omits the field.
const machine = (
  health: NonNullable<ExecutionMachine["health"]> | null | undefined,
): ExecutionMachine => ({
  id: "m",
  label: "m",
  status: "online",
  ...(health === undefined ? {} : { health }),
});
const at = "2026-01-01T00:00:00.000Z";

test("MC-5 health distinguishes unchecked, checking, failed, passed and expired", () => {
  expect(machineHealth(machine(undefined)).label).toBe("未检查");
  expect(machineHealth(machine(null)).subdued).toBe(true);
  const base = { checked_at: at, blockers: [], available: false };
  expect(machineHealth(machine({ ...base, status: "checking" })).label).toBe(
    "检查中",
  );
  expect(machineHealth(machine({ ...base, status: "failed" }))).toEqual({
    status: "failed",
    label: "健康检查失败",
    subdued: false,
  });
  expect(
    machineHealth(machine({ ...base, status: "passed", available: true }))
      .label,
  ).toBe("健康");
  expect(machineHealth(machine({ ...base, status: "passed" }))).toEqual({
    status: "inactive",
    label: "健康快照已过期",
    subdued: true,
  });
  expect(healthBlockerLabel("machine_check_failed")).toBe("机器检查失败");
  expect(healthBlockerLabel("other_code")).toBe("other_code");
});

test("MC-5 requirements and exclusion reasons read as prose; unknown text is kept", () => {
  expect(requirementParts(undefined)).toEqual([]);
  expect(requirementParts({})).toEqual([]);
  expect(
    requirementParts({
      os: "darwin",
      arch: "arm64",
      capabilities: ["godot>=4.7", "xcode"],
      tags: ["office"],
    }),
  ).toEqual([
    "OS darwin",
    "架构 arm64",
    "能力 godot>=4.7、xcode",
    "标签 office",
  ]);
  expect(exclusionReason("draining")).toBe("停止接收新任务");
  expect(exclusionReason("os=linux")).toBe("需要 OS linux");
  expect(exclusionReason("arch=arm64")).toBe("需要架构 arm64");
  expect(exclusionReason("tag=a=b")).toBe("缺少标签 a=b");
  expect(exclusionReason("godot>=4.7：未验证")).toBe("godot>=4.7：未验证");
});

test("MC-5 selection summary explains the chosen candidate in the host's sort order", () => {
  const candidate = {
    machine_id: "local",
    affinity: true,
    control_host: true,
    limit: 12,
    occupied: 8,
    remaining_ratio: 1 / 3,
    preference_rank: 0,
  };
  expect(candidateReasons({ ...candidate, pending_assignments: 2 })).toContain(
    "剩余容量 33%（占用 8/12，其中待启动 2）",
  );
  expect(candidateReasons(candidate)).toEqual([
    "验证项优先控制主机",
    "同卡产出已在此机器",
    "剩余容量 33%（占用 8/12）",
    "项目偏好第 1 位",
  ]);
  expect(
    candidateReasons({
      ...candidate,
      affinity: false,
      control_host: false,
      remaining_ratio: null,
      preference_rank: null,
    }),
  ).toEqual([]);
  expect(
    selectionSummary(
      {
        status: "selected",
        at,
        machine_id: "local",
        candidates: [{ ...candidate, affinity: false, preference_rank: null }],
      },
      () => "工作机",
    ),
  ).toBe("工作机（自动选择：验证项优先控制主机，剩余容量 33%（占用 8/12））");
  expect(
    selectionSummary({ status: "assigned", at, machine_id: "mac-mini" }),
  ).toBe("mac-mini（已分配）");
  expect(
    selectionSummary({ status: "deferred", at, reason: "有多个候选机器" }),
  ).toBe("未选出机器：有多个候选机器");
  expect(selectionSummary({ status: "deferred", at, reason: "" })).toBe(
    "未选出机器：原因未记录",
  );
});

test("MC-5 a resource that sets the remaining ratio is named with its selection-time occupancy", () => {
  const candidate = {
    machine_id: "M1",
    affinity: false,
    control_host: false,
    limit: 8,
    occupied: 1,
    remaining_ratio: 0,
    preference_rank: null,
    resources: [
      { key: "docker", limit: 4, occupied: 1 },
      { key: "blender", limit: 1, occupied: 1 },
    ],
  };
  expect(
    selectionSummary({
      status: "selected",
      at,
      machine_id: "M1",
      candidates: [candidate],
    }),
  ).toBe("M1（自动选择：剩余容量 0%（blender 占用 1/1，机器占用 1/8））");
  // A looser resource does not displace the machine's own occupancy.
  expect(
    candidateReasons({
      ...candidate,
      occupied: 6,
      remaining_ratio: 0.25,
      resources: [{ key: "docker", limit: 4, occupied: 1 }],
    }),
  ).toEqual(["剩余容量 25%（占用 6/8）"]);
});

test("C-716 a full project quota is named, and an all-full selection says what it queues on", () => {
  const candidate = {
    machine_id: "cardigan-ci",
    affinity: false,
    control_host: false,
    limit: 12,
    occupied: 3,
    remaining_ratio: 0,
    preference_rank: null,
    project_limit: { limit: 3, occupied: 3 },
  };
  expect(candidateReasons(candidate)).toEqual([
    "剩余容量 0%（项目占用 3/3，机器占用 3/12）",
  ]);
  expect(
    candidateReasons({
      ...candidate,
      project_limit: { limit: 3, occupied: 1 },
      project_resources: [{ key: "godot", limit: 1, occupied: 1 }],
    }),
  ).toEqual(["剩余容量 0%（项目 godot 占用 1/1，机器占用 3/12）"]);
  expect(
    selectionSummary({
      status: "selected",
      at,
      machine_id: "cardigan-ci",
      candidates: [candidate],
      queued_on: ["项目上限 3/3"],
    }),
  ).toBe("cardigan-ci（合格机器均已满，排队：项目上限 3/3）");
});

test("MC-5 capability state falls back to availability for older servers", () => {
  const base = { key: "node", version: null, verified_at: at };
  expect(capabilityState({ ...base, available: true })).toBe("verified");
  expect(capabilityState({ ...base, available: false })).toBe("expired");
  expect(
    capabilityState({
      ...base,
      verified_at: null,
      available: false,
      state: "unverified",
    }),
  ).toBe("unverified");
});
