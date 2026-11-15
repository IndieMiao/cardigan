import { postComment, queueRun, type Runtime } from "@cardigan/domain";
import { RepositoryLockTimeoutError } from "@cardigan/git-service";
import { launchRun, tryHostOpsLock } from "@cardigan/host";
import { parseLaunchConfig } from "@cardigan/roles";
import { expect, test, vi } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import { Dispatcher, type DispatcherOptions } from "./dispatch.js";

// Q-475: permanent failures and unknown hc timeouts must remain closed.
test.each([
  new Error(
    "Git rev-parse timed out after 30000ms; configure CARDIGAN_GIT_QUERY_TIMEOUT_MS",
  ),
  Object.assign(new Error("Permission denied"), { code: "EACCES" }),
  new Error("Unsafe Agent repository directory"),
])(
  "initial directory preparation failure is cancelled without automatic recovery: %s",
  async (error) => {
    const f = dispatchFixture();
    const target = f.create();
    f.apply((state, actor, ports) =>
      postComment(
        state,
        actor,
        {
          card_id: target.card.id,
          work_item_id: target.item.id,
          body: "Start preparation",
        },
        ports,
      ),
    );
    const prepare = vi.fn(async () => {
      throw error;
    });
    const provision = vi.fn();
    const runtime = {
      provision,
      release: vi.fn(),
    } as unknown as DispatcherOptions["runtime"];
    const startRun: DispatcherOptions["startRun"] = async ({
      project,
      assignment,
      run,
      bell,
    }) => {
      await launchRun(
        {
          store: f.store,
          runtime,
          dataDir: f.dataDir,
          clock: f.clock,
          mcpUrl: "http://localhost/mcp",
          launch: {
            config: parseLaunchConfig({
              profiles: { fixture: { harness: "pi", model: "fixture" } },
            }),
            secrets: {},
          },
        },
        {
          project,
          assignment_id: assignment.id,
          run,
          actor: { kind: "system", project_id: project },
          first_prompt: bell,
          prepare_worktree: prepare,
        },
      );
    };
    const options: DispatcherOptions = {
      store: f.store,
      runtime,
      clock: f.clock,
      snapshot: async () => ({
        model: "fixture",
        agent_cli_version: "fixture",
      }),
      startRun,
      onError: vi.fn(),
    };
    try {
      await new Dispatcher(options).tick();
      expect(prepare).toHaveBeenCalledOnce();
      expect(provision).not.toHaveBeenCalled();
      expect(f.state().runs).toMatchObject([
        {
          assignment_id: target.assignment.id,
          status: "cancelled",
          outcome: "failed",
        },
      ]);
      expect(
        f
          .state()
          .events.filter((event) => event.type === "run_dispatch_aborted"),
      ).toHaveLength(1);
      // Recreate the dispatcher across the existing retry and recovery deadlines;
      // the store remains the source of truth, with no fresh trigger event.
      for (const ms of [30_000, 60_000, 120_000, 240_000, 600_000]) {
        f.advance(ms);
        await new Dispatcher(options).tick();
      }
      expect(prepare).toHaveBeenCalledOnce();
      expect(provision).not.toHaveBeenCalled();
      expect(f.state().runs).toHaveLength(1);
      expect(
        f
          .state()
          .events.filter((event) => event.type === "run_dispatch_recovered"),
      ).toHaveLength(0);
      expect(
        f.store.uow.run((tx) =>
          tx.tokensForAssignment(f.project, target.assignment.id),
        ),
      ).toEqual([]);
    } finally {
      f.close();
    }
  },
);

