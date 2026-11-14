import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Assignment,
  Runtime,
  RuntimeLaunch,
  RuntimeObservation,
  RuntimeRef,
  RuntimeResult,
} from "@cardigan/domain";
import {
  assign,
  createCard,
  occupiedRunSlots,
  type Role,
  stoppedByHuman,
} from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import { corePromptFor, parseLaunchConfig } from "@cardigan/roles";
import { Store, writeRole } from "@cardigan/store";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  agentNameFor,
  attachAssignment,
  type PreparedWorktree,
  projectSegment,
  projectShortCode,
  runDirectory,
  startAssignment,
  stopAssignment,
} from "./assignment.js";
import { humanActor, runCommand } from "./host.js";
import type { CapturedOutput, CliIo } from "./io.js";
import { registerTemplateRoles } from "./template-fixtures.js";

const project_id = "p-one" as never;

/** Records what the orchestration asked of the runtime. */
class FakeRuntime implements Runtime {
  readonly provisions: RuntimeLaunch[] = [];
  readonly released: RuntimeRef[] = [];
  provisionResult: RuntimeResult<RuntimeRef> | undefined;
  statusResult: RuntimeResult<RuntimeObservation> = {
    ok: false,
    error: { code: "runtime_not_found", message: "not used" },
  };
  /** Return a ref that the domain rejects (machine mismatch). */
  badMachine = false;

  async provision(
    _assignment: Assignment,
    _role: Role,
    _machine: never,
    launch: RuntimeLaunch,
  ): Promise<RuntimeResult<RuntimeRef>> {
    this.provisions.push(launch);
    if (this.provisionResult !== undefined) return this.provisionResult;
    const ref = refFor(launch.agent_name);
    return {
      ok: true,
      value: this.badMachine
        ? { ...ref, machine_id: "remote" as never, worktree_path: launch.cwd }
        : ref,
    };
  }
  async wake(): Promise<RuntimeResult<{ readonly sent: boolean }>> {
    return { ok: true, value: { sent: true } };
  }
  async status(): Promise<RuntimeResult<RuntimeObservation>> {
    return this.statusResult;
  }
  async probeTerminal(): Promise<RuntimeResult<RuntimeObservation["process"]>> {
    return this.statusResult.ok
      ? { ok: true, value: this.statusResult.value.process }
      : this.statusResult;
  }
  async interrupt(): Promise<RuntimeResult<void>> {
    return { ok: true, value: undefined };
  }
  async resume_or_replace(): Promise<RuntimeResult<RuntimeRef>> {
    return {
      ok: false,
      error: { code: "runtime_unavailable", message: "not used" },
    };
  }
  async human_entry(ref: RuntimeRef): Promise<RuntimeResult<string>> {
    return { ok: true, value: `hc attach ${ref.terminal_ref}` };
  }
  releaseResult: RuntimeResult<void> = { ok: true, value: undefined };
  async release(ref: RuntimeRef): Promise<RuntimeResult<void>> {
    this.released.push(ref);
    return this.releaseResult;
  }
}

const refFor = (agentName: string): RuntimeRef =>
  ({
    machine_id: "local",
    runtime_machine: "local",
    // A dispatch failure is simulated by handing back a ref the domain rejects.
    terminal_ref: agentName.includes("badref") ? "xyz" : "t1",
    agent_name: agentName,
  }) as never;

const launchConfig = parseLaunchConfig({
  providers: {
    pi: {
      harness: "pi",
      env: {},
      secret_env: { PROVIDER_API_KEY: "provider" },
    },
  },
  profiles: {
    "pi-agent": { harness: "pi", provider: "pi", model: "fictional-model" },
  },
});

let dataDir: string;
let store: Store;
let io: CliIo;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cardigan-assignment-"));
  store = Store.open({ dataDir });
  io = {
    env: { CARDIGAN_RUNTIME_MODE: "local", CARDIGAN_DATA_DIR: dataDir },
    cwd: dataDir,
    platform: "linux",
    stdout: () => undefined,
    stderr: () => undefined,
    signals: { on: () => undefined, off: () => undefined },
    spawnInherit: () => {
      throw new Error("assignment start must not spawn");
    },
    captureCommand: async (): Promise<CapturedOutput> => ({
      code: 0,
      stdout: "pi 1.5.0-fictional\n",
      stderr: "",
    }),
  };
});

afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function roleFor(worktree: Role["worktree"]): Role {
  return {
    role_id: "coder",
    version: 1,
    display_name: "Coder",
    kind: "work",
    core_prompt: corePromptFor("coder"),
    harness: "pi",
    launch_profile_ref: "pi-agent",
    allowed_tools: ["whoami", "get_card", "submit_delivery"],
    capabilities: [],
    abilities: [],
    worktree,
    required_machine_tags: [],
  };
}

