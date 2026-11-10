import {
  acknowledgeRun,
  dispatchRun,
  finishRun,
  issueInstruction,
  queueRun,
  type Runtime,
} from "@cardigan/domain";
import { afterEach, expect, test, vi } from "vitest";
import { dispatchFixture } from "../../test-support/dispatch.js";
import { Dispatcher, type DispatcherOptions } from "../dispatch.js";

const fixtures: ReturnType<typeof dispatchFixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});

function fixture(finished = true) {
  const f = dispatchFixture();
  fixtures.push(f);
  f.store.uow.run((tx) =>
    tx.employees.put({
      id: "E-1" as never,
      name: "Alice",
      title: "Developer",
      bio: "",
      avatar: null,
      role_id: "coder",
      launch_profile_ref: "old-profile",
      status: "active",
      created_at: f.clock.now(),
      updated_at: f.clock.now(),
    }),
  );
  const { assignment, card, item } = f.create();
  const prior = f.apply((s, a, p) =>
    queueRun(
      s,
      a,
      {
        assignment_id: assignment.id,
        model: "old-model",
        agent_cli_version: "old-cli",
        launch_profile_ref: "old-profile",
      },
      p,
    ),
  );
  f.apply((s, a, p) =>
    dispatchRun(
      s,
      a,
      {
        run_id: prior.id,
        runtime_ref: {
          ...f.refFor(assignment),
          agent_session_id: "old-session",
        },
      },
      p,
    ),
  );
  f.apply(
    (s, a, p) => acknowledgeRun(s, a, { run_id: prior.id }, p),
    f.actorFor(assignment),
  );
  if (finished)
    f.apply(
      (s, a, p) =>
        finishRun(
          s,
          a,
          { run_id: prior.id, outcome: "completed", summary: "Done" },
          p,
        ),
      f.actorFor(assignment),
    );
  // This is the domain command behind Workbench's instruction form.
  const instruct = () =>
    f.apply((s, a, p) =>
      issueInstruction(
        s,
        a,
        { card_id: card.id, work_item_id: item.id, body: "Continue" },
        p,
      ),
    );
  const runtime: Runtime = {
    status: vi.fn(async () => ({
      ok: true,
      value: { process: "alive", agent: "idle", observed_seq: 1 },
    })),
    wake: vi.fn(async () => ({ ok: true, value: { sent: true } })),
    release: vi.fn(async () => ({ ok: true, value: undefined })),
    interrupt: async () => ({ ok: true, value: undefined }),
    human_entry: async () => ({ ok: true, value: "fixture" }),
    provision: async () => {
      throw new Error("host callback owns launch");
    },
    resume_or_replace: async () => {
      throw new Error("not used");
    },
  };
  const options: DispatcherOptions = {
    store: f.store,
    clock: f.clock,
    runtime,
    snapshot: vi.fn(async () => ({
      model: "new-model",
      agent_cli_version: "new-cli",
      launch_profile_ref: "new-profile",
    })),
    startRun: vi.fn(async ({ run, replacement }) => {
      f.apply(
        (s, a, p) =>
          dispatchRun(
            s,
            a,
            {
              run_id: run.id,
              runtime_ref: f.refFor(assignment),
              ...(replacement ? { replacement } : {}),
            },
            p,
          ),
        { kind: "system", project_id: f.project },
      );
    }),
  };
  return { ...f, assignment, prior, instruct, runtime, options };
}

test("Workbench instruction starts a new employee configuration after the previous Run, clearing the old session identity", async () => {
  const f = fixture();
  f.instruct();
  await new Dispatcher(f.options).tick();
  expect(f.options.snapshot).toHaveBeenCalledWith(
    expect.objectContaining({ employee_id: "E-1" }),
    f.project,
  );
  expect(f.runtime.release).toHaveBeenCalledOnce();
  expect(f.runtime.wake).not.toHaveBeenCalled();
  expect(f.options.startRun).toHaveBeenCalledWith(
    expect.objectContaining({
      replacement: expect.objectContaining({
        reason: "launch_profile_changed",
      }),
    }),
  );
  expect(f.state().runs).toHaveLength(2);
  expect(f.state().runs[0]).toMatchObject({
    id: f.prior.id,
    status: "completed",
    model: "old-model",
    launch_profile_ref: "old-profile",
  });
  expect(f.state().runs[1]).toMatchObject({
    status: "dispatched",
    model: "new-model",
    agent_cli_version: "new-cli",
    employee_id: "E-1",
    launch_profile_ref: "new-profile",
  });
  expect(
    f.state().assignments.find((a) => a.id === f.assignment.id),
  ).not.toHaveProperty("session_ref");
});

test("same employee configuration reuses the session's actual CLI snapshot without copying the previous Run ID", async () => {
  const f = fixture();
  f.options = {
    ...f.options,
    snapshot: async () => ({
      model: "old-model",
      agent_cli_version: "new-cli-installed",
      launch_profile_ref: "old-profile",
    }),
  };
  f.instruct();
  await new Dispatcher(f.options).tick();
  expect(f.runtime.release).not.toHaveBeenCalled();
  expect(f.runtime.wake).toHaveBeenCalledOnce();
  expect(f.state().runs[1]).toMatchObject({
    status: "dispatched",
    model: "old-model",
    agent_cli_version: "old-cli",
    launch_profile_ref: "old-profile",
  });
  expect(f.state().runs[1]?.id).not.toBe(f.prior.id);
});

test("a changed employee profile never interrupts an unfinished Run or wakes a session that could not be closed", async () => {
  const busy = fixture(false);
  busy.instruct();
  await new Dispatcher(busy.options).tick();
  expect(busy.runtime.release).not.toHaveBeenCalled();
  expect(busy.options.snapshot).not.toHaveBeenCalled();
  expect(busy.state().runs).toHaveLength(1);
  const idle = fixture();
  vi.mocked(idle.runtime.release).mockResolvedValue({
    ok: false,
    error: { code: "runtime_unavailable", message: "fixture" },
  });
  idle.instruct();
  await new Dispatcher(idle.options).tick();
  expect(idle.options.startRun).not.toHaveBeenCalled();
  expect(idle.runtime.wake).not.toHaveBeenCalled();
  expect(
    idle.store
      .listNotifications({ project_id: idle.project })
      .some((n) => n.status === "delivery_failed"),
  ).toBe(true);
});
