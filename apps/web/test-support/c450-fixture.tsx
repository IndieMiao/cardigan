import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import type {
  CardDetail,
  ExecutionCapacity,
  ExecutionData,
  WorkItemView,
} from "../src/api.js";
import { executionDisplayFixture } from "../src/testing/execution-display-fixture.js";
import { card, cardDetail, fakeClient, NOW } from "../src/testing/fixtures.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/components/ui/theme.css";

// C-450 (MC-5): fixed synthetic data, no production database. 4 machines
// (long label and unbroken ID, verified/expired capabilities, health
// passed/failed/checking/unchecked), 8 Assignments, configured resources
// (one full), and work items with requirements, an automatic choice with
// long exclusion reasons, and a deferred placement.
Date.now = () => new Date(NOW).getTime();
const fresh = new Date(Date.parse(NOW) - 2 * 3600_000).toISOString();
const old = new Date(Date.parse(NOW) - 30 * 3600_000).toISOString();
const longId = "gpu-render-worker-with-an-unbroken-machine-identifier-01";
const machines: ExecutionData["machines"] = [
  {
    id: "local",
    label: "控制主机",
    status: "online",
    os: "linux",
    arch: "x64",
    tags: ["control", "fast-disk"],
    health: {
      status: "passed",
      checked_at: fresh,
      blockers: [],
      available: true,
    },
    capabilities: [
      "browser.chromium 157.0.8103.15",
      "docker 28.1.1",
      "godot 4.7.1",
      "node 24.22.2",
      "python 3.12.7",
    ].map((entry) => {
      const [key = "", version = null] = entry.split(" ");
      return { key, version, verified_at: fresh, available: true };
    }),
  },
  {
    id: "mac-mini",
    label: "Mac mini（sensen 模拟器与 Blender 渲染，长名称换行检查）",
    status: "degraded",
    os: "darwin",
    arch: "arm64",
    tags: ["sensen-only", "office", "simulator-host-with-a-long-tag-name"],
    health: {
      status: "failed",
      checked_at: fresh,
      blockers: ["machine_not_ready", "machine_platform_mismatch"],
      available: false,
    },
    capabilities: [
      { key: "xcode", version: "26.1", verified_at: fresh, available: true },
      {
        key: "ios.simulator",
        version: "26.1",
        verified_at: fresh,
        available: true,
      },
      { key: "blender", version: "4.5.3", verified_at: old, available: false },
      { key: "gpu.apple", version: null, verified_at: old, available: false },
    ],
  },
  {
    id: "cardigan-ci",
    label: "CI 构建机",
    status: "draining",
    os: "linux",
    arch: "x64",
    tags: [],
    health: {
      status: "checking",
      checked_at: fresh,
      blockers: [],
      available: false,
    },
    capabilities: [],
  },
  { id: longId, label: longId, status: "offline", tags: [], health: null },
];
const base = executionDisplayFixture();
const execution: ExecutionData = {
  machines,
  assignments: base.assignments.map((a, i) => {
    const machine = machines[i % 2]?.id ?? "local";
    return {
      ...a,
      machine_id: machine,
      runtime_ref: a.runtime_ref
        ? { ...a.runtime_ref, machine_id: machine, runtime_machine: machine }
        : null,
    };
  }),
  runs: base.runs,
};
const capacity: ExecutionCapacity = {
  agents: [
    {
      machine_id: "local",
      label: "控制主机",
      running: 8,
      total_running: 10,
      limit: 12,
      max_limit: 16,
      queued: 3,
      merge_check_slots: 2,
      resources: [
        { key: "browser.chromium", occupied: 2, limit: 4 },
        { key: "godot", occupied: 2, limit: 2 },
      ],
    },
    {
      machine_id: "mac-mini",
      label: "Mac mini（sensen 模拟器与 Blender 渲染，长名称换行检查）",
      running: 1,
      total_running: 1,
      limit: 3,
      max_limit: 3,
      queued: 0,
      merge_check_slots: 0,
      resources: [
        { key: "android.emulator", occupied: 0, limit: 1 },
        { key: "blender", occupied: 1, limit: 2 },
        { key: "ios.simulator", occupied: 1, limit: 1 },
      ],
    },
    {
      machine_id: "cardigan-ci",
      label: "CI 构建机",
      running: 0,
      total_running: 0,
      limit: 0,
      max_limit: 4,
      queued: 0,
      merge_check_slots: 0,
      resources: [],
    },
  ],
  merge_checks: [
    {
      machine_id: "local",
      executor_type: "local",
      running: 1,
      limit: 1,
      queued: 0,
    },
  ],
  merge_config_invalid: false,
};
const detail = cardDetail();
const items: WorkItemView[] = [
  {
    ...(detail.work_items[0] as WorkItemView),
    title: "前端开发",
    role_id: "frontend_engineer",
    status: "in_progress",
    requirements: {
      os: "linux",
      capabilities: ["browser.chromium", "godot>=4.7"],
      tags: ["fast-disk"],
    },
    machine_selection: {
      status: "selected",
      at: fresh,
      machine_id: "local",
      assignment_id: "A-1",
      candidates: [
        {
          machine_id: "local",
          affinity: true,
          control_host: false,
          limit: 12,
          occupied: 8,
          remaining_ratio: 1 / 3,
          preference_rank: 0,
        },
      ],
      excluded: [
        {
          machine_id: "cardigan-ci",
          reasons: [
            "draining",
            "服务端远程 Git 工作树准备尚未验证（角色工作树策略：write）",
            "allow_remote_launch 未开启",
          ],
        },
        {
          machine_id: "mac-mini",
          reasons: [
            "os=linux",
            "tag=fast-disk",
            "godot>=4.7：未验证",
            "健康检查未通过",
          ],
        },
        { machine_id: longId, reasons: ["offline", "缺少健康快照"] },
      ],
    },
  },
  {
    ...(detail.work_items[1] as WorkItemView),
    title: "界面验收",
    role_id: "design_director",
    machine_selection: {
      status: "deferred",
      at: fresh,
      reason:
        "有多个候选机器，请明确指定 machine_id：cardigan-ci, local, mac-mini；E-14：有多个候选机器，请明确指定 machine_id：cardigan-ci, local, mac-mini",
    },
  },
];
const cardView = {
  ...card,
  id: "C-1",
  title: "机器能力 MC-5：执行视图与工作项显示能力、需求和选机原因",
  status: "in_progress" as const,
};
const client = fakeClient({
  subscribe: (_project, callbacks) => {
    callbacks.status("live");
    return () => {};
  },
  cards: async (_project, filter) => ({
    project_id: "p-1",
    filter,
    cards: [cardView],
    counts: { total: 1, needs_me: 0, agent: 1 },
  }),
  card: async (): Promise<CardDetail> => ({
    ...detail,
    card: cardView,
    work_items: items,
    attachments: [],
  }),
  execution: async () => execution,
  executionRuns: async () => ({ runs: [], total: 0, next_cursor: null }),
  executionCapacity: async () => capacity,
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(<App client={client} />);
