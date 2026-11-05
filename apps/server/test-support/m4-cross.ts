// Independent M4.T2 fixture: public commands, CLI, MCP and real Git only.
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createProcessIo,
  main,
  runCommand,
  startAssignment,
} from "@cardigan/cli";
import {
  type Actor,
  type Assignment,
  assign,
  type CommandEffect,
  type CommandPorts,
  type CommandState,
  createCard,
  createWorkItem,
  type Delivery,
  mergePlan,
  type Result,
  type Runtime,
  releaseAssignment,
  toolNames,
  updateCard,
} from "@cardigan/domain";
import {
  CentralRepositoryService,
  type EnsureWorktreeInput,
  GitWorktreeService,
} from "@cardigan/git-service";
import {
  CentralGitTransport,
  LocalGitTransport,
} from "@cardigan/git-transport";
import { runDirectory } from "@cardigan/host";
import { loadCommandState } from "@cardigan/mcp-server";
import {
  corePromptFor,
  parseLaunchConfig,
  TOKEN_FILE_NAME,
} from "@cardigan/roles";
import { Store } from "@cardigan/store";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect } from "vitest";
import { type CardiganServer, startCardiganServer } from "../src/index.js";

export const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    [
      "-C",
      cwd,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      ...args,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
export function value<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}
export type Producer = { owner: Assignment; verifier: Assignment };
const ok = <T>(v: T) => ({ ok: true as const, value: v });

