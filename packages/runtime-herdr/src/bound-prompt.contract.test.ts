import type { RunId, RuntimeRef } from "@cardigan/domain";
import { expect, test, vi } from "vitest";
import type { HcClient } from "./client.js";
import { HC_RELEASE } from "./hc-version.js";
import { HerdrRuntime } from "./index.js";
import { ref, value } from "./test-support.js";

test.each([
  "labelled",
  "project",
  "assignment",
  "generation",
  "run",
  "created",
  "pid",
  "legacy",
  "legacy_alias",
  "legacy_target_missing",
  "legacy_generated",
  "legacy_partial",
  "legacy_empty_labels",
  "legacy_run_label",
  "target_project",
])(
  "bound prompt identity: %s checked at observation and write",
  async (mode) => {
    const legacy = mode.startsWith("legacy");
    const target = {
      project_id: "fixture",
      machine_id: "local",
      session: "fixture",
      generation: "one",
      fingerprint: "fixture-binding",
    };
    const generation = {
      run_id: "R-1" as RunId,
      generation: "a".repeat(32),
    };
    const bound: RuntimeRef = {
      ...ref,
      agent_name:
        legacy && mode !== "legacy_alias"
          ? `coder-${"a".repeat(24)}`
          : ref.agent_name,
      ...(mode === "legacy_target_missing" ? {} : { target }),
      ...((!legacy && mode !== "target_project") || mode === "legacy_generated"
        ? { launch_generation: generation }
        : {}),
    };
    const binding = {
      project_id: mode === "target_project" ? "another" : "fixture",
      assignment_id: "A-1",
      harness: "codex" as const,
    };
    const labelled = {
      project: binding.project_id,
      assignment: binding.assignment_id,
    };
    const generationLabels = {
      run: generation.run_id,
      generation: generation.generation,
    };
    const sent = vi.fn();
    let reads = 0;
    const client: HcClient = {
      available: async () => true,
      async *lines() {},
      exec: async (args) => {
        if (args[0] === "--version") return `hc ${HC_RELEASE.version}`;
        if (args[0] === "read") return "›\n? for shortcuts";
        if (args[0] === "send") {
          sent();
          return "{}";
        }
        const named = args[1] === bound.agent_name;
        const second = named && ++reads % 2 === 0;
        // The direct address check succeeds. A conflicting name lookup inside
        // the slot must still veto the write, independently of that check.
        return JSON.stringify({
          address: bound.terminal_ref,
          state: "live",
          status: { state: "idle" },
          labels: {
            ...(!legacy || !named ? labelled : {}),
            ...(bound.launch_generation ? generationLabels : {}),
            ...(named && mode === "project" ? { project: "other" } : {}),
            ...(named && mode === "assignment" ? { assignment: "A-2" } : {}),
            ...(named && mode === "generation" ? { generation: "other" } : {}),
            ...(named && mode === "run" ? { run: "R-2" } : {}),
            ...(named && mode === "legacy_empty_labels"
              ? { project: "", assignment: "" }
              : {}),
            ...(named && mode === "legacy_run_label" ? { run: "R-9" } : {}),
            ...(named && mode === "legacy_partial"
              ? { project: "fixture" }
              : {}),
          },
          created_ms: mode === "created" && second ? 20 : 10,
          foreground: { name: "codex", pid: mode === "pid" && second ? 2 : 1 },
        });
      },
    };
    const runtime = value(
      await HerdrRuntime.create({
        client,
        session: target.session,
        execution: {
          mode: "local",
          dataDir: "/fixture",
          ...(bound.target ? { target } : {}),
        },
      }),
    );
    const allowed = mode === "labelled" || mode === "legacy";
    expect(value(await runtime.observe_prompt(bound, binding))).toBe(allowed);
    expect(
      value(await runtime.wake(bound, "original", { prompt_binding: binding })),
    ).toEqual(allowed ? { sent: true } : { sent: false, withdrawn: true });
    expect(sent).toHaveBeenCalledTimes(allowed ? 1 : 0);
  },
);
