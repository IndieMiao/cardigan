import { expect, test } from "vitest";
import { exitConfirmationText } from "./host-ops.js";

const action = {
  tool: "host_ops_restart_assignment" as const,
  assignment_id: "A-7",
  run_id: "R-9",
  runtime_ref: {
    machine_id: "local",
    runtime_machine: "local",
    terminal_ref: "cardigan-A-7",
    agent_name: "claude",
  },
};

test("C-153#3 hc commands name the registered session, defaulting to cardigan", () => {
  const registered = exitConfirmationText(action, "agent-ssh", "prod-hc");
  expect(registered.instructions).toContain(
    'HC_SESSION=prod-hc HC_SOCKET="$XDG_RUNTIME_DIR/cardigan/prod-hc.sock" hc kill cardigan-A-7',
  );
  expect(registered.instructions).toContain(
    "会话名 prod-hc 取自 server 登记的运行时 runtime.json",
  );
  expect(registered.instructions).not.toContain("请替换会话名");

  expect(exitConfirmationText(action, "agent-ssh").instructions).toContain(
    'HC_SESSION=cardigan HC_SOCKET="$XDG_RUNTIME_DIR/cardigan/cardigan.sock" hc get cardigan-A-7 --json',
  );
});

test("C-153#3 an unexpected session name is shell-quoted", () => {
  const { instructions } = exitConfirmationText(action, "agent-ssh", "a b'c");
  expect(instructions).toContain(
    `HC_SESSION='a b'\\''c' HC_SOCKET="$XDG_RUNTIME_DIR/cardigan/"'a b'\\''c'.sock hc`,
  );
});