export async function m4Cross() {
  const root = await mkdtemp(join(tmpdir(), "cardigan-m4-cross-"));
  const source = join(root, "source"),
    dataDir = join(root, "data"),
    project_id = "cross";
  const project = { project_id, source_repo: source, base_branch: "main" };
  let server: CardiganServer | undefined,
    store: Store | undefined,
    sequence = 0;
  const clients = new Map<string, { token: string; client: Client }>();
  const tokens = new Map<string, string>();
  const runtime: Runtime = {
    async provision(a, _role, _machine, launch) {
      const dir = runDirectory({
        dataDir,
        project_id,
        assignment_id: a.id,
      }).runDir;
      tokens.set(
        a.id,
        (await readFile(join(dir, TOKEN_FILE_NAME), "utf8")).trim(),
      );
      const ref = {
        machine_id: "local",
        runtime_machine: "local",
        terminal_ref: `fixture-${a.id}`,
        agent_name: launch.agent_name,
      };
      return ok(ref);
    },
    async wake() {
      return ok({ sent: true });
    },
    async status() {
      return ok({ process: "alive", agent: "idle", observed_seq: 1 });
    },
    async release() {
      return ok(undefined);
    },
    async interrupt() {
      return ok(undefined);
    },
    async human_entry() {
      return ok("fixture");
    },
    async resume_or_replace(ref) {
      return ok(ref);
    },
  };
  async function closeClients() {
    for (const c of clients.values()) await c.client.close();
    clients.clear();
  }
  async function close() {
    await server?.close();
    await closeClients();
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
  const db = () => {
    if (!store) throw new Error("No store");
    return store;
  };
  let output = "",
    stderr = "";
  const io = {
    ...createProcessIo(),
    cwd: root,
    env: { CARDIGAN_DATA_DIR: dataDir, CARDIGAN_PROJECT: project_id },
    stdout: (s: string) => {
      output += s;
    },
    stderr: (s: string) => {
      stderr += s;
    },
    captureCommand: async () => ({
      code: 0,
      stdout: "pi fixture-1",
      stderr: "",
    }),
  };
  async function cli(...args: string[]) {
    output = "";
    stderr = "";
    const code = await main(args, io);
    if (code !== 0) throw new Error(stderr);
    return output;
  }
  const human: Actor = { kind: "human", project_id };
  const command = <T>(
    reduce: (
      s: CommandState,
      a: Actor,
      p: CommandPorts,
    ) => Result<CommandEffect<T>>,
  ) => runCommand(db(), { project_id, actor: human, reduce });
  const state = () => db().uow.read((tx) => loadCommandState(tx, project_id));
  let observe: ((cwd: string, args: readonly string[]) => void) | undefined;
  const hostCalls: { cwd: string; args: readonly string[] }[] = [];
  const transport = new CentralGitTransport({
    dataDir,
    onCommand: (cwd, args) => {
      hostCalls.push({ cwd, args });
      observe?.(cwd, args);
    },
  });
  const central = new CentralRepositoryService(transport, { dataDir });
  const local = new LocalGitTransport();
  const worktrees = new GitWorktreeService(local, central, { dataDir });
  const center = central.repositoryPath(project),
    repository = join(dataDir, "agent", "repos", project_id),
    trees = join(dataDir, "agent", "worktrees", project_id);
  const launch = {
    config: parseLaunchConfig({
      profiles: { fixture: { harness: "pi", model: "fixture-model" } },
    }),
    secrets: {},
  };
  const current = (a: Assignment) => {
    const result = state().assignments.find((v) => v.id === a.id);
    if (!result) throw new Error("Missing Assignment");
    return result;
  };
  const path = (a: Assignment) => {
    const result = current(a).worktree_path;
    if (!result) throw new Error("No worktree");
    return result;
  };
  async function open() {
    server = await startCardiganServer({
      store: db(),
      config: { dataDir, host: "localhost", port: 0 },
      log: () => {},
      warn: () => {},
    });
  }
  async function client(a: Assignment) {
    const token = tokens.get(a.id);
    if (!token || !server) throw new Error("Assignment not started");
    const previous = clients.get(a.id);
    if (previous?.token === token) return previous.client;
    await previous?.client.close();
    const client = new Client({ name: "m4-cross", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    clients.set(a.id, { client, token });
    return client;
  }
  async function raw(
    a: Assignment,
    name: string,
    args: Record<string, unknown> = {},
  ) {
    return (await client(a)).callTool({
      name,
      arguments: { ...args, idempotency_key: `cross-${++sequence}` },
    });
  }
  async function call<T>(
    a: Assignment,
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    const result = await raw(a, name, args);
    if (result.isError) throw new Error(JSON.stringify(result));
    return result.structuredContent as T;
  }
  async function start(a: Assignment) {
    const active = state().runs.some(
      (r) =>
        r.assignment_id === a.id &&
        !["completed", "failed", "cancelled"].includes(r.status),
    );
    if (!active) {
      if (!server) throw new Error("No server");
      await startAssignment({
        store: db(),
        io,
        project_id,
        assignment_id: a.id,
        runtime,
        dataDir,
        launch,
        mcpUrl: server.url,
        worktree: async (request) => {
          const placement = await worktrees.ensureWorktree(
            request as EnsureWorktreeInput,
          );
          return placement
            ? {
                path: placement.worktree_path,
                ...(placement.branch ? { branch: placement.branch } : {}),
                base_sha: placement.base_sha,
              }
            : undefined;
        },
      });
    }
    await expect
      .poll(() =>
        state().runs.some(
          (r) =>
            r.assignment_id === a.id &&
            ["dispatched", "running"].includes(r.status),
        ),
      )
      .toBe(true);
    await call(a, "whoami");
  }
  async function finish(a: Assignment) {
    const run = state().runs.find(
      (r) => r.assignment_id === a.id && r.status === "running",
    );
    if (run)
      await call(a, "finish_run", {
        run_id: run.id,
        outcome: "completed",
        summary: "Delivered or reviewed",
      });
  }
  async function change(a: Assignment, file: string, text: string) {
    await start(a);
    await writeFile(join(path(a), file), text);
    git(path(a), "add", "--", file);
    git(path(a), "commit", "-qm", "Fixture delivery");
    return git(path(a), "rev-parse", "HEAD");
  }
  async function deliver(p: Producer, sha: string) {
    await start(p.owner);
    const result = await call<Delivery>(p.owner, "submit_delivery", {
      work_item_id: p.owner.work_item_id,
      kind: "code",
      summary: "Ready",
      subject: { kind: "git_head", value: sha },
      requested_verifiers: [p.verifier.work_item_id],
    });
    await finish(p.owner);
    return result;
  }
  async function review(a: Assignment, d: Delivery) {
    await start(a);
    await call(a, "submit_review", {
      delivery_id: d.id,
      target_sha: d.subject.value,
      kind: d.kind === "card_completion" ? "product" : "code",
      issues: [],
    });
    await finish(a);
  }
  try {
    git(root, "init", "-q", "-b", "main", source);
    await writeFile(join(source, "shared.txt"), "base\n");
    git(source, "add", ".");
    git(source, "commit", "-qm", "Initial");
    await cli("project", "create", project_id);
    await cli("project", "set-repo", "--path", source);
    for (const role_id of ["coder", "reviewer", "pm"] as const) {
      const file = join(root, `${role_id}.json`);
      await writeFile(
        file,
        JSON.stringify({
          role_id,
          display_name: role_id,
          kind: role_id === "pm" ? "standing" : "work",
          core_prompt: corePromptFor(role_id),
          harness: "pi",
          launch_profile_ref: "fixture",
          allowed_tools: [...toolNames],
          worktree: role_id === "coder" ? "write" : "none",
        }),
      );
      await cli("role", "add", "--file", file);
    }
    await cli("pm", "create", "--office");
    await cli("pm", "create", "--ops");
    store = Store.open({ dataDir });
    const card = command((s, a, p) =>
      createCard(
        s,
        a,
        {
          title: "M4 cross",
          goal: "Ship",
          acceptance_criteria: ["Verified"],
          source: { kind: "quote", text: "Build" },
          repo: "fixture",
          base_branch: "main",
        },
        p,
      ),
    );
    const assignItem = (id: Assignment["work_item_id"], role: string) =>
      command((s, a, p) =>
        assign(s, a, { work_item_id: id as never, role_id: role }, p),
      );
    const owners = state().work_items.map((w) => assignItem(w.id, w.role_id));
    const primary: Producer = {
        owner: owners[0] as Assignment,
        verifier: owners[1] as Assignment,
      },
      pm = owners[2] as Assignment;
    async function extra(): Promise<Producer> {
      const item = command((s, a, p) =>
        createWorkItem(
          s,
          a,
          {
            card_id: card.id,
            title: "Second output",
            kind: "produce",
            role_id: "coder",
            required: true,
            completion_criteria: ["Pass"],
          },
          p,
        ),
      );
      const verify = command((s, a, p) =>
        createWorkItem(
          s,
          a,
          {
            card_id: card.id,
            title: "Second review",
            kind: "verify",
            role_id: "reviewer",
            required: true,
            completion_criteria: ["Pass"],
            target_work_item_id: item.id,
          },
          p,
        ),
      );
      return {
        owner: assignItem(item.id, "coder"),
        verifier: assignItem(verify.id, "reviewer"),
      };
    }
    async function complete(d: Delivery) {
      await start(primary.owner);
      const completion = await call<Delivery>(
        primary.owner,
        "submit_delivery",
        {
          work_item_id: primary.owner.work_item_id,
          kind: "card_completion",
          summary: "Acceptance criteria verified",
          subject: d.subject,
          requested_verifiers: [pm.work_item_id],
        },
      );
      await finish(primary.owner);
      await review(pm, completion);
      return completion;
    }
    await open();
    return {
      root,
      dataDir,
      source,
      project,
      center,
      repository,
      trees,
      card,
      primary,
      pm,
      central,
      local,
      worktrees,
      transport,
      hostCalls,
      runtime,
      cli,
      state,
      current,
      path,
      start,
      finish,
      change,
      deliver,
      review,
      complete,
      extra,
      call,
      raw,
      close,
      command,
      store: db,
      token: (a: Assignment) => tokens.get(a.id),
      url: () => server?.url as string,
      observe: (hook?: typeof observe) => {
        observe = hook;
      },
      plan: () => value(mergePlan(state(), card.id)),
      confirm: () => cli("merge", "confirm", card.id),
      cancel: () =>
        command((s, a, p) =>
          updateCard(s, a, { card_id: card.id, status: "cancelled" }, p),
        ),
      release: (a: Assignment) =>
        command((s, actor, p) =>
          releaseAssignment(s, actor, { assignment_id: a.id }, p),
        ),
    };
  } catch (error) {
    await close();
    throw error;
  }
}
export type M4Cross = Awaited<ReturnType<typeof m4Cross>>;
