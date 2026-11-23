import { Store } from "@cardigan/store";
import { expect, test } from "vitest";
import { MachineChecks } from "./machine-checks.js";
import type { MachineHost } from "./machine-host.js";

// C-599: every caller that owns a machine check slot keeps the tools outcome
// (never a command) so a CLI check that joins it reads the same conclusion.
test.each(["start", "recovery"] as const)(
  "C-599: a %s machine check stores the attachment tools outcome without a command",
  async (path) => {
    const store = Store.open({ dbPath: ":memory:" });
    try {
      const project = "sample";
      store.createProject({ id: project });
      store.uow.run((tx) =>
        tx.machines.put(project, {
          id: "remote",
          herdr_machine: "remote",
          label: "Remote",
          os: "linux",
          arch: "arm64",
          tags: [],
          max_assignments: 1,
          status: "online",
          last_seen: "2026-11-23T00:00:00.000Z",
        }),
      );
      const outcome = {
        status: "ready" as const,
        human_action_id: "H-1",
        key: `worker-agent-tools:remote:${"a".repeat(64)}`,
      };
      const host = {
        check: async (_p: string, _m: string, kind: string) =>
          kind === "machine"
            ? { status: "passed", failed_steps: [], agent_tools: outcome }
            : { status: "passed", failed_steps: [] },
        bindingFingerprint: () => "pinned",
      } as unknown as MachineHost;
      const checks = new MachineChecks(
        store,
        { now: () => new Date().toISOString() },
        new AbortController().signal,
        host,
      );
      if (path === "start") {
        checks.start(project, "remote", "machine", () => "member");
        await checks.settled();
      } else {
        await checks.verifyHelper(project, "remote", "pinned", {
          onVerified: () => {},
        });
      }
      const job = checks.latest("remote", project, "machine");
      expect(job?.agent_tools).toEqual(outcome);
      expect(JSON.stringify(job)).not.toContain("sudo");
    } finally {
      store.close();
    }
  },
);