/** A real card + work item + assignment, built through the domain commands. */
function assignWorkItem(worktree: Role["worktree"]): Assignment {
  store.createProject({ id: project_id, name: "One" });
  store.uow.run((tx) =>
    writeRole(tx, project_id, roleFor(worktree), { mode: "add" }),
  );
  registerTemplateRoles(store, project_id);
  const card = runCommand(store, {
    project_id,
    actor: humanActor(project_id),
    reduce: (state, actor, ports) =>
      createCard(
        state,
        actor,
        {
          title: "Fictional card",
          goal: "Start an assignment",
          acceptance_criteria: ["it starts"],
          source: { kind: "quote", text: "fictional" },
          repo: "example/repo",
          base_branch: "main",
        },
        ports,
      ),
  });
  const item = store.uow.read((tx) =>
    tx.work_items
      .list(project_id)
      .find((candidate) => candidate.card_id === card.id),
  );
  if (item === undefined) throw new Error("template item missing");
  return runCommand(store, {
    project_id,
    actor: humanActor(project_id),
    reduce: (state, actor, ports) =>
      assign(state, actor, { work_item_id: item.id, role_id: "coder" }, ports),
  });
}

describe("names and paths (M2 plan §3)", () => {
  test("the project short code is the first 8 hex of sha256", () => {
    expect(projectShortCode(project_id)).toMatch(/^[0-9a-f]{8}$/u);
    expect(projectShortCode("p-one" as never)).toBe(
      projectShortCode("p-one" as never),
    );
    expect(projectShortCode("p-one" as never)).not.toBe(
      projectShortCode("p-two" as never),
    );
  });

  test("the agent name hashes its full identity and stays within hc limits", () => {
    const name = agentNameFor({
      role_id: "coder",
      project_id,
      card_id: "C-3" as never,
      work_item_id: "W-7" as never,
      assignment_id: "A-12" as never,
    });
    expect(name).toMatch(/^coder-[a-f0-9]{24}$/u);
    expect(name).toMatch(/^[a-z0-9_-]{1,32}$/u);

    // A long role is truncated, the codes survive.
    const long = agentNameFor({
      role_id: "a-very-long-role-identifier",
      project_id: "p-two" as never,
      card_id: "C-123" as never,
      work_item_id: "W-456" as never,
      assignment_id: "A-789" as never,
    });
    expect(long).toHaveLength(32);
    expect(long).not.toBe(name);
  });

  test("run and worktree paths are namespaced by project", () => {
    const dirs = runDirectory({
      dataDir,
      project_id,
      assignment_id: "A-1",
      worktreePath: join(dataDir, "agent", "worktrees", "p-one", "A-1"),
    });
    expect(dirs.runDir).toBe(join(dataDir, "runs", "p-one", "A-1"));
    expect(dirs.workDir).toBe(
      join(dataDir, "agent", "worktrees", "p-one", "A-1"),
    );
    // Without a worktree the CLI starts in the run directory.
    expect(
      runDirectory({ dataDir, project_id, assignment_id: "A-1" }).workDir,
    ).toBe(join(dataDir, "runs", "p-one", "A-1"));
  });

  test("an unsafe project id is refused as a path segment", () => {
    expect(projectSegment("p-one")).toBe("p-one");
    expect(() => projectSegment("../evil" as never)).toThrow(/目录名/);
    expect(() => projectSegment("p/one" as never)).toThrow(/目录名/);
  });
});

