import { expect, test } from "vitest";
import {
  assignment,
  fixture,
  id,
  ports,
  run,
  value,
} from "./commands/test-fixtures.js";
import { recordUpstreamHealth } from "./commands/upstream-health.js";
import { currentInteraction, type InteractionSample } from "./interaction.js";
import {
  DEFAULT_UPSTREAM_POLICY,
  diagnoseUpstream,
} from "./upstream-health.js";

const now = "2026-01-01T00:20:00.000Z";
function scenario() {
  const ref = {
    machine_id: "local",
    runtime_machine: "local",
    terminal_ref: "t1",
    agent_name: "fixture",
    launch_generation: { run_id: id("run", 1), generation: "one" },
  };
  const state = {
    ...fixture(),
    assignments: [1, 2, 3].map((n) => ({
      ...assignment(n),
      runtime_ref: { ...ref, terminal_ref: `t${n}` },
    })),
    runs: [run(1), run(2), run(3)],
  };
  const p = ports();
  state.events = [1, 2, 3].map((n) => ({
    id: p.ids.nextEventId(),
    seq: n,
    type: "run_inactive",
    actor: { kind: "system" as const, project_id: state.project_id },
    payload: { assignment_id: id("assignment", n), run_id: id("run", n) },
    created_at: now,
  }));
  const targets = state.assignments.map((a) => ({
    assignment_id: a.id,
    provider: "fixture",
    group: "fixture",
  }));
  const samples: Record<string, InteractionSample> = Object.fromEntries(
    state.assignments.map((a, index) => [
      a.id,
      {
        interaction: "confirmation",
        project_id: state.project_id,
        assignment_id: a.id,
        run_id: id("run", index + 1),
        runtime_ref: a.runtime_ref,
        observed_at: now,
        stale_after_ms: 30000,
      },
    ]),
  );
  return { state, targets, samples };
}
test("fresh confirmation waits do not create a line incident or authorize restart", () => {
  const { state, targets, samples } = scenario();
  const p = { ...ports(), clock: { now: () => now } };
  const result = value(
    recordUpstreamHealth(
      state,
      { kind: "system", project_id: state.project_id },
      {
        targets,
        probes: [],
        activity: samples,
        policy: DEFAULT_UPSTREAM_POLICY,
      },
      p,
    ),
  );
  expect(
    result.events.some((e) => e.type === "upstream_incident_started"),
  ).toBe(false);
  const target = targets[0];
  if (!target) throw new Error("fixture");
  expect(
    diagnoseUpstream(
      state,
      target,
      targets,
      [],
      DEFAULT_UPSTREAM_POLICY,
      now,
      samples,
    ),
  ).toMatchObject({ cause: "waiting_confirmation", action: "wait" });
  const failed = [
    {
      provider: "fixture",
      group: "fixture",
      status: "unreachable" as const,
      checked_at: now,
    },
  ];
  expect(
    value(
      recordUpstreamHealth(
        state,
        { kind: "system", project_id: state.project_id },
        {
          targets,
          probes: failed,
          activity: samples,
          policy: DEFAULT_UPSTREAM_POLICY,
        },
        p,
      ),
    ).events.some((e) => e.type === "upstream_incident_started"),
  ).toBe(true);
  expect(
    diagnoseUpstream(
      state,
      target,
      targets,
      failed,
      DEFAULT_UPSTREAM_POLICY,
      now,
      samples,
    ).evidence,
  ).toContain("connection_probe_failed");
});
test("identity, full reference, latest Run, status, age and future samples are rechecked", () => {
  const { state, samples } = scenario();
  const sample = samples["A-1"];
  if (!sample) throw new Error("fixture");
  expect(currentInteraction(state, sample, now)).toBe(sample);
  for (const changed of [
    { project_id: "other" as never },
    { assignment_id: id("assignment", 99) },
    { run_id: id("run", 99) },
    {
      runtime_ref: {
        ...sample.runtime_ref,
        launch_generation: { run_id: id("run", 1), generation: "two" },
      },
    },
    { observed_at: "2026-01-01T00:19:29.999Z" },
    { observed_at: "2026-01-01T00:20:00.001Z" },
  ])
    expect(
      currentInteraction(state, { ...sample, ...changed }, now),
    ).toBeUndefined();
  expect(
    currentInteraction(
      {
        ...state,
        assignments: state.assignments.map((a) => ({
          ...a,
          status: "released" as const,
        })),
      },
      sample,
      now,
    ),
  ).toBeUndefined();
  expect(
    currentInteraction(
      {
        ...state,
        runs: state.runs.map((r) => ({ ...r, status: "cancelled" as const })),
      },
      sample,
      now,
    ),
  ).toBeUndefined();
});
test.each(["unknown", "blocked", "exited"] as const)(
  "%s is explicit and never proof of a line fault",
  (interaction) => {
    const { state, targets, samples } = scenario();
    const all = Object.fromEntries(
      Object.entries(samples).map(([id, sample]) => [
        id,
        { ...sample, interaction },
      ]),
    );
    const target = targets[0];
    if (!target) throw new Error("fixture");
    expect(
      diagnoseUpstream(
        state,
        target,
        targets,
        [],
        DEFAULT_UPSTREAM_POLICY,
        now,
        all,
      ),
    ).toMatchObject({
      cause:
        interaction === "blocked"
          ? "waiting_interaction"
          : interaction === "exited"
            ? "runtime_exited"
            : "unknown",
      action: "wait",
    });
  },
);
