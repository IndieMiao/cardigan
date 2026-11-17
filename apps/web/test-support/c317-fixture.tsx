import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import { executionDisplayFixture } from "../src/testing/execution-display-fixture.js";
import { fakeClient } from "../src/testing/fixtures.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/styles.css";

// C-317 fixed seed: 8 synthetic assignments, 4 diagnostic states, 3 warnings.
const empty = new URLSearchParams(location.search).has("empty");
const data = executionDisplayFixture();
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
  <App
    client={fakeClient({
      subscribe: (_project, callbacks) => {
        callbacks.status("live");
        return () => {};
      },
      execution: async () => data,
      executionRuns: async () => ({ runs: [], total: 0, next_cursor: null }),
      executionDiagnostics: async () => ({
        configuration: empty
          ? []
          : [
              {
                profile:
                  "synthetic-long-launch-profile-for-layout-check-0123456789",
                code: "codex_approval",
                message:
                  "审批策略可能等待交互确认；请由主机管理员核对生效配置。",
              },
              {
                profile: "synthetic-code",
                code: "codex_context_window",
                message:
                  "未明确配置有效的上下文窗口；请核对配置与模型默认容量。",
              },
              {
                profile: "synthetic-code",
                code: "codex_screen",
                message: "未关闭备用屏幕；终端滚动历史可能不可见。",
              },
            ],
        sessions: empty
          ? []
          : [
              "waiting_confirmation",
              "waiting_interaction",
              "unknown",
              "runtime_exited",
            ].map((cause, i) => ({
              assignment_id: `A-${i + 1}`,
              cause,
              action: "wait",
              evidence: [],
            })),
      }),
    })}
  />,
);