test.each([
  { failAgain: false, timeout: false },
  { failAgain: true, timeout: false },
  { failAgain: false, timeout: true },
  { failAgain: true, timeout: true },
])(
  "a preparation retry is durable, delayed and unique: %j",
  async ({ failAgain, timeout }) => {
    const f = dispatchFixture(),
      target = f.create();
    const error = timeout
      ? Object.assign(new Error("Git rev-parse timed out after 30000ms"), {
          executionExited: true,
        })
      : new RepositoryLockTimeoutError(30_000);
    const prepare = vi
      .fn<() => Promise<undefined>>()
      .mockRejectedValueOnce(error);
    if (failAgain) prepare.mockRejectedValue(error);
    else prepare.mockResolvedValue(undefined);
    const runtime = {
      provision: vi.fn(async () => ({
        ok: true,
        value: f.refFor(target.assignment),
      })),
      status: vi.fn(async () => ({
        ok: true,
        value: { process: "alive", agent: "idle", observed_seq: 1 },
      })),
      release: vi.fn(async () => ({ ok: true, value: undefined })),
    } as unknown as Runtime;
    const options: DispatcherOptions = {
      store: f.store,
      runtime,
      clock: f.clock,
      snapshot: async () => ({
        model: "fixture",
        agent_cli_version: "fixture",
      }),
      startRun: async ({ project, assignment, run, bell }) => {
        await launchRun(
          {
            store: f.store,
            runtime,
            dataDir: f.dataDir,
            clock: f.clock,
            mcpUrl: "http://localhost/mcp",
            launch: {
              config: parseLaunchConfig({
                profiles: { fixture: { harness: "pi", model: "fixture" } },
              }),
              secrets: {},
            },
          },
          {
            project,
            assignment_id: assignment.id,
            run,
            actor: { kind: "system", project_id: project },
            first_prompt: bell,
            prepare_worktree: prepare,
          },
        );
      },
    };
    f.apply((s, a, p) =>
      postComment(
        s,
        a,
        {
          card_id: target.card.id,
          work_item_id: target.item.id,
          body: "Prepare",
        },
        p,
      ),
    );
    try {
      await new Dispatcher(options).tick();
      expect(f.state().runs.map((r) => r.status)).toEqual([
        "cancelled",
        "queued",
      ]);
      expect(f.state().human_actions).toHaveLength(0);
      expect(
        f.state().events.filter((e) => e.type === "bell_delivery_failed"),
      ).toHaveLength(0);
      f.advance(4999);
      await new Dispatcher(options).tick();
      expect(prepare).toHaveBeenCalledTimes(1);
      f.advance(1);
      await new Dispatcher(options).tick();
      expect(prepare).toHaveBeenCalledTimes(2);
      expect(f.state().runs.map((r) => r.status)).toEqual([
        "cancelled",
        failAgain ? "cancelled" : "dispatched",
      ]);
      expect(runtime.provision).toHaveBeenCalledTimes(failAgain ? 0 : 1);
      expect(f.state().human_actions).toHaveLength(failAgain ? 1 : 0);
      await new Dispatcher(options).tick();
      expect(f.state().runs).toHaveLength(2);
      expect(prepare).toHaveBeenCalledTimes(2);
    } finally {
      f.close();
    }
  },
);

test("ten queued Runs prepare in order and each provisions once", async () => {
  const f = dispatchFixture();
  const targets = Array.from({ length: 10 }, () => f.create());
  const runs = targets.map(({ assignment }) =>
    f.apply((s, a, p) =>
      queueRun(
        s,
        a,
        {
          assignment_id: assignment.id,
          model: "fixture",
          agent_cli_version: "fixture",
        },
        p,
      ),
    ),
  );
  const provision = vi.fn(async (a: Parameters<Runtime["provision"]>[0]) => ({
    ok: true as const,
    value: f.refFor(a),
  }));
  const runtime = { provision } as unknown as Runtime;
  let active = 0,
    peak = 0;
  const order: string[] = [];
  try {
    const results = await Promise.all(
      targets.map(({ assignment }, i) => {
        const run = runs[i];
        if (!run) throw new Error("Missing queued Run");
        return launchRun(
          {
            store: f.store,
            runtime,
            dataDir: f.dataDir,
            clock: f.clock,
            mcpUrl: "http://localhost/mcp",
            launch: {
              config: parseLaunchConfig({
                profiles: { fixture: { harness: "pi", model: "fixture" } },
              }),
              secrets: {},
            },
          },
          {
            project: f.project,
            assignment_id: assignment.id,
            run,
            actor: { kind: "human", project_id: f.project },
            reuse_session: true,
            prepare_worktree: async () => {
              peak = Math.max(peak, ++active);
              order.push(assignment.id);
              await Promise.resolve();
              active--;
              return undefined;
            },
          },
        );
      }),
    );
    expect(results).toHaveLength(10);
    expect(new Set(order).size).toBe(10);
    expect(peak).toBe(1);
    expect(provision).toHaveBeenCalledTimes(10);
    expect(f.state().runs.every((r) => r.status === "dispatched")).toBe(true);
    expect(
      f.state().events.filter((e) => e.type === "run_dispatch_aborted"),
    ).toHaveLength(0);
  } finally {
    f.close();
  }
});

test("an expired delivery lease cannot take over a launch whose execution lock is held", async () => {
  const f = dispatchFixture(),
    target = f.create();
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const runtime = { status: vi.fn() } as unknown as Runtime;
  const options: DispatcherOptions = {
    store: f.store,
    runtime,
    clock: f.clock,
    deliveryLeaseMs: 1,
    snapshot: async () => ({ model: "fixture", agent_cli_version: "fixture" }),
    startRun: async () => {
      const unlock = await tryHostOpsLock(
        f.store,
        f.project,
        target.assignment.id,
        "launch",
      );
      if (!unlock) throw new Error("Missing lock");
      try {
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      } finally {
        await unlock();
      }
    },
  };
  f.apply((s, a, p) =>
    postComment(
      s,
      a,
      {
        card_id: target.card.id,
        work_item_id: target.item.id,
        body: "Prepare",
      },
      p,
    ),
  );
  const first = new Dispatcher(options).tick();
  await ready;
  try {
    f.advance(1000);
    await new Dispatcher(options).tick();
    expect(f.state().runs).toHaveLength(1);
    expect(f.state().runs[0]?.status).toBe("queued");
    expect(
      f.state().events.filter((e) => e.type === "run_dispatch_aborted"),
    ).toHaveLength(0);
  } finally {
    release();
    await first;
    f.close();
  }
});