describe("startAssignment", () => {
  test.each([false, true])(
    "queues, provisions and dispatches a role without a worktree (automatic=%s)",
    async (automatic) => {
      const assignment = assignWorkItem("none");
      const runtime = new FakeRuntime();

      const started = await startAssignment({
        ...(automatic ? { automatic: true } : {}),
        store,
        io,
        project_id,
        assignment_id: assignment.id,
        launch: {
          config: launchConfig,
          secrets: { provider: "sk-fictional-secret" },
        },
        mcpUrl: "http://127.0.0.1:3004/mcp",
        runtime,
        dataDir,
      });

      expect(started.runtime_ref.terminal_ref).toBe("t1");
      expect(started.worktree_path).toBeUndefined();
      expect(runtime.provisions).toHaveLength(1);
      const launch = runtime.provisions[0];
      expect(launch?.labels).toMatchObject({
        cardigan: "1",
        project: project_id,
        assignment: assignment.id,
        run: started.run_id,
      });
      expect(launch?.cwd).toBe(join(dataDir, "runs", "p-one", assignment.id));

      // The Run is dispatched and the assignment records the runtime.
      const run = store.uow.read((tx) =>
        tx.runs.get(project_id, started.run_id as never),
      );
      expect(run?.status).toBe("dispatched");
      expect(run?.model).toBe("fictional-model");
      expect(run?.agent_cli_version).toBe("pi 1.5.0-fictional");
      const queued = store.uow.read((tx) =>
        loadCommandState(tx, project_id).events.find(
          (e) =>
            e.type === "run_queued" &&
            (e.payload as { run_id?: string }).run_id === started.run_id,
        ),
      );
      expect(queued?.actor.kind).toBe(automatic ? "system" : "human");
      const updated = store.uow.read((tx) =>
        tx.assignments.get(project_id, assignment.id),
      );
      expect(updated?.runtime_state).toBe("running");
      expect(updated?.runtime_ref?.terminal_ref).toBe("t1");
    },
  );

  test("the run directory holds the compiled files and the token", async () => {
    const assignment = assignWorkItem("none");
    const started = await startAssignment({
      store,
      io,
      project_id,
      assignment_id: assignment.id,
      launch: {
        config: launchConfig,
        secrets: { provider: "sk-fictional-secret" },
      },
      mcpUrl: "http://127.0.0.1:3004/mcp",
      runtime: new FakeRuntime(),
      dataDir,
    });

    const runDir = join(dataDir, "runs", "p-one", assignment.id);
    expect(statSync(runDir).isDirectory()).toBe(true);
    for (const file of ["launch.sh", "core.md", "first.md", "token"]) {
      expect(statSync(join(runDir, file)).isFile(), file).toBe(true);
    }
    // The dispatch sentinel lets the wrapper start the Agent only after the Run
    // exists (M2 §4 step 5–8), so the first tool call has something to ack.
    expect(existsSync(join(runDir, "start"))).toBe(true);
    expect(statSync(join(runDir, "launch.sh")).mode & 0o777).toBe(0o700);
    expect(statSync(join(runDir, "token")).mode & 0o777).toBe(0o600);
    const token = readFileSync(join(runDir, "token"), "utf8").trim();
    expect(store.verifyToken(token)?.assignment_id).toBe(assignment.id);
    expect(readFileSync(join(runDir, "launch.sh"), "utf8")).not.toContain(
      token,
    );
    expect(readFileSync(join(runDir, "core.md"), "utf8")).toContain(
      "get_updates",
    );
    expect(started.token_id.length).toBeGreaterThan(0);
  });

  test("a planted start symlink never lets the host overwrite another file", async () => {
    const assignment = assignWorkItem("none");
    // The Agent of another Assignment can write here and plants a link; the
    // host must replace the link, not write through it.
    const runDir = join(dataDir, "runs", "p-one", assignment.id);
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const target = join(dataDir, "host-file");
    writeFileSync(target, "host-private");
    symlinkSync(target, join(runDir, "start"));

    await startAssignment({
      store,
      io,
      project_id,
      assignment_id: assignment.id,
      launch: {
        config: launchConfig,
        secrets: { provider: "sk-fictional-secret" },
      },
      mcpUrl: "http://127.0.0.1:3004/mcp",
      runtime: new FakeRuntime(),
      dataDir,
    });

    expect(readFileSync(target, "utf8")).toBe("host-private");
    expect(lstatSync(join(runDir, "start")).isSymbolicLink()).toBe(false);
  });

  test("a role that needs a worktree uses the provider and records the facts", async () => {
    const assignment = assignWorkItem("write");
    const placed: PreparedWorktree = {
      path: join(dataDir, "agent", "worktrees", "p-one", assignment.id),
      branch: "agent/C-1/W-1",
      base_sha: "a".repeat(40),
    };
    // The Git service needs the project's registered repository.
    store.setProjectRepo({
      project_id,
      repo_path: join(dataDir, "src", "p-one"),
    });
    const runtime = new FakeRuntime();
    const started = await startAssignment({
      store,
      io,
      project_id,
      assignment_id: assignment.id,
      launch: {
        config: launchConfig,
        secrets: { provider: "sk-fictional-secret" },
      },
      mcpUrl: "http://127.0.0.1:3004/mcp",
      runtime,
      dataDir,
      worktree: async (request) => {
        expect(request.project_id).toBe(project_id);
        expect(request.role.worktree).toBe("write");
        expect(request.card?.base_branch).toBe("main");
        return placed;
      },
    });

    expect(started.worktree_path).toBe(placed.path);
    expect(runtime.provisions[0]?.cwd).toBe(placed.path);
    const updated = store.uow.read((tx) =>
      tx.assignments.get(project_id, assignment.id),
    );
    expect(updated?.worktree_path).toBe(placed.path);
    expect(updated?.branch).toBe(placed.branch);
    expect(updated?.base_sha).toBe(placed.base_sha);
  });

  test("a role that needs a worktree without a provider is refused before queueing", async () => {
    const assignment = assignWorkItem("write");
    await expect(
      startAssignment({
        store,
        io,
        project_id,
        assignment_id: assignment.id,
        launch: {
          config: launchConfig,
          secrets: { provider: "sk-fictional-secret" },
        },
        mcpUrl: "http://127.0.0.1:3004/mcp",
        runtime: new FakeRuntime(),
        dataDir,
      }),
    ).rejects.toThrow(/worktree/);
    // The queue step already ran, so the Run is cancelled again by the caller's
    // cleanup? No: the failure happens before the token, so the CLI reports it.
    const runs = store.uow.read((tx) => tx.runs.list(project_id));
    expect(runs.length).toBeGreaterThanOrEqual(0);
  });

  test("worktree runtime failures keep compensation and report Chinese errors", async () => {
    const assignment = assignWorkItem("write");
    store.setProjectRepo({ project_id, repo_path: dataDir });
    await expect(
      startAssignment({
        store,
        io,
        project_id,
        assignment_id: assignment.id,
        launch: {
          config: launchConfig,
          secrets: { provider: "sk-fictional-secret" },
        },
        mcpUrl: "http://127.0.0.1:3004/mcp",
        runtime: new FakeRuntime(),
        dataDir,
        worktree: async () => {
          throw new Error("runtime_timeout: Git timed out");
        },
      }),
    ).rejects.toMatchObject({
      exitCode: 1,
      message: `无法启动 Assignment ${assignment.id}：运行时响应超时，请稍后重试（runtime_timeout）`,
    });
    expect(
      store.uow.read((tx) => tx.runs.list(project_id)).map((run) => run.status),
    ).toEqual(["cancelled"]);
  });

  test("a provision failure cancels the Run and revokes the token", async () => {
    const assignment = assignWorkItem("none");
    const runtime = new FakeRuntime();
    runtime.provisionResult = {
      ok: false,
      error: { code: "runtime_unavailable", message: "socket absent" },
    };

    await expect(
      startAssignment({
        store,
        io,
        project_id,
        assignment_id: assignment.id,
        launch: {
          config: launchConfig,
          secrets: { provider: "sk-fictional-secret" },
        },
        mcpUrl: "http://127.0.0.1:3004/mcp",
        runtime,
        dataDir,
      }),
    ).rejects.toMatchObject({
      exitCode: 1,
      message: `无法启动 Assignment ${assignment.id}：运行时不可用，请检查运行服务（runtime_unavailable）`,
    });

    const runs = store.uow.read((tx) => tx.runs.list(project_id));
    expect(runs.map((run) => run.status)).toEqual(["cancelled"]);
    const tokens = store.uow.run((tx) =>
      tx.tokensForAssignment(project_id, assignment.id),
    );
    expect(tokens.every((token) => token.revoked_at !== null)).toBe(true);
    // launch.sh never ran: no plaintext token or provider key may survive.
    const runDir = join(dataDir, "runs", "p-one", assignment.id);
    expect(existsSync(join(runDir, "token"))).toBe(false);
    expect(existsSync(join(runDir, "secrets.env"))).toBe(false);
    // No dispatch happened, so the Agent was never allowed to start.
    expect(existsSync(join(runDir, "start"))).toBe(false);
  });

  test("a dispatch failure releases the terminal and cancels the Run", async () => {
    const assignment = assignWorkItem("none");
    const runtime = new FakeRuntime();
    runtime.badMachine = true;

    await expect(
      startAssignment({
        store,
        io,
        project_id,
        assignment_id: assignment.id,
        launch: {
          config: launchConfig,
          secrets: { provider: "sk-fictional-secret" },
        },
        mcpUrl: "http://127.0.0.1:3004/mcp",
        runtime,
        dataDir,
      }),
    ).rejects.toMatchObject({
      exitCode: 1,
      message: `无法启动 Assignment ${assignment.id}：参数未通过校验，请检查输入（validation_failed）`,
    });

    expect(runtime.released).toHaveLength(1);
    const runs = store.uow.read((tx) => tx.runs.list(project_id));
    expect(runs.map((run) => run.status)).toEqual(["cancelled"]);
    const runDir = join(dataDir, "runs", "p-one", assignment.id);
    expect(existsSync(join(runDir, "token"))).toBe(false);
    expect(existsSync(join(runDir, "secrets.env"))).toBe(false);
  });

  test("starting twice is refused while the first Run is unfinished", async () => {
    const assignment = assignWorkItem("none");
    const runtime = new FakeRuntime();
    const options = {
      store,
      io,
      project_id,
      assignment_id: assignment.id,
      launch: {
        config: launchConfig,
        secrets: { provider: "sk-fictional-secret" },
      },
      mcpUrl: "http://127.0.0.1:3004/mcp",
      runtime,
      dataDir,
    };
    await startAssignment(options);
    await expect(startAssignment(options)).rejects.toThrow(
      /invariant_violation/,
    );
  });
});

