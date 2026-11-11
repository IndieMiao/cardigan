// Independent M4.T2 fixture: public commands, CLI, MCP and real Git only.
import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CliIo,
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
  dispatchRun,
  mergePlan,
  queueRun,
  type Result,
  type Runtime,
  type RuntimeRef,
  releaseAssignment,
  STANDING_ROLE_TOOLS,
  setProjectPreferences,
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
import { AgentGitTransport, launchRun, runDirectory } from "@cardigan/host";
import { loadCommandState } from "@cardigan/mcp-server";
import {
  corePromptFor,
  parseLaunchConfig,
  TOKEN_FILE_NAME,
} from "@cardigan/roles";
import { type ExecutionConfig, HerdrRuntime } from "@cardigan/runtime-herdr";
import { Store } from "@cardigan/store";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, vi } from "vitest";
import { createTestRuntime } from "../../../test-support/paths.js";
import { ServerGit } from "../src/git.js";
import { type CardiganServer, startCardiganServer } from "../src/index.js";
import { HcCore, runCleanupSteps } from "./hc.js";

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
/**
 * A ref's object name, or `undefined` while it does not exist.
 *
 * A poll predicate must not throw when the ref is still missing: `git rev-parse
 * --verify` exits non-zero for an absent ref, which `expect.poll` treats as a
 * hard failure instead of retrying (M4.T2 R02/R03 relied on the reconcile loop
 * recreating the ref before the first poll and failed under load).
 */
export const refAt = (cwd: string, ref: string): string | undefined => {
  try {
    return git(cwd, "rev-parse", "--verify", ref);
  } catch {
    return undefined;
  }
};
export function value<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}
export type Producer = { owner: Assignment; verifier: Assignment };
const ok = <T>(v: T) => ({ ok: true as const, value: v });

