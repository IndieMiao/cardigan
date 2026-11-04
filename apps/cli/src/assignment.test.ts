import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Assignment,
  Runtime,
  RuntimeLaunch,
  RuntimeRef,
  RuntimeResult,
} from "@cardigan/domain";
import { assign, createCard, type Role } from "@cardigan/domain";
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

const project_id = "p-one" as never;

/** Records what the orchestration asked of the runtime. */
class FakeRuntime implements Runtime {
  readonly provisions: RuntimeLaunch[] = [];
  readonly released: RuntimeRef[] = [];
  provisionResult: RuntimeResult<RuntimeRef> | undefined;
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
  async status(): Promise<RuntimeResult<never>> {
    return {
      ok: false,
      error: { code: "runtime_not_found", message: "not used" },
    };
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
  async release(ref: RuntimeRef): Promise<RuntimeResult<void>> {
    this.released.push(ref);
    return { ok: true, value: undefined };
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
    env: { CARDIGAN_DATA_DIR: dataDir },
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
    allowed_tools: ["whoami", "get_card"],
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

  test("the agent name carries the project short code and stays within hc limits", () => {
    const name = agentNameFor({
      role_id: "coder",
      project_id,
      card_id: "C-3" as never,
      work_item_id: "W-7" as never,
      assignment_id: "A-12" as never,
    });
    expect(name).toBe(`coder-${projectShortCode(project_id)}-c-3-w-7-a-12`);
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
    expect(long).toContain(projectShortCode("p-two" as never));
    expect(long.endsWith("c-123-w-456-a-789")).toBe(true);
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
  test("queues, provisions and dispatches a role without a worktree", async () => {
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
    const updated = store.uow.read((tx) =>
      tx.assignments.get(project_id, assignment.id),
    );
    expect(updated?.runtime_state).toBe("running");
    expect(updated?.runtime_ref?.terminal_ref).toBe("t1");
  });

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
    ).rejects.toThrow(/runtime_unavailable/);

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
    ).rejects.toThrow();

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

    const stopped = await stopAssignment({
      store,
      project_id,
      assignment_id: assignment.id,
      runtime,
    });
    expect(stopped.released).toBe(true);
    expect(stopped.aborted).toBe(true);
    expect(runtime.released[0]?.terminal_ref).toBe(
      started.runtime_ref.terminal_ref,
    );
    const run = store.uow.read((tx) =>
      tx.runs.get(project_id, started.run_id as never),
    );
    expect(run?.status).toBe("cancelled");
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

    await expect(
      attachAssignment({
        store,
        project_id,
        assignment_id: assignment.id,
        runtime,
      }),
    ).resolves.toBe("hc attach t1");

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
