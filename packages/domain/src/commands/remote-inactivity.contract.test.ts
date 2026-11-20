import { expect, test } from "vitest";
import { claimInactiveRunStop } from "./inactive-run.js";
import { assignment, fixture, ports, run, value } from "./test-fixtures.js";

test.each(["claude-code", "codex", "pi"] as const)(
  "MCP silence alone cannot claim a stop fence for remote %s",
  (harness) => {
    const a = {
      ...assignment(),
      machine_id: "worker",
      runtime_ref: {
        machine_id: "worker",
        runtime_machine: "worker",
        terminal_ref: "worker/t1",
        agent_name: "fixture",
      },
    };
    const r = { ...run(), harness };
    const state = { ...fixture(), assignments: [a], runs: [r] };
    const io = { ...ports(), clock: { now: () => "2026-01-01T01:00:00.000Z" } };
    const claim = (ref?: string) =>
      value(
        claimInactiveRunStop(
          state,
          { kind: "system", project_id: state.project_id },
          {
            run_id: r.id,
            after_ms: 3600000,
            ...(ref
              ? {
                  harness_activity: {
                    assignment_id: a.id,
                    run_id: r.id,
                    session_id: "fixture-session",
                    runtime_key: ref,
                    updated_at: a.created_at,
                    stale_after_ms: 600000,
                    source: `${harness}:session_metadata`,
                  },
                }
              : {}),
          },
          io,
        ),
      );
    expect(claim().changes).toEqual([]);
    expect(claim("previous generation").changes).toEqual([]);
    expect(
      claim(JSON.stringify(a.runtime_ref)).data?.inactivity_stop,
    ).toBeDefined();
  },
);