export async function m4Cross(
  options: {
    hc?: boolean;
    agent?: boolean;
    /** C-49 defaults merge confirmation to PM Ops; these fixtures cover the human path. */
    pmMergeConfirmation?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "cardigan-m4-cross-"));
  const source = join(root, "source"),
    dataDir = join(root, "data"),
    project_id = "cross";
  const project = { project_id, source_repo: source, base_branch: "main" };
  const bin = join(root, "bin");
  const execution: ExecutionConfig = options.agent
    ? {
        mode: "agent-ssh",
        dataDir,
        agentRoot: join(root, "shared"),
        gid: process.getgid?.() ?? 1000,
        machine: "cardigan-agent",
        identityFile: join(root, "key"),
        knownHostsFile: join(root, "known"),
      }
    : { mode: "local", dataDir };
  const agentRoot =
    execution.mode === "agent-ssh"
      ? execution.agentRoot
      : join(dataDir, "agent");
  let core: HcCore | undefined, realRuntime: HerdrRuntime | undefined;
  const bells: { ref: RuntimeRef; text: string }[] = [],
    released: RuntimeRef[] = [],
    errors: unknown[] = [];
  const trace = join(root, "git-trace");
  const agentRun = async (args: readonly string[], timeout = 30000) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        ...args,
      ],
      {
        encoding: "utf8",
        timeout,
        env: { ...process.env, CARDIGAN_TEST_SIDE: "agent" },
      },
    ).trim();
  let server: CardiganServer | undefined,
    store: Store | undefined,
    sequence = 0;
  const clients = new Map<string, { token: string; client: Client }>();
  const tokens = new Map<string, string>();
  const runtime: Runtime & Pick<HerdrRuntime, "events" | "captureAgent"> = {
    async provision(a, role, machine, launch) {
      const dir = runDirectory({
        dataDir,
        project_id,
        assignment_id: a.id,
        execution,
      }).runDir;
      tokens.set(
        a.id,
        (await readFile(join(dir, TOKEN_FILE_NAME), "utf8")).trim(),
      );
      if (realRuntime) return realRuntime.provision(a, role, machine, launch);
      return ok({
        machine_id: "local",
        runtime_machine:
          execution.mode === "agent-ssh" ? execution.machine : "local",
        terminal_ref: `fixture-${a.id}`,
        agent_name: launch.agent_name,
      });
    },
    async wake(ref, text, opts) {
      bells.push({ ref, text });
      return realRuntime
        ? realRuntime.wake(ref, text, opts)
        : ok({ sent: true });
    },
    async status(ref) {
      return realRuntime
        ? realRuntime.status(ref)
        : ok({ process: "alive", agent: "idle", observed_seq: 1 });
    },
    async release(ref, opts) {
      released.push(ref);
      return realRuntime ? realRuntime.release(ref, opts) : ok(undefined);
    },
    async interrupt() {
      return ok(undefined);
    },
    async human_entry() {
      return ok("fixture");
    },
    async resume_or_replace(ref, launch) {
      return realRuntime ? realRuntime.resume_or_replace(ref, launch) : ok(ref);
    },
    async *events(ref, signal) {
      if (realRuntime) {
        yield* realRuntime.events(ref, signal);
        return;
      }
      if (!signal?.aborted)
        await new Promise<void>((resolve) =>
          signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
    },
    async captureAgent(command, args, timeout) {
      try {
        return ok(
          command === "git" ? await agentRun(args, timeout) : "pi fixture-1",
        );
      } catch (e) {
        return {
          ok: false,
          error: { code: "runtime_unavailable", message: String(e) },
        };
      }
    },
  };
  async function closeClients() {
    for (const c of clients.values()) await c.client.close();
    clients.clear();
  }
  async function close() {
    await runCleanupSteps({
      session: core?.session ?? "none",
      socket: core?.socket ?? "",
      steps: [
        { label: "close server", run: () => server?.close() },
        { label: "close MCP clients", run: () => closeClients() },
        { label: "stop herdr-core", run: () => core?.finalStop() },
        { label: "close store", run: () => store?.close() },
        { label: "restore environment", run: () => vi.unstubAllEnvs() },
        { label: "stop herdr-core again", run: () => core?.finalStop() },
        {
          label: "verify herdr-core stopped",
          run: () => core?.assertStopped(),
        },
        {
          label: "remove temporary directory",
          run: () => rm(root, { recursive: true, force: true }),
        },
      ],
    });
  }
  const db = () => {
    if (!store) throw new Error("No store");
    return store;
  };
  let output = "",
    stderr = "";
  const io: CliIo = {
    ...createProcessIo(),
    cwd: root,
    env: {
      CARDIGAN_DATA_DIR: dataDir,
      CARDIGAN_PROJECT: project_id,
      ...(execution.mode === "agent-ssh"
        ? {
            CARDIGAN_RUNTIME_MODE: execution.mode,
            CARDIGAN_AGENT_ROOT: agentRoot,
            CARDIGAN_AGENT_GID: String(execution.gid),
            CARDIGAN_AGENT_MACHINE: execution.machine,
            CARDIGAN_AGENT_IDENTITY: execution.identityFile,
            CARDIGAN_AGENT_KNOWN_HOSTS: execution.knownHostsFile,
          }
        : {}),
    },
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
    repository = join(agentRoot, "repos", project_id),
    trees = join(agentRoot, "worktrees", project_id);
  const prepare = async (request: EnsureWorktreeInput) => {
    if (execution.mode === "local") return worktrees.ensureWorktree(request);
    const transport = new AgentGitTransport(
      execution,
      project_id,
      request.assignment.id,
      agentRun,
    );
    return new GitWorktreeService(transport, central, {
      dataDir,
      repositoriesRoot: join(agentRoot, "repos"),
      worktreesRoot: join(agentRoot, "worktrees"),
    }).ensureWorktree(request);
  };
  const launch = {
    config: parseLaunchConfig({
      providers: {
        fixture: { harness: "pi", env: { PATH: `${bin}:${process.env.PATH}` } },
      },
      profiles: {
        fixture: { harness: "pi", provider: "fixture", model: "fixture-model" },
      },
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
  let port = 0;
  let binding: ServerGit;
  async function open(live = false) {
    binding = new ServerGit({
      store: db(),
      dataDir,
      execution,
      ...(options.agent ? { captureAgent: runtime.captureAgent } : {}),
    });
    server = await startCardiganServer({
      store: db(),
      config: { dataDir, host: "localhost", port, execution },
      git: binding,
      log: () => {},
      warn: () => {},
      ...(live
        ? {
            dispatcher: {
              runtime,
              intervalMs: 10,
              mergeIntervalMs: 20,
              cleanupIntervalMs: 30,
              reconcileIntervalMs: 50,
              backupIntervalMs: 50,
              onError: (error: unknown) => errors.push(error),
              snapshot: async () => ({
                model: "fixture-model",
                agent_cli_version: "fixture-1",
              }),
              startRun: async ({
                assignment,
                run,
                bell,
              }: {
                assignment: Assignment;
                run: import("@cardigan/domain").Run;
                bell: string;
              }) => {
                if (!server) throw new Error("No server");
                await launchRun(
                  {
                    store: db(),
                    runtime,
                    launch,
                    dataDir,
                    execution,
                    mcpUrl: server.url,
                  },
                  {
                    project: project_id,
                    assignment_id: assignment.id,
                    run,
                    actor: { kind: "system", project_id },
                    first_prompt: bell,
                  },
                );
              },
            },
          }
        : {}),
    });
    port = server.port;
  }
  async function restart(live = true) {
    await server?.close();
    await closeClients();
    db().close();
    store = Store.open({ dataDir });
    await open(live);
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
      if (current(a).runtime_ref) {
        const run = command((s, actor, p) =>
          queueRun(
            s,
            actor,
            {
              assignment_id: a.id,
              model: "fixture-model",
              agent_cli_version: "fixture-1",
            },
            p,
          ),
        );
        command((s, actor, p) => dispatchRun(s, actor, { run_id: run.id }, p));
      } else
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
            const placement = await prepare(request as EnsureWorktreeInput);
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
    if (run) {
      const card_id = state().work_items.find(
        (w) => w.id === a.work_item_id,
      )?.card_id;
      if (card_id)
        await call(a, "ack_events", {
          card_id,
          up_to_seq: Math.max(
            0,
            ...state()
              .events.filter((e) => e.card_id === card_id)
              .map((e) => e.seq),
          ),
        });
      await call(a, "finish_run", {
        run_id: run.id,
        outcome: "completed",
        summary: "Delivered or reviewed",
      });
    }
  }
  async function change(a: Assignment, file: string, text: string) {
    await start(a);
    await writeFile(join(path(a), file), text);
    const run = (...args: string[]) =>
      options.agent
        ? agentRun(["-C", path(a), ...args])
        : git(path(a), ...args);
    await run("add", "--", file);
    await run("commit", "-qm", "Fixture delivery");
    return run("rev-parse", "HEAD");
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
    await mkdir(bin);
    await writeFile(
      join(bin, "pi"),
      "#!/usr/bin/env node\nprocess.stdout.write('fixture ready\\n');process.stdin.resume();setInterval(()=>{},1000);\n",
      { mode: 0o700 },
    );
    if (options.hc) {
      const session = `m4t2-${process.pid}-${root.slice(-6)}`,
        runtimeDir = createTestRuntime(join(root, "runtime")),
        socket = join(runtimeDir, "hc.sock"),
        env = {
          ...process.env,
          HC_SESSION: session,
          HC_SOCKET: socket,
          XDG_RUNTIME_DIR: runtimeDir,
        };
      core = new HcCore(session, socket, env);
      execFileSync("hc", ["server", "start", "--json"], {
        env,
        stdio: "pipe",
        timeout: 10000,
      });
      core.remember();
      const created = await HerdrRuntime.create({
        session,
        socketPath: socket,
        env,
        // §P2a-2: no hc call can restart this session after cleanup stopped it.
        client: core.client(),
      });
      if (!created.ok) throw new Error(created.error.message);
      realRuntime = created.value;
    }
    if (execution.mode === "agent-ssh") {
      await mkdir(dataDir, { mode: 0o700 });
      await mkdir(agentRoot, { mode: 0o2750 });
      await chmod(agentRoot, 0o2750);
      for (const file of [execution.identityFile, execution.knownHostsFile])
        await writeFile(file, "fixture-only", { mode: 0o600 });
      const realGit = execFileSync("which", ["git"], {
        encoding: "utf8",
      }).trim();
      await writeFile(trace, "");
      await writeFile(
        join(bin, "git"),
        `#!/usr/bin/env node
const {appendFileSync}=require('node:fs'),{spawnSync}=require('node:child_process'), args=process.argv.slice(2);
appendFileSync(${JSON.stringify(trace)},JSON.stringify({side:process.env.CARDIGAN_TEST_SIDE||'host',cwd:args[args.indexOf('-C')+1],args})+'\\n');
const child=spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});process.exit(child.status??99);
`,
        { mode: 0o700 },
      );
      await writeFile(
        join(bin, "ssh"),
        `#!/usr/bin/env node
const {appendFileSync}=require('node:fs'),{spawnSync}=require('node:child_process'), args=process.argv.slice(2), at=args.indexOf('--');
if(args[at+1]!=='agent@localhost')process.exit(99);
appendFileSync(${JSON.stringify(trace)},JSON.stringify({side:'agent',cwd:${JSON.stringify(agentRoot)},args})+'\\n');
const child=spawnSync('sh',['-c',args.slice(at+2).join(' ')],{cwd:${JSON.stringify(agentRoot)},env:{...process.env,CARDIGAN_TEST_SIDE:'agent'},stdio:'inherit'});process.exit(child.status??99);
`,
        { mode: 0o700 },
      );
      vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    }
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
          kind:
            role_id === "pm"
              ? "standing"
              : role_id === "coder"
                ? "produce"
                : "verify",
          core_prompt: corePromptFor(role_id),
          harness: "pi",
          launch_profile_ref: "fixture",
          // Preserve collaboration tools, but do not give every role both work-item actions.
          allowed_tools: STANDING_ROLE_TOOLS.filter(
            (tool) =>
              role_id === "pm" ||
              (![
                "record_decision",
                "resolve_delegated_decision",
                "triage_human_action",
                "replace_verification_work_item",
              ].includes(tool) &&
                tool !==
                  (role_id === "coder" ? "submit_review" : "submit_delivery")),
          ),
          worktree: role_id === "coder" ? "write" : "none",
        }),
      );
      await cli("role", "add", "--file", file);
    }
    await cli("pm", "create", "--office");
    await cli("pm", "create", "--ops");
    store = Store.open({ dataDir });
    if (options.pmMergeConfirmation !== true)
      command((s, a, p) =>
        setProjectPreferences(s, a, { pm_merge_confirmation: false }, p),
      );
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
      bells,
      released,
      errors,
      restart,
      agentRun,
      agentRoot,
      trace,
      binding: () => binding,
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