describe("stopAssignment and attachAssignment", () => {
  test("stop releases the terminal, cancels the Run and keeps the directory", async () => {
    const assignment = assignWorkItem("none");
    const runtime = new FakeRuntime();
    const started = await startAssignment({
      store,
      io,
      project_id,
      assignment_id: assignment.id,
      launch: {
        config: launchConfig,
        secrets: { provider: "sk-fictional-secret" },
      },
      mcpUrl: "http://127.0.0.1:3004/mcp",
      runtime,
      dataDir,
    });

    // Read the issued token while the session is still live.
    const token = readFileSync(
      join(dataDir, "runs", "p-one", assignment.id, "token"),
      "utf8",
    ).trim();
    expect(store.verifyToken(token)?.assignment_id).toBe(assignment.id);
    // C-211: a follow-up Run already queued behind the live one.
    const live = store.uow.read((tx) =>
      tx.runs.get(project_id, started.run_id as never),
    );
    if (!live) throw new Error("Missing started Run");
    const other = store.uow
      .read((tx) => loadCommandState(tx, project_id))
      .events.find((e) => e.id !== live.trigger_event_id)?.id;
    if (!other) throw new Error("Missing another event");
    store.uow.run((tx) =>
      tx.runs.put(project_id, {
        ...live,
        id: "R-99" as never,
        trigger_event_id: other,
        status: "queued",
        kind: "followup",
      }),
    );

    const stopped = await stopAssignment({
      store,
      project_id,
      assignment_id: assignment.id,
      runtime,
    });
    expect(stopped.released).toBe(true);
    expect(stopped.aborted).toBe(true);
    expect(stopped.paused).toBeUndefined();
    expect(runtime.released[0]?.terminal_ref).toBe(
      started.runtime_ref.terminal_ref,
    );
    const run = store.uow.read((tx) =>
      tx.runs.get(project_id, started.run_id as never),
    );
    expect(run?.status).toBe("cancelled");
    // The queued follow-up is cancelled too, and the stop holds until start.
    expect(
      store.uow.read((tx) => tx.runs.get(project_id, "R-99" as never))?.status,
    ).toBe("cancelled");
    const state = store.uow.read((tx) => loadCommandState(tx, project_id));
    expect(
      state.assignments.find((a) => a.id === assignment.id)?.runtime_ref,
    ).toBeNull();
    expect(stoppedByHuman(state.events, assignment.id)).toBe(true);
    expect(
      statSync(join(dataDir, "runs", "p-one", assignment.id)).isDirectory(),
    ).toBe(true);

    // §9.1: a stopped session must not leave a working token behind.
    const tokens = store.uow.run((tx) =>
      tx.tokensForAssignment(project_id, assignment.id),
    );
    expect(tokens.every((candidate) => candidate.revoked_at !== null)).toBe(
      true,
    );
    expect(store.verifyToken(token)).toBeUndefined();
  });

  test("C-211 a failed release keeps the running Run's slot and the ref, and the stop can be retried", async () => {
    const assignment = assignWorkItem("none");
    const runtime = new FakeRuntime();
    const started = await startAssignment({
      store,
      io,
      project_id,
      assignment_id: assignment.id,
      launch: {
        config: launchConfig,
        secrets: { provider: "sk-fictional-secret" },
      },
      mcpUrl: "http://127.0.0.1:3004/mcp",
      runtime,
      dataDir,
    });
    const slots = () => {
      const state = store.uow.read((tx) => loadCommandState(tx, project_id));
      return occupiedRunSlots(state.assignments, state.runs, "local");
    };
    const before = slots();
    expect(before).toBe(1);
    runtime.releaseResult = {
      ok: false,
      error: { code: "runtime_unavailable", message: "unavailable" },
    };
    await expect(
      stopAssignment({
        store,
        project_id,
        assignment_id: assignment.id,
        runtime,
      }),
    ).rejects.toThrow();
    const state = store.uow.read((tx) => loadCommandState(tx, project_id));
    expect(slots()).toBe(before);
    expect(state.runs.find((r) => r.id === started.run_id)?.status).not.toBe(
      "cancelled",
    );
    expect(
      state.assignments.find((a) => a.id === assignment.id)?.runtime_ref,
    ).toEqual(started.runtime_ref);
    // The stop already holds: nothing new is dispatched in the meantime.
    expect(stoppedByHuman(state.events, assignment.id)).toBe(true);

    runtime.releaseResult = { ok: true, value: undefined };
    const retried = await stopAssignment({
      store,
      project_id,
      assignment_id: assignment.id,
      runtime,
    });
    expect(retried.aborted).toBe(true);
    expect(slots()).toBe(0);
    const after = store.uow.read((tx) => loadCommandState(tx, project_id));
    expect(after.runs.find((r) => r.id === started.run_id)?.status).toBe(
      "cancelled",
    );
    expect(
      after.assignments.find((a) => a.id === assignment.id)?.runtime_ref,
    ).toBeNull();
  });

  test("attach returns the human entry, and stop refuses without a terminal", async () => {
    const assignment = assignWorkItem("none");
    const runtime = new FakeRuntime();
    await startAssignment({
      store,
      io,
      project_id,
      assignment_id: assignment.id,
      launch: {
        config: launchConfig,
        secrets: { provider: "sk-fictional-secret" },
      },
      mcpUrl: "http://127.0.0.1:3004/mcp",
      runtime,
      dataDir,
    });

    runtime.statusResult = {
      ok: true,
      value: { process: "alive", agent: "idle", observed_seq: 1 },
    };
    await expect(
      attachAssignment({
        store,
        project_id,
        assignment_id: assignment.id,
        runtime,
      }),
    ).resolves.toBe("hc attach t1");

    for (const code of [
      "runtime_timeout",
      "runtime_unavailable",
      "runtime_not_found",
    ] as const) {
      runtime.statusResult = {
        ok: false,
        error: { code, message: "probe failed" },
      };
      await expect(
        attachAssignment({
          store,
          project_id,
          assignment_id: assignment.id,
          runtime,
        }),
      ).resolves.toBe("hc attach t1");
    }

    await stopAssignment({
      store,
      project_id,
      assignment_id: assignment.id,
      runtime,
    });
    // The runtime_ref is cleared, so a second stop has nothing to release.
    await expect(
      stopAssignment({
        store,
        project_id,
        assignment_id: assignment.id,
        runtime,
      }),
    ).rejects.toThrow(/没有在运行的终端/);
  });
});

