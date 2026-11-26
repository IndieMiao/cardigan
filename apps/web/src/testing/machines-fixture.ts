import type { MachineBindingView, MachineView } from "../api.js";

/**
 * C-512: synthetic machine read (no host, no live data). Three machines: the
 * control host bound to two projects with work in flight, a Linux worker bound
 * only to this project whose worker check failed, and a draining macOS worker
 * bound only to another project whose configuration and worker record the
 * host could not read.
 */
const binding = (
  patch: Partial<MachineBindingView> & Pick<MachineBindingView, "project_id">,
): MachineBindingView => ({
  project_name: patch.project_id,
  is_current: false,
  status: "online",
  last_seen: "2025-12-31T23:59:30.000Z",
  runtime: null,
  config_available: true,
  capabilities: [],
  machine_check: null,
  last_requested_check: null,
  worker_check: null,
  worker_record_readable: true,
  assignments: [],
  ...patch,
});

export const fixtureMachines: readonly MachineView[] = [
  {
    id: "local",
    label: "本机",
    os: "linux",
    arch: "x64",
    status: "online",
    last_seen: "2025-12-31T23:59:30.000Z",
    run_limit: 6,
    run_limit_maximum: 16,
    resources: [
      { key: "browser.chromium", limit: 2 },
      { key: "gpu", limit: 1 },
    ],
    bindings: [
      binding({
        project_id: "p-1",
        project_name: "Cardigan",
        is_current: true,
        runtime: {
          account: null,
          directory: null,
          session: "cardigan",
          path_entries: 0,
        },
        capabilities: [
          {
            key: "harness.codex",
            version: "0.98.0",
            verified_at: "2025-12-31T22:00:00.000Z",
            available: true,
            state: "verified",
          },
          {
            key: "browser.chromium",
            version: "157.0.8103.15",
            verified_at: "2025-12-31T22:00:00.000Z",
            available: true,
            state: "verified",
          },
          {
            key: "harness.claude-code",
            version: "2.4.1",
            verified_at: "2025-12-30T08:00:00.000Z",
            available: false,
            state: "expired",
          },
          {
            key: "harness.pi",
            version: null,
            verified_at: null,
            available: false,
            state: "unverified",
          },
        ],
        machine_check: {
          status: "passed",
          checked_at: "2025-12-31T22:00:00.000Z",
          blockers: [],
          available: true,
        },
        last_requested_check: {
          id: "c-1",
          kind: "machine",
          status: "passed",
          step: "done",
          checked_at: "2025-12-31T22:00:00.000Z",
          failed_steps: [],
        },
        assignments: [
          {
            assignment_id: "A-12",
            role_id: "coder",
            employee_id: "E-1",
            employee_name: "薛宝钗",
            card_id: "C-1",
            runs: [{ id: "R-31", status: "running", card_id: "C-1" }],
          },
          {
            assignment_id: "A-13",
            role_id: "reviewer",
            employee_id: "E-2",
            employee_name: "林黛玉",
            card_id: "C-2",
            runs: [{ id: "R-32", status: "dispatched", card_id: "C-2" }],
          },
        ],
      }),
      binding({
        project_id: "peer",
        project_name: "示例项目",
        runtime: {
          account: null,
          directory: null,
          session: "example",
          path_entries: 0,
        },
        // Evidence observed by the other project only.
        capabilities: [
          {
            key: "node",
            version: "24",
            verified_at: "2025-12-31T20:00:00.000Z",
            available: true,
            state: "verified",
          },
        ],
        machine_check: {
          status: "passed",
          checked_at: "2025-12-31T20:00:00.000Z",
          blockers: [],
          available: true,
        },
        assignments: [
          {
            assignment_id: "A-7",
            role_id: "pm",
            employee_id: "E-6",
            employee_name: "王熙凤",
            card_id: null,
            // Run ids are per project: this R-31 is not Cardigan's R-31.
            runs: [{ id: "R-31", status: "acked", card_id: "C-40" }],
          },
        ],
      }),
    ],
  },
  {
    id: "builder",
    label: "构建机",
    os: "linux",
    arch: "arm64",
    status: "degraded",
    last_seen: "2025-12-31T23:40:00.000Z",
    run_limit: 4,
    run_limit_maximum: 8,
    resources: [],
    bindings: [
      binding({
        project_id: "p-1",
        project_name: "Cardigan",
        is_current: true,
        status: "degraded",
        last_seen: "2025-12-31T23:40:00.000Z",
        runtime: {
          account: "agent_builder",
          directory: "/opt/agents/example",
          session: "builder",
          path_entries: 4,
        },
        capabilities: [
          {
            key: "harness.codex",
            version: "0.98.0",
            verified_at: "2025-12-31T21:00:00.000Z",
            available: true,
            state: "verified",
          },
        ],
        machine_check: {
          status: "failed",
          checked_at: "2025-12-31T23:10:00.000Z",
          blockers: ["machine_check_failed"],
          available: false,
          // C-608: the readiness patrol's fixed per-item results.
          readiness: {
            checked_at: "2025-12-31T23:10:00.000Z",
            items: [
              {
                key: "disk",
                status: "repaired",
                detail: "已自动清理 4 处缓存，释放 18.2 GiB，可用 34.0 GiB",
              },
              {
                key: "network",
                status: "warning",
                detail:
                  "链路慢：下行 0.6 MB/s，往返 820 ms（阈值 2.0 MB/s、500 ms）",
              },
              {
                key: "mcp",
                status: "failed",
                detail: "Card MCP 不可达（mcp_timeout），暂停向该机器派发",
              },
              { key: "helper", status: "ok", detail: "与当前部署一致" },
              {
                key: "avd:Pixel_7",
                status: "warning",
                detail: "AVD 文件无法读取（检查外接盘与系统隐私权限）",
              },
            ],
          },
        },
        worker_check: {
          status: "failed",
          checked_at: "2025-12-31T23:20:00.000Z",
          failed_steps: ["ssh", "helper"],
        },
        last_requested_check: {
          id: "c-2",
          kind: "worker",
          status: "failed",
          step: "helper",
          checked_at: "2025-12-31T23:20:00.000Z",
          failed_steps: ["ssh", "helper"],
        },
      }),
    ],
  },
  {
    id: "mac-mini",
    label: "Mac mini",
    os: "darwin",
    arch: "arm64",
    status: "draining",
    last_seen: "2025-12-31T18:00:00.000Z",
    run_limit: 1,
    run_limit_maximum: 4,
    resources: [],
    bindings: [
      binding({
        project_id: "peer",
        project_name: "示例项目",
        status: "draining",
        last_seen: "2025-12-31T18:00:00.000Z",
        config_available: false,
        worker_record_readable: false,
      }),
    ],
  },
];
