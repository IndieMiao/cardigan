import { expect, test } from "vitest";
import type { ExecutionMachine } from "./api.js";
import {
  candidateReasons,
  exclusionReason,
  healthBlockerLabel,
  machineHealth,
  requirementParts,
  selectionSummary,
} from "./machine-labels.js";

const machine = (health: ExecutionMachine["health"]): ExecutionMachine => ({
  id: "m",
  label: "m",
  status: "online",
  health,
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
    selectionSummary({ status: "explicit", at, machine_id: "mac-mini" }),
  ).toBe("mac-mini（指定机器）");
  expect(
    selectionSummary({ status: "deferred", at, reason: "有多个候选机器" }),
  ).toBe("未选出机器：有多个候选机器");
  expect(selectionSummary({ status: "deferred", at, reason: "" })).toBe(
    "未选出机器：原因未记录",
  );
});
