import type { SessionMaintenanceReason } from "@cardigan/domain";
import type { ExecutionData } from "../api.js";
import { executionDisplayFixture } from "./execution-display-fixture.js";

/** Fixed C-402 fixture: eight internal identities, no production data or randomness. */
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
  ];
  return {
    machines: [],
    runs: [],
    assignments: empty
      ? []
      : base.assignments.map((a, i) => ({
          ...a,
          status: "active",
          runtime_state: "idle",
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
            reason: reasons[i] ?? "stale",
            candidate: [2, 3].includes(i),
            threshold_minutes: 60,
            since: "2026-11-17T00:00:00Z",
            evaluated_at: "2026-11-17T02:00:00Z",
          },
        })),
  };
}