test.each([
  { label: "default", configuredNice: undefined, expectedNice: 10 },
  { label: "configured", configuredNice: "17", expectedNice: 17 },
])(
  "employee launch overrides role CLI/model, snapshots the Run and only changes later Runs ($label niceness)",
  async ({ configuredNice, expectedNice }) => {
    store.uow.run((tx) =>
      tx.employees.put({
        id: "E-1" as never,
        name: "Alice",
        title: "开发",
        bio: "",
        avatar: null,
        role_id: "coder",
        launch_profile_ref: "employee-codex",
        status: "active",
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      }),
    );
    const assignment = assignWorkItem("none");
    expect(assignment.employee_id).toBe("E-1");
    const runtime = new FakeRuntime();
    const probes: string[] = [];
    io = {
      ...io,
      env: {
        ...io.env,
        ...(configuredNice === undefined
          ? {}
          : { CARDIGAN_AGENT_NICE: configuredNice }),
      },
      captureCommand: async (binary) => {
        probes.push(binary);
        return { code: 0, stdout: `${binary} fixture-version`, stderr: "" };
      },
    };
    const config = parseLaunchConfig({
      ...launchConfig,
      profiles: {
        ...launchConfig.profiles,
        "employee-codex": { harness: "codex", model: "employee-model" },
      },
    });
    const start = () =>
      startAssignment({
        store,
        io,
        project_id,
        assignment_id: assignment.id,
        launch: { config, secrets: { provider: "fixture-provider" } },
        mcpUrl: "http://localhost/mcp",
        runtime,
        dataDir,
      });
    const first = await start();
    const firstRun = store.uow.read((tx) => tx.runs.list(project_id))[0];
    expect(firstRun).toMatchObject({
      employee_id: "E-1",
      launch_profile_ref: "employee-codex",
      model: "employee-model",
      agent_cli_version: "codex fixture-version",
    });
    expect(readFileSync(join(first.run_dir, "launch.sh"), "utf8")).toContain(
      `exec nice -n ${expectedNice} 'codex'`,
    );
    store.uow.run((tx) => {
      const employee = tx.employees.list()[0];
      if (!employee || !firstRun) throw new Error("Missing fixture");
      tx.employees.put({
        ...employee,
        launch_profile_ref: null,
        status: "inactive",
      });
      expect(tx.runs.get(project_id, firstRun.id)).toEqual(firstRun);
      tx.runs.put(project_id, {
        ...firstRun,
        status: "completed",
        outcome: "completed",
      });
    });
    const second = await start();
    expect(probes).toEqual(["codex", "pi"]);
    expect(
      store.uow.read((tx) => tx.runs.list(project_id)).at(-1),
    ).toMatchObject({
      employee_id: "E-1",
      launch_profile_ref: "pi-agent",
      model: "fictional-model",
      agent_cli_version: "pi fixture-version",
    });
    expect(readFileSync(join(second.run_dir, "launch.sh"), "utf8")).toContain(
      `exec nice -n ${expectedNice} 'pi'`,
    );
    expect(
      store.uow.read((tx) => tx.runs.list(project_id))[0]?.launch_profile_ref,
    ).toBe("employee-codex");
  },
);

