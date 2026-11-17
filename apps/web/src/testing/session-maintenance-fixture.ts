import type { SessionMaintenanceReason } from "@cardigan/domain";
import type { ExecutionData } from "../api.js";
import { executionDisplayFixture } from "./execution-display-fixture.js";

/** Fixed C-402 fixture: 14 internal identities and one running Run; no production data. */
export function sessionMaintenanceFixture(empty = false): ExecutionData {
  const base = executionDisplayFixture();
  const reasons: SessionMaintenanceReason[] = [
    "run_busy",
    "observation_incomplete",
    "unsupported_capability",
    "publication_pending",
    "role_conflict",
    "no_session",
    "retirement_timeout",
    "retirement_pending",
    "maintenance_locked",
    "recent_activity",
    "idle_candidate",
    "exited",
    "stale",
    "retirement_unavailable",
  ];
  return {
    machines: [],
    runs: empty
      ? []
      : [{ ...base.runs[0]!, started_at: "2026-11-17T01:30:00Z" }],
    assignments: empty
      ? []
      : reasons.map((reason, i) => {
          const { queue_ahead: _queue, ...a } =
            base.assignments[i % base.assignments.length]!;
          return {
            ...a,
            id: `A-${i + 1}`,
            status: "active",
            runtime_state:
              reason === "run_busy"
                ? "running"
                : reason === "no_session"
                  ? "not_provisioned"
                  : "idle",
            runtime_ref:
              reason === "no_session"
                ? null
                : { terminal_ref: `t-${i}`, runtime_machine: "fixture" },
            last_mcp_activity_at:
              reason === "recent_activity"
                ? "2026-11-17T01:50:00Z"
                : "2026-11-17T00:00:00Z",
            standing_mode: null,
            external: false,
            role_id: "coder",
            card_id: `C-${i + 1}`,
            work_item_id: `W-${i + 1}`,
            employee: {
              id: `E-${i + 1}`,
              name:
                i === 0
                  ? "合成超长姓名用于验证换行与键盘可达性"
                  : `合成员工 ${i + 1}`,
              title: "开发工程师",
              avatar: null,
            },
            session_maintenance: {
              reason,
              candidate: [1, 2, 3, 4, 6, 7, 8, 10, 13].includes(i),
              threshold_minutes: 60,
              since: "2026-11-17T00:00:00Z",
              evaluated_at: "2026-11-17T02:00:00Z",
            },
          };
        }),
  };
}
