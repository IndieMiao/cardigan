import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { postComment, type Runtime } from "@cardigan/domain";
import { launchRun } from "@cardigan/host";
import { parseLaunchConfig } from "@cardigan/roles";
import { agentCommandError, processClient } from "@cardigan/runtime-herdr";
import { expect, test, vi } from "vitest";
import { preparationExecutionExited } from "../../../packages/host/src/wake-preparation.js";
import { dispatchFixture } from "../test-support/dispatch.js";
import { Dispatcher, type DispatcherOptions } from "./dispatch.js";

// Independent evidence only: an hc connection can end while its remote job
// is still alive. All subprocesses here are local disposable timer fixtures.
test("an hc transport disconnect must not restart preparation before remote exit", async () => {
  const f = dispatchFixture();
  const target = f.create();
  const remote = spawn(
    process.execPath,
    ["-e", "process.stdout.write('ready');setTimeout(()=>{},30000)"],
    {
      env: { PATH: "/usr/bin:/bin" },
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  const closed = new Promise<void>((resolve) =>
    remote.once("close", () => resolve()),
  );
  await new Promise<void>((resolve, reject) => {
    remote.stdout.once("data", () => resolve());
    remote.once("error", reject);
  });
  const fakeHc = join(f.dataDir, "fake-hc");
  await writeFile(
    fakeHc,
    "#!/bin/sh\nprintf 'Connection reset by peer\\n' >&2\nexit 1\n",
    { mode: 0o700 },
  );
  const client = processClient(
    fakeHc,
    { PATH: "/usr/bin:/bin" },
    f.dataDir,
    5000,
  );
  let mapped: unknown;
  let runtimeErrorCode: string | undefined;
  let calls = 0;
  const prepare = vi.fn(async () => {
    if (++calls > 1) return undefined;
    try {
      await client.exec([
        "exec",
        "--on",
        "fixture",
        "--",
        "git",
        "worktree",
        "add",
      ]);
    } catch (error) {
      runtimeErrorCode = (error as { code: string }).code;
      mapped = agentCommandError(
        error as Parameters<typeof agentCommandError>[0],
      );
      throw mapped;
    }
    return undefined;
  });
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
    snapshot: async () => ({ model: "fixture", agent_cli_version: "fixture" }),
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
    f.advance(5000);
    await new Dispatcher(options).tick();
    const remoteAlive = remote.pid !== undefined && process.kill(remote.pid, 0);
    const observed = {
      runtimeErrorCode,
      mappedExitCode: (mapped as { code: unknown }).code,
      inferredExited: preparationExecutionExited(mapped),
      remoteAlive,
      prepareCalls: prepare.mock.calls.length,
      provisionCalls: vi.mocked(runtime.provision).mock.calls.length,
      runStates: f.state().runs.map((r) => r.status),
    };
    console.log(JSON.stringify(observed));
    expect(remoteAlive).toBe(true);
    expect(
      runtime.provision,
      "remote exit remains unconfirmed; do not create a replacement terminal",
    ).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledOnce();
  } finally {
    remote.kill("SIGTERM");
    await closed;
    f.close();
  }
});
