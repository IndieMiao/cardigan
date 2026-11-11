import { parseLaunchConfig } from "@cardigan/roles";
import { expect, test } from "vitest";
import {
  fixture,
  id,
} from "../../../../packages/domain/src/commands/test-fixtures.js";
import {
  launchLookup,
  profileEffort,
  runLaunchFields,
} from "./launch-summary.js";
import { executionRunPage, executionView } from "./read.js";

const config = parseLaunchConfig({
  profiles: {
    claude: {
      harness: "claude-code",
      model: "fixture-model",
      args: ["--effort", "xhigh"],
    },
    codex: {
      harness: "codex",
      model: "gpt-x",
      config: { model_reasoning_effort: "high" },
    },
    pi: { harness: "pi", model: "fixture-model" },
  },
});
const lookup = launchLookup(config);

test("C-106: effort only comes from structured profile fields", () => {
  expect(
    profileEffort({ harness: "claude-code", args: ["--effort=low"] }),
  ).toBe("low");
  expect(profileEffort({ harness: "claude-code", args: ["--effort"] })).toBe(
    null,
  );
  expect(profileEffort({ harness: "claude-code" })).toBe(null);
  expect(
    profileEffort({ harness: "codex", config: { model_reasoning_effort: 1 } }),
  ).toBe(null);
  // Pi has no structured effort; an --effort lookalike is not guessed.
  expect(profileEffort({ harness: "pi", args: ["--effort", "high"] })).toBe(
    null,
  );
});

test("C-106: a Run's harness and effort come from its launch profile", () => {
  expect(
    runLaunchFields(
      { model: "fixture-model", launch_profile_ref: "claude" },
      lookup,
    ),
  ).toEqual({ harness: "claude-code", effort: "xhigh" });
  expect(
    runLaunchFields({ model: "gpt-x", launch_profile_ref: "codex" }, lookup),
  ).toEqual({ harness: "codex", effort: "high" });
  expect(
    runLaunchFields(
      { model: "fixture-model", launch_profile_ref: "pi" },
      lookup,
    ),
  ).toEqual({ harness: "pi", effort: null });
});

test("C-106: unknown, changed or missing profiles stay unknown", () => {
  const none = { harness: null, effort: null };
  // Legacy Run without a profile reference.
  expect(runLaunchFields({ model: "fixture-model" }, lookup)).toEqual(none);
  // Profile removed from launch.yaml.
  expect(
    runLaunchFields({ model: "m", launch_profile_ref: "gone" }, lookup),
  ).toEqual(none);
  // Inherited object keys are not profiles.
  expect(
    runLaunchFields({ model: "m", launch_profile_ref: "toString" }, lookup),
  ).toEqual(none);
  // The profile's model changed after the Run started.
  expect(
    runLaunchFields(
      { model: "older-model", launch_profile_ref: "claude" },
      lookup,
    ),
  ).toEqual(none);
  // No launch configuration wired (tests, MCP-only servers).
  expect(
    runLaunchFields(
      { model: "fixture-model", launch_profile_ref: "claude" },
      undefined,
    ),
  ).toEqual(none);
});

test("C-106: the execution view and Run history carry harness and effort", () => {
  const base = fixture();
  const state = {
    ...base,
    runs: base.runs.map((run) =>
      run.id === id("run", 1) ? { ...run, launch_profile_ref: "claude" } : run,
    ),
  };
  const view = executionView(state, "2026-11-11T00:00:00.000Z", [], [], lookup);
  const first = view.runs.find((run) => run.id === id("run", 1));
  expect(first).toMatchObject({ harness: "claude-code", effort: "xhigh" });
  for (const run of view.runs.filter((run) => run.id !== id("run", 1)))
    expect(run).toMatchObject({ harness: null, effort: null });

  const page = executionRunPage(
    state,
    first?.assignment_id ?? "",
    undefined,
    [],
    lookup,
  );
  expect(page?.runs.find((run) => run.id === id("run", 1))).toMatchObject({
    harness: "claude-code",
    effort: "xhigh",
  });
  // Without a launch configuration the fields are present and unknown.
  const bare = executionView(state, "2026-11-11T00:00:00.000Z");
  expect(bare.runs.find((run) => run.id === id("run", 1))).toMatchObject({
    harness: null,
    effort: null,
  });
});