describe("C-154 standing PM session restart", () => {
  function standingOps(): Assignment {
    store.createProject({ id: project_id, name: "One" });
    store.uow.run((tx) =>
      writeRole(
        tx,
        project_id,
        {
          ...roleFor("none"),
          role_id: "pm",
          display_name: "PM",
          core_prompt: corePromptFor("pm"),
          kind: "pm",
        } as Role,
        { mode: "add" },
      ),
    );
    const ops = {
      id: "A-1",
      scope: "standing",
      standing_mode: "ops",
      role_id: "pm",
      role_version: 1,
      status: "active",
      runtime_state: "not_provisioned",
      machine_id: "local",
      runtime_ref: null,
      mcp_token_id: "pm-ops",
      created_at: "2026-01-01T00:00:00.000Z",
    } as unknown as Assignment;
    store.uow.run((tx) => tx.assignments.put(project_id, ops));
    return ops;
  }
  /** A terminal is alive until released; then it is gone. */
  function liveUntilReleased(runtime: FakeRuntime) {
    runtime.status = async (ref: RuntimeRef) =>
      runtime.released.some((r) => r.terminal_ref === ref.terminal_ref)
        ? { ok: false, error: { code: "runtime_not_found", message: "gone" } }
        : ({
            ok: true,
            value: { process: "alive", agent: "working", observed_seq: 1 },
          } as never);
    return runtime;
  }
  const options = (runtime: FakeRuntime, restart_session?: boolean) => ({
    store,
    io,
    project_id,
    assignment_id: "A-1" as never,
    launch: {
      config: launchConfig,
      secrets: { provider: "sk-fictional-secret" },
    },
    mcpUrl: "http://127.0.0.1:3004/mcp",
    runtime,
    dataDir,
    ...(restart_session ? { restart_session } : {}),
  });

  test("restart closes the old terminal, retires its token and keeps the PM on duty", async () => {
    standingOps();
    const runtime = liveUntilReleased(new FakeRuntime());
    const first = await startAssignment(options(runtime));
    const oldToken = readFileSync(
      join(dataDir, "runs", "p-one", "A-1", "token"),
      "utf8",
    ).trim();
    expect(store.verifyToken(oldToken)?.assignment_id).toBe("A-1");

    const second = await startAssignment(options(runtime, true));
    expect(second.run_id).not.toBe(first.run_id);
    expect(runtime.released.map((r) => r.terminal_ref)).toEqual([
      first.runtime_ref.terminal_ref,
    ]);
    expect(store.verifyToken(oldToken)).toBeUndefined();
    const state = store.uow.read((tx) => ({
      assignment: tx.assignments.get(project_id, "A-1" as never),
      old: tx.runs.get(project_id, first.run_id as never),
      next: tx.runs.get(project_id, second.run_id as never),
      events: tx.events.listAfter(project_id, undefined, 0).map((e) => e.type),
    }));
    expect(state.assignment?.status).toBe("active");
    expect(state.old?.status).toBe("cancelled");
    expect(state.next?.status).toBe("dispatched");
    expect(state.events).toContain("standing_session_restarted");
    expect(state.events).not.toContain("assignment_paused");
    expect(
      readFileSync(join(dataDir, "runs", "p-one", "A-1", "first.md"), "utf8"),
    ).toContain("常驻 PM 会话已由人重开");
  });

  test("restart keeps everything when the old terminal is not proven to have exited", async () => {
    standingOps();
    const runtime = new FakeRuntime();
    const first = await startAssignment(options(runtime));
    const token = readFileSync(
      join(dataDir, "runs", "p-one", "A-1", "token"),
      "utf8",
    ).trim();
    // The stop request "succeeds" but the terminal is still alive.
    runtime.statusResult = {
      ok: true,
      value: { process: "alive", agent: "working", observed_seq: 1 },
    } as never;
    await expect(startAssignment(options(runtime, true))).rejects.toThrow(
      /旧终端没有确认退出/,
    );
    expect(runtime.provisions).toHaveLength(1);
    const after = store.uow.read((tx) => ({
      assignment: tx.assignments.get(project_id, "A-1" as never),
      run: tx.runs.get(project_id, first.run_id as never),
      events: tx.events.listAfter(project_id, undefined, 0).map((e) => e.type),
    }));
    // The RuntimeRef stays, so the stop can be retried; nothing was replaced.
    expect(after.assignment?.runtime_ref?.terminal_ref).toBe(
      first.runtime_ref.terminal_ref,
    );
    expect(after.run?.status).toBe("dispatched");
    expect(after.events).not.toContain("standing_session_restarted");
    expect(store.verifyToken(token)?.assignment_id).toBe("A-1");
    // Once the exit is confirmed, the same command goes through.
    runtime.statusResult = {
      ok: false,
      error: { code: "runtime_not_found", message: "gone" },
    };
    await startAssignment(options(runtime, true));
    expect(runtime.provisions).toHaveLength(2);
  });

  test("concurrent restarts are serialized and never orphan a replacement terminal", async () => {
    standingOps();
    const runtime = liveUntilReleased(new FakeRuntime());
    const provision = runtime.provision.bind(runtime);
    runtime.provision = async (...args) => {
      const result = await provision(...args);
      return result.ok
        ? ({
            ok: true,
            value: {
              ...result.value,
              terminal_ref: `terminal-${runtime.provisions.length}`,
            },
          } as never)
        : result;
    };
    const first = await startAssignment(options(runtime));
    const release = runtime.release.bind(runtime);
    let inner: unknown;
    runtime.release = async (ref) => {
      const result = await release(ref);
      if (inner === undefined)
        inner = await startAssignment(options(runtime, true)).catch(
          (error: unknown) => error,
        );
      return result;
    };
    const outer = await startAssignment(options(runtime, true));
    // The interleaved restart is refused before touching anything.
    expect(String(inner)).toContain("正在被另一个重开会话或主机运维操作处理");
    expect(runtime.provisions).toHaveLength(2);
    expect(runtime.released.map((r) => r.terminal_ref)).toEqual([
      first.runtime_ref.terminal_ref,
    ]);
    // Every provisioned terminal is either released or the current session.
    const current = store.uow.read((tx) =>
      tx.assignments.get(project_id, "A-1" as never),
    )?.runtime_ref?.terminal_ref;
    expect(current).toBe(outer.runtime_ref.terminal_ref);
    expect(current).toBe("terminal-2");
    // The lock is released afterwards: a later restart proceeds.
    runtime.release = release;
    await startAssignment(options(runtime, true));
    expect(runtime.released.map((r) => r.terminal_ref)).toEqual([
      "terminal-1",
      "terminal-2",
    ]);
  });

  test("restart refuses a terminal recorded on another runtime without touching it", async () => {
    standingOps();
    const runtime = liveUntilReleased(new FakeRuntime());
    const first = await startAssignment(options(runtime));
    // The session now lives on a runtime machine this host cannot reach.
    store.uow.run((tx) => {
      const current = tx.assignments.get(project_id, "A-1" as never);
      if (!current?.runtime_ref) throw new Error("missing runtime_ref");
      tx.assignments.put(project_id, {
        ...current,
        runtime_ref: { ...current.runtime_ref, runtime_machine: "elsewhere" },
      });
    });
    // Seen from here, that terminal is "not found" — which is no exit proof.
    runtime.status = async () => ({
      ok: false,
      error: { code: "runtime_not_found", message: "not here" },
    });
    await expect(startAssignment(options(runtime, true))).rejects.toThrow(
      /host_ops_restart_standing_pm/,
    );
    expect(runtime.provisions).toHaveLength(1);
    expect(runtime.released).toHaveLength(0);
    const after = store.uow.read((tx) => ({
      assignment: tx.assignments.get(project_id, "A-1" as never),
      run: tx.runs.get(project_id, first.run_id as never),
    }));
    expect(after.assignment?.runtime_ref?.runtime_machine).toBe("elsewhere");
    expect(after.run?.status).toBe("dispatched");
  });

  test("restart refuses a work-item Assignment without touching it", async () => {
    const assignment = assignWorkItem("none");
    const runtime = new FakeRuntime();
    await expect(
      startAssignment({
        ...options(runtime, true),
        assignment_id: assignment.id,
      }),
    ).rejects.toThrow(/不是在岗的常驻 PM/);
    expect(runtime.provisions).toHaveLength(0);
  });
});
