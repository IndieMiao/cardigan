import { postComment } from "@cardigan/domain";
import { RepositoryLockTimeoutError } from "@cardigan/git-service";
import { launchRun } from "@cardigan/host";
import { parseLaunchConfig } from "@cardigan/roles";
import { expect, test, vi } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import { Dispatcher, type DispatcherOptions } from "./dispatch.js";

// C-295 investigation: this records the current initial-launch recovery gap,
// not the desired retry policy. Update it when the approved policy is wired in.
test.each([
  new RepositoryLockTimeoutError(30_000),
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
