import { beforeEach, expect, test } from "vitest";
import {
  acknowledgeRun,
  dispatchRun,
  finishRun,
  HARNESSES,
  type Harness,
  queueRun,
} from "../index.js";
import { CommandDraft } from "./core.js";
import {
  actor,
  commit,
  f,
  queue,
  ref,
  setup,
  system,
} from "./launch/test-fixtures.js";
import { queueResumedRun } from "./resumption.js";
import { apply, fixture, human, id, ports, subject } from "./test-fixtures.js";

beforeEach(setup);

const runOf = (runId: string) => f.state.runs.find((r) => r.id === runId);
const launch = (
  runId: string,
  settings: {
    harness?: Harness;
    effort?: string;
    launch_fingerprint?: string;
  },
  runtime_ref = ref,
) =>
  commit(
    dispatchRun(
      f.state,
      system,
      {
        run_id: runId as never,
        runtime_ref,
        base_sha: subject.value,
        launch_snapshot: {
          model: "fixture-model",
          agent_cli_version: "1.2.3",
          ...settings,
        },
      },
      f.io,
    ),
  );
const finish = (runId: string) => {
  commit(acknowledgeRun(f.state, actor(), { run_id: runId as never }, f.io));
  commit(
    finishRun(
      f.state,
      actor(),
      { run_id: runId as never, outcome: "completed", summary: "done" },
      f.io,
    ),
  );
};

test("C-106 invariant 12: queueRun records the launch settings snapshot beside the model", () => {
  const run = commit(
    queueRun(
      f.state,
      human,
      {
        assignment_id: f.coder.id,
        model: "m",
        agent_cli_version: "1",
        harness: "codex",
        effort: "high",
      },
      f.io,
    ),
  );
  expect(runOf(run.id)).toMatchObject({ harness: "codex", effort: "high" });
  // Unknown settings are absent, never empty strings or guesses.
  setup();
  const bare = commit(queue());
  expect(runOf(bare.id)).not.toHaveProperty("harness");
  expect(runOf(bare.id)).not.toHaveProperty("effort");
});

test.each(HARNESSES)(
  "LP-3 invariant 12: dispatch preserves registered harness %s in the Run snapshot",
  (harness) => {
    const run = commit(queue());
    launch(run.id, { harness });
    expect(runOf(run.id)?.harness).toBe(harness);
  },
);

test("C-106: invalid launch settings are rejected", () => {
  for (const settings of [
    { harness: "vim" },
    { harness: "toString" },
    { harness: "claude" },
    { effort: " " },
  ]) {
    const result = queueRun(
      f.state,
      human,
      {
        assignment_id: f.coder.id,
        model: "m",
        agent_cli_version: "1",
        ...(settings as object),
      },
      f.io,
    );
    expect(result.ok).toBe(false);
  }
});

test("C-106: a launch snapshot replaces the queued settings as a whole", () => {
  const run = commit(
    queueRun(
      f.state,
      human,
      {
        assignment_id: f.coder.id,
        model: "m",
        agent_cli_version: "1",
        harness: "codex",
        effort: "high",
      },
      f.io,
    ),
  );
  // The new session states only its harness: the queued effort must not stay.
  launch(run.id, { harness: "claude-code" });
  expect(runOf(run.id)?.harness).toBe("claude-code");
  expect(runOf(run.id)).not.toHaveProperty("effort");
});

test("C-106: a Run on the existing terminal takes its session's settings, not later config", () => {
  const first = commit(queue());
  launch(first.id, {
    harness: "codex",
    effort: "high",
    launch_fingerprint: "a".repeat(64),
  });
  finish(first.id);
  // Queued later with different values (e.g. after launch.yaml changed); the
  // live session still runs with what it was started with.
  const next = commit(
    queueRun(
      f.state,
      human,
      {
        assignment_id: f.coder.id,
        model: "fixture-model",
        agent_cli_version: "1.2.3",
        harness: "codex",
        effort: "low",
      },
      f.io,
    ),
  );
  commit(dispatchRun(f.state, human, { run_id: next.id }, f.io));
  expect(runOf(next.id)).toMatchObject({ harness: "codex", effort: "high" });

  expect(runOf(next.id)?.launch_fingerprint).toBe("a".repeat(64));

  // A new terminal records the new launch's values.
  finish(next.id);
  const replaced = commit(queue());
  launch(
    replaced.id,
    { harness: "codex", effort: "low" },
    {
      ...ref,
      terminal_ref: "t2",
    },
  );
  expect(runOf(replaced.id)).not.toHaveProperty("launch_fingerprint");
  expect(runOf(replaced.id)).toMatchObject({ harness: "codex", effort: "low" });
});

test("C-106: a legacy session without settings keeps them unknown", () => {
  const first = commit(queue());
  launch(first.id, {});
  finish(first.id);
  const next = commit(
    queueRun(
      f.state,
      human,
      {
        assignment_id: f.coder.id,
        model: "fixture-model",
        agent_cli_version: "1.2.3",
        harness: "pi",
      },
      f.io,
    ),
  );
  commit(dispatchRun(f.state, human, { run_id: next.id }, f.io));
  expect(runOf(next.id)).not.toHaveProperty("harness");
});

test("C-106: a Run resumed after a decision copies the previous Run's settings", () => {
  const base = fixture();
  const state = {
    ...base,
    runs: base.runs.map((run) =>
      run.id === id("run", 1)
        ? {
            ...run,
            status: "completed" as const,
            outcome: "blocked" as const,
            harness: "claude-code" as const,
            effort: "xhigh",
          }
        : {
            ...run,
            status: "completed" as const,
            outcome: "completed" as const,
          },
    ),
  };
  const draft = new CommandDraft(state, human, "record_decision", ports());
  const resolved = draft.emit("decision_resolved", id("card", 1), {
    work_item_id: id("work_item", 1),
  });
  const item = state.work_items.find((w) => w.id === id("work_item", 1));
  if (!item) throw new Error("missing fixture work item");
  queueResumedRun(draft, item, resolved);
  const next = apply(state, {
    changes: draft.changes,
    events: draft.events,
    timeline: draft.timeline,
  } as never);
  expect(
    next.runs.find(
      (run) =>
        run.assignment_id === id("assignment", 1) && run.status === "queued",
    ),
  ).toMatchObject({ harness: "claude-code", effort: "xhigh" });
});
