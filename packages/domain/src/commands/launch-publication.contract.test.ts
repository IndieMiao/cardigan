import { beforeEach, expect, test } from "vitest";
import {
  acknowledgeRun,
  type Run,
  recordLaunchPublication,
  releaseAssignment,
  runOccupiesSlot,
} from "../index.js";
import {
  actor,
  commit,
  dispatch,
  f,
  queue,
  setup,
  system,
} from "./launch/test-fixtures.js";

import { human } from "./test-fixtures.js";

beforeEach(setup);
function provision(
  run: Run,
  publication: NonNullable<Run["launch_publication"]>,
) {
  const ref = {
    machine_id: f.coder.machine_id,
    runtime_machine: "local",
    terminal_ref: "t1",
    agent_name: "fixture",
    target: publication.target,
    launch_generation: { run_id: run.id, generation: publication.generation },
  };
  for (const phase of ["published", "provisioning", "provisioned"] as const)
    commit(
      recordLaunchPublication(
        f.state,
        system,
        {
          run_id: run.id,
          expected_generation: publication.generation,
          publication: {
            ...publication,
            phase,
            provision_attempted: phase !== "published",
            runtime_ref: phase === "provisioned" ? ref : null,
          },
        },
        f.io,
      ),
    );
  return ref;
}
function preparing(): {
  run: Run;
  publication: NonNullable<Run["launch_publication"]>;
} {
  const run = commit(queue());
  const publication: NonNullable<Run["launch_publication"]> = {
    generation: "a".repeat(32),
    target: {
      project_id: f.state.project_id,
      machine_id: f.coder.machine_id,
      session: "fixture",
      generation: "one",
      fingerprint: "b".repeat(64),
    },
    phase: "preparing",
    lease_until: "2030-01-01T00:00:00.000Z",
    agent_name: "fixture",
    work_dir: "/worker/worktree",
    sha: null,
    token_id: null,
    runtime_ref: null,
    process: null,
    log_offset: 0,
    artifacts: [],
    wait: false,
    provision_attempted: false,
  };
  return { run, publication };
}
test("invariants 4/11: queued publication reserves capacity and only the host can advance its immutable generation", () => {
  const { run, publication } = preparing();
  expect(
    recordLaunchPublication(
      f.state,
      actor(),
      { run_id: run.id, publication },
      f.io,
    ),
  ).toMatchObject({ ok: false });
  const updated = commit(
    recordLaunchPublication(
      f.state,
      system,
      { run_id: run.id, publication },
      f.io,
    ),
  );
  expect(runOccupiesSlot(updated)).toBe(true);
  for (const patch of [
    { generation: "c".repeat(32) },
    { phase: "started" as const },
    { target: { ...publication.target, machine_id: "other" } },
  ])
    expect(
      recordLaunchPublication(
        f.state,
        system,
        {
          run_id: run.id,
          expected_generation: publication.generation,
          publication: { ...publication, ...patch },
        },
        f.io,
      ),
    ).toMatchObject({ ok: false });
  expect(
    recordLaunchPublication(
      f.state,
      system,
      { run_id: run.id, publication: { ...publication, phase: "stopping" } },
      f.io,
    ),
  ).toMatchObject({ ok: false });
});
test("invariants 4/11: an unknown exit retains a durable slot and blocks late MCP acknowledgement and dispatch", () => {
  const { run, publication } = preparing();
  commit(
    recordLaunchPublication(
      f.state,
      system,
      { run_id: run.id, publication },
      f.io,
    ),
  );
  expect(dispatch(run)).toMatchObject({ ok: false });
  commit(dispatch(run, provision(run, publication)));
  const stopped = commit(
    recordLaunchPublication(
      f.state,
      system,
      {
        run_id: run.id,
        expected_generation: publication.generation,
        publication: {
          ...publication,
          phase: "stopping",
          provision_attempted: true,
        },
      },
      f.io,
    ),
  );
  expect(runOccupiesSlot(stopped)).toBe(true);
  expect(
    acknowledgeRun(f.state, actor(), { run_id: run.id }, f.io),
  ).toMatchObject({ ok: false });
  expect(dispatch(stopped)).toMatchObject({ ok: false });
});
test("C-88: confirmed pre-start withdrawal preserves the original Run and releases its reservation", () => {
  const { run, publication } = preparing();
  commit(
    recordLaunchPublication(
      f.state,
      system,
      { run_id: run.id, publication },
      f.io,
    ),
  );
  commit(dispatch(run, provision(run, publication)));
  const stop = { ...publication, phase: "stopping" as const, wait: true };
  commit(
    recordLaunchPublication(
      f.state,
      system,
      {
        run_id: run.id,
        expected_generation: publication.generation,
        publication: stop,
      },
      f.io,
    ),
  );
  const returned = commit(
    recordLaunchPublication(
      f.state,
      system,
      {
        run_id: run.id,
        expected_generation: publication.generation,
        publication: { ...stop, phase: "exited" },
      },
      f.io,
    ),
  );
  expect(returned).toMatchObject({
    id: run.id,
    status: "queued",
    outcome: null,
  });
  expect(returned.queue_reason).toBe("awaiting_dispatch");
  expect(runOccupiesSlot(returned)).toBe(false);
  expect(f.state.runs).toHaveLength(1);
});

test("pre-provision withdrawal permits queue cancellation only after confirmed cleanup", () => {
  const { run, publication } = preparing();
  const release = () =>
    releaseAssignment(
      f.state,
      human,
      { assignment_id: run.assignment_id, cancel_queued_run_id: run.id },
      { ...f.io, unreservedAssignment: () => true },
    );
  for (const phase of ["preparing", "stopping", "exited"] as const) {
    commit(
      recordLaunchPublication(
        f.state,
        system,
        {
          run_id: run.id,
          ...(phase !== "preparing"
            ? { expected_generation: publication.generation }
            : {}),
          publication: { ...publication, phase, wait: true },
        },
        f.io,
      ),
    );
    expect(release().ok).toBe(phase === "exited");
  }
});
test("confirmed remote withdrawal reports the recorded cause; stopping alone does not abort the Run", () => {
  const { run, publication } = preparing();
  const record = (value: typeof publication) =>
    commit(
      recordLaunchPublication(
        f.state,
        system,
        {
          run_id: run.id,
          publication: value,
          ...(value.phase === "preparing"
            ? {}
            : { expected_generation: publication.generation }),
        },
        f.io,
      ),
    );
  record(publication);
  const reason = "directory preparation: worker Git unavailable";
  const stopped = {
    ...publication,
    phase: "stopping" as const,
    failure_reason: reason,
  };
  expect(runOccupiesSlot(record(stopped))).toBe(true);
  expect(f.state.events.some((e) => e.type === "run_dispatch_aborted")).toBe(
    false,
  );
  expect(
    recordLaunchPublication(
      f.state,
      system,
      {
        run_id: run.id,
        expected_generation: publication.generation,
        publication: {
          ...stopped,
          phase: "exited",
          failure_reason: "overwritten",
        },
      },
      f.io,
    ),
  ).toMatchObject({ ok: false });
  expect(record({ ...stopped, phase: "exited" })).toMatchObject({
    status: "cancelled",
    summary: reason,
  });
  expect(
    f.state.events.find((e) => e.type === "run_dispatch_aborted")?.payload,
  ).toMatchObject({ run_id: run.id, reason });
});
