/** M2.T2: exercise the public launch flow; no implementation/test helpers. */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  type Assignment,
  assign,
  createCard,
  type Role,
  type Runtime,
  type RuntimeRef,
} from "@cardigan/domain";
import {
  compileAssignmentLaunch,
  corePromptFor,
  firstPrompt,
  parseLaunchConfig,
  START_FILE_NAME,
} from "@cardigan/roles";
import { HerdrRuntime } from "@cardigan/runtime-herdr";
import { Store, writeRole } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { startCardiganServer } from "../../server/src/index.js";
import { HcCore, runCleanupSteps } from "../../server/test-support/hc.js";
import {
  createProcessIo,
  humanActor,
  runCommand,
  startAssignment,
} from "./index.js";
import { registerTemplateRoles } from "./template-fixtures.js";

const sdk = createRequire(resolve("packages/mcp-server/package.json"));
const sdkUrl = (name: string) => pathToFileURL(sdk.resolve(name)).href;
const exec = promisify(execFile),
  project_id = "p-launch" as never;
const config = parseLaunchConfig({
  providers: {
    fixture: { harness: "pi", secret_env: { FIXTURE_API_KEY: "key" } },
  },
  profiles: {
    fixture: { harness: "pi", provider: "fixture", model: "fixture-model" },
  },
});
let root: string, dataDir: string, store: Store, assignment: Assignment;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cg-m2-start-"));
  dataDir = join(root, "private");
  store = Store.open({ dataDir });
  store.createProject({ id: project_id, name: "Launch acceptance" });
});
afterEach(async () => {
  store.close();
  await rm(root, { recursive: true, force: true });
});
function seed(worktree: Role["worktree"] = "none") {
  store.uow.run((tx) =>
    writeRole(
      tx,
      project_id,
      {
        role_id: "coder",
        version: 1,
        display_name: "Coder",
        kind: "work",
        core_prompt: corePromptFor("coder"),
        harness: "pi",
        launch_profile_ref: "fixture",
        allowed_tools: ["whoami", "get_card", "submit_delivery"],
        capabilities: ["code"],
        abilities: [],
        worktree,
        required_machine_tags: [],
      },
      { mode: "add" },
    ),
  );
  registerTemplateRoles(store, project_id);
  const actor = humanActor(project_id);
  const card = runCommand(store, {
    project_id,
    actor,
    reduce: (s, a, p) =>
      createCard(
        s,
        a,
        {
          title: "Start",
          goal: "Read task",
          acceptance_criteria: ["MCP works"],
          source: { kind: "quote", text: "fixture" },
          repo: "fixture/repo",
          base_branch: "main",
        },
        p,
      ),
  });
  const item = store.uow.read((tx) =>
    tx.work_items
      .list(project_id)
      .find((w) => w.card_id === card.id && w.kind === "produce"),
  );
  if (!item) throw new Error("Missing work item");
  assignment = runCommand(store, {
    project_id,
    actor,
    reduce: (s, a, p) =>
      assign(s, a, { work_item_id: item.id, role_id: "coder" }, p),
  });
  return { card, item };
}
const records = () =>
  store.uow.run((tx) => ({
    runs: tx.runs.list(project_id),
    tokens: tx.tokensForAssignment(project_id, assignment.id),
  }));
function runtime(): Runtime {
  return {
    provision: vi.fn(async () => ({
      ok: true,
      value: {
        machine_id: "local",
        runtime_machine: "local",
        terminal_ref: "t1",
        agent_name: "fixture",
      } as RuntimeRef,
    })),
    release: vi.fn(async () => ({ ok: true, value: undefined })),
    interrupt: async () => ({ ok: true, value: undefined }),
    wake: async () => ({ ok: true, value: { sent: true } }),
    status: async () => ({
      ok: true,
      value: { process: "alive", agent: "idle", observed_seq: 1 },
    }),
    resume_or_replace: async () => {
      throw new Error("unused");
    },
    human_entry: async () => ({ ok: true, value: "fixture" }),
  };
}
function options(adapter: Runtime) {
  return {
    store,
    project_id,
    assignment_id: assignment.id,
    runtime: adapter,
    dataDir,
    io: {
      ...createProcessIo(),
      cwd: root,
      env: { CARDIGAN_RUNTIME_MODE: "local", CARDIGAN_DATA_DIR: dataDir },
      stdout: vi.fn(),
      stderr: vi.fn(),
      captureCommand: vi.fn(async () => ({
        code: 0,
        stdout: "pi fixture-version",
        stderr: "",
      })),
    },
    launch: { config, secrets: { key: "fixture-provider-key" } },
    mcpUrl: "http://127.0.0.1:3004/mcp",
  };
}
test("S01 CLI version failure produces neither a queued Run nor a token", async () => {
  seed();
  const adapter = runtime(),
    input = options(adapter);
  input.io.captureCommand.mockResolvedValue({
    code: 1,
    stdout: "",
    stderr: "not installed",
  });
  await expect(startAssignment(input)).rejects.toThrow();
  expect(records()).toEqual({ runs: [], tokens: [] });
  expect(adapter.provision).not.toHaveBeenCalled();
});
test.each(["worktree", "compile", "provision", "dispatch"])(
  "S02 %s failure closes the Run, revokes credentials and preserves the worktree",
  async (stage) => {
    seed("write");
    const adapter = runtime();
    const path = join(root, "retained-worktree");
    await mkdir(path);
    await writeFile(join(path, "work"), "must remain");
    store.setProjectRepo({ project_id, repo_path: path });
    const input = {
      ...options(adapter),
      worktree: async () => {
        if (stage === "worktree") throw new Error("Git unavailable");
        return { path, branch: "agent/C-1/W-1", base_sha: "a".repeat(40) };
      },
    };
    if (stage === "compile")
      input.launch.secrets = {} as typeof input.launch.secrets;
    if (stage === "provision")
      vi.mocked(adapter.provision).mockResolvedValue({
        ok: false,
        error: { code: "runtime_unavailable", message: "fixture" },
      });
    if (stage === "dispatch")
      vi.mocked(adapter.provision).mockResolvedValue({
        ok: true,
        value: {
          machine_id: "other",
          runtime_machine: "local",
          terminal_ref: "t1",
          agent_name: "fixture",
        } as RuntimeRef,
      });
    await expect(startAssignment(input)).rejects.toThrow();
    const result = records();
    expect(result.runs).toHaveLength(1);
    expect(["cancelled", "failed"]).toContain(result.runs[0]?.status);
    expect(result.runs[0]?.summary).not.toBe("");
    expect(result.tokens).toHaveLength(stage === "worktree" ? 0 : 1);
    expect(result.tokens.every((token) => token.revoked_at !== null)).toBe(
      true,
    );
    for (const name of ["token", "secrets.env"])
      expect(
        existsSync(join(dataDir, "runs", project_id, assignment.id, name)),
      ).toBe(false);
    expect(await readFile(join(path, "work"), "utf8")).toBe("must remain");
    if (stage === "dispatch")
      expect(adapter.release).toHaveBeenCalledWith(
        expect.objectContaining({ terminal_ref: "t1" }),
        { force: true },
      );
  },
);

const probeSession = `cg-m2-probe-${randomUUID().slice(0, 8)}`;
const hc = await (async () => {
  try {
    const binary = (await exec("which", ["hc"])).stdout.trim();
    const version = (
      await exec(binary, ["--version"], {
        env: { ...process.env, HC_SESSION: probeSession },
        timeout: 3000,
      })
    ).stdout.trim();
    if (version === "hc 0.1.18") return binary;
    console.warn(
      `M2.T2 real runtime skipped: expected hc 0.1.18, got ${version}`,
    );
  } catch {
    console.warn("M2.T2 real runtime skipped: hc 0.1.18 is unavailable");
  }
  return undefined;
})();
test.skipIf(!hc)(
  "S03 real CLI/server/hc advances queued → dispatched → running, rejects duplicate start and cleans up",
  async () => {
    const { card, item } = seed("write"),
      source = join(root, "source"),
      bin = join(root, "bin"),
      launchDir = join(root, "config");
    const session = `cg-m2-e2e-${randomUUID().slice(0, 8)}`,
      xdg = join(root, "runtime");
    const socket = join(xdg, "cardigan", `${session}.sock`),
      provisionGate = join(root, "provision-go"),
      mcpGate = join(root, "mcp-go"),
      report = join(root, "agent-report.json");
    await Promise.all([mkdir(bin), mkdir(launchDir), mkdir(xdg)]);
    const env = {
      ...process.env,
      CARDIGAN_RUNTIME_MODE: "local",
      CARDIGAN_DATA_DIR: dataDir,
      CARDIGAN_CONFIG_DIR: launchDir,
      CARDIGAN_HC_SESSION: session,
      HC_SESSION: session,
      HC_SOCKET: socket,
      XDG_RUNTIME_DIR: xdg,
      XDG_DATA_HOME: join(root, "xdg-data"),
      XDG_STATE_HOME: join(root, "xdg-state"),
      PATH: `${bin}:${process.env.PATH}`,
    };
    await exec("git", ["init", "-b", "main", source]);
    await writeFile(join(source, "file"), "baseline");
    await exec("git", ["-C", source, "add", "file"]);
    await exec("git", [
      "-C",
      source,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "initial",
    ]);
    const sha = (
      await exec("git", ["-C", source, "rev-parse", "HEAD"])
    ).stdout.trim();
    store.setProjectRepo({ project_id, repo_path: source });
    const old = store.issueToken({
      project_id,
      assignment_id: assignment.id,
      role: {
        role_version: 1,
        allowed_tools: ["whoami", "get_card", "submit_delivery"],
      },
    }).token;
    await writeFile(join(launchDir, "launch.yaml"), JSON.stringify(config));
    await writeFile(join(launchDir, "secrets.env"), "key=fixture-key\n", {
      mode: 0o600,
    });
    await writeFile(
      join(bin, "hc"),
      `#!/usr/bin/env node\nconst fs=require('node:fs'); const {spawnSync}=require('node:child_process');\n(async()=>{while(process.argv[2]==='run'&&!fs.existsSync(${JSON.stringify(provisionGate)})) await new Promise(r=>setTimeout(r,10)); const c=spawnSync(${JSON.stringify(hc)},process.argv.slice(2),{stdio:'inherit',env:process.env}); process.exit(c.status??1);})();\n`,
      { mode: 0o700 },
    );
    await writeFile(
      join(bin, "pi"),
      `#!/usr/bin/env node
if(process.argv.includes('--version')) { console.log('pi acceptance-1'); process.exit(0); }
(async()=>{
 const fs=require('node:fs'); const path=require('node:path');
 const {Client}=await import(${JSON.stringify(sdkUrl("@modelcontextprotocol/sdk/client/index.js"))});
 const {StreamableHTTPClientTransport}=await import(${JSON.stringify(sdkUrl("@modelcontextprotocol/sdk/client/streamableHttp.js"))});
 while(!fs.existsSync(${JSON.stringify(mcpGate)})) await new Promise(r=>setTimeout(r,20));
 const directory=path.dirname(process.env.PI_CODING_AGENT_DIR);
 const mcp=JSON.parse(fs.readFileSync(path.join(process.env.PI_CODING_AGENT_DIR,'mcp.json'),'utf8')).mcpServers.card;
 const client=new Client({name:'acceptance-agent',version:'1'});
 await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url),{requestInit:{headers:{Authorization:'Bearer '+process.env.MCP_TOKEN}}}));
 const parse=r=>JSON.parse(r.content[0].text);
 const who=parse(await client.callTool({name:'whoami',arguments:{}}));
 const card=parse(await client.callTool({name:'get_card',arguments:{card_id:who.card_id}}));
 fs.writeFileSync(${JSON.stringify(report)},JSON.stringify({who,card,tokenGone:!fs.existsSync(path.join(directory,'token')),secretsGone:!fs.existsSync(path.join(directory,'secrets.env')),keyPresent:!!process.env.FIXTURE_API_KEY}));
 await client.close(); process.stdout.write('\x1b]7501;{"state":"idle"}\x07'); setInterval(()=>{},1000);
})().catch(e=>{require('node:fs').writeFileSync(${JSON.stringify(report)},JSON.stringify({error:String(e)}));process.exit(1);});
`,
      { mode: 0o700 },
    );
    const server = await startCardiganServer({
      config: {
        dataDir,
        host: "127.0.0.1",
        port: 0,
        execution: { mode: "local", dataDir },
      },
      store,
      warn() {},
      log() {},
    });
    const cli = (sub: string) =>
      exec(
        process.execPath,
        [
          resolve("apps/cli/dist/bin.js"),
          "assignment",
          sub,
          assignment.id,
          "--project",
          project_id,
          "--data-dir",
          dataDir,
          "--hc-session",
          session,
          "--mcp-url",
          server.url,
        ],
        { env, timeout: 20000 },
      );
    const start = cli("start");
    void start.catch(() => {});
    try {
      await expect
        .poll(() => records().runs[0]?.status, { timeout: 8000 })
        .toBe("queued");
      await writeFile(provisionGate, "go");
      await start;
      expect(records().runs[0]?.status).toBe("dispatched");
      const placed = store.uow.read((tx) =>
        tx.assignments.get(project_id, assignment.id),
      );
      expect(placed).toMatchObject({
        worktree_path: join(
          dataDir,
          "agent",
          "worktrees",
          project_id,
          assignment.id,
        ),
        branch: "agent/C-1/W-1",
        base_sha: sha,
      });
      expect(store.verifyToken(old)).toBeUndefined();
      const tokenIds = records().tokens.map((t) => t.id);
      await expect(cli("start")).rejects.toThrow();
      expect(records().runs).toHaveLength(1);
      expect(records().tokens.map((t) => t.id)).toEqual(tokenIds);
      expect(existsSync(socket)).toBe(true); // Never use an hc read as the initial liveness probe.
      const ref = placed?.runtime_ref;
      if (!ref) throw new Error("Missing runtime ref");
      const entry = await cli("attach");
      expect(entry.stdout).toContain("attach");
      expect(entry.stdout).toContain(ref.terminal_ref);
      const terminal = JSON.parse(
        (await exec(hc as string, ["get", ref.terminal_ref, "--json"], { env }))
          .stdout,
      );
      const short = createHash("sha256")
        .update(project_id)
        .digest("hex")
        .slice(0, 8);
      expect(JSON.stringify(terminal)).toContain(`coder-${short}-c-1-w-1-a-1`);
      expect(terminal.labels).toMatchObject({
        cardigan: "1",
        project: project_id,
        assignment: assignment.id,
        run: records().runs[0]?.id,
      });
      await writeFile(mcpGate, "go");
      await expect
        .poll(
          async () =>
            existsSync(report)
              ? JSON.parse(await readFile(report, "utf8"))
              : undefined,
          { timeout: 10000 },
        )
        .toMatchObject({
          who: { assignment_id: assignment.id, card_id: card.id },
          card: { card: { id: card.id } },
          tokenGone: true,
          secretsGone: true,
          keyPresent: true,
        });
      // The acknowledge hook runs on the Agent's first tool call, so give it a
      // moment instead of reading the row exactly once: a slow machine must not
      // turn a correct Run into a failure.
      await expect
        .poll(() => records().runs[0]?.status, { timeout: 5000 })
        .toBe("running");
      expect(records().runs[0]).toMatchObject({
        status: "running",
        role_version: 1,
        model: "fixture-model",
        agent_cli_version: "pi acceptance-1",
      });
      // The status is not the only evidence: run_started is what moves the work
      // item, and it must be on the timeline of the card.
      expect(
        store
          .getUpdates({
            project_id: project_id as never,
            card_id: card.id,
            since_seq: 0,
          })
          .events.map((event) => event.type),
      ).toContain("run_started");
      expect(
        store.uow.read((tx) => tx.work_items.get(project_id, item.id))?.status,
      ).toBe("in_progress");
      await cli("stop");
      expect(records().runs[0]?.status).toBe("cancelled");
      expect(records().tokens.every((t) => t.revoked_at !== null)).toBe(true);
      expect(
        await readFile(
          join(
            dataDir,
            "agent",
            "worktrees",
            project_id,
            assignment.id,
            "file",
          ),
          "utf8",
        ),
      ).toBe("baseline");
      const probe = await HerdrRuntime.create({
        binary: hc,
        session,
        socketPath: socket,
        env,
        execution: { mode: "local", dataDir },
      });
      if (!probe.ok) throw new Error(probe.error.code);
      expect(await probe.value.status(ref)).toMatchObject({
        ok: false,
        error: { code: "runtime_not_found" },
      });
    } finally {
      await writeFile(provisionGate, "go");
      await writeFile(mcpGate, "go");
      await start.catch(() => {});
      // Record the core's PID first: once the socket is gone, hc cannot stop it.
      const core = new HcCore(session, socket, env);
      core.remember();
      // §P2a-2: close the server and let the started assignment settle before
      // stopping the core, so no late hc call can start a holder and a core.
      await runCleanupSteps({
        session,
        socket,
        steps: [
          { label: "close server", run: () => server.close() },
          {
            label: "drain the started assignment",
            run: () => start.catch(() => {}),
          },
          { label: "stop herdr-core", run: () => core.finalStop() },
          {
            label: "verify herdr-core stopped",
            run: () => core.assertStopped(),
          },
        ],
      });
    }
  },
  40_000,
);

// M2 §4 step 7: the wrapper must hand the first task message to the CLI, because
// first.md alone does not trigger an Agent turn. All three harnesses take it as
// the last positional argument of their interactive invocation.
test.each(["claude-code", "codex", "pi"] as const)(
  "S04 %s passes the first task message to the launched CLI",
  async (harness) => {
    const message = firstPrompt({
      assignment_id: "A-1",
      run_id: "R-1",
      card_id: "C-1",
      work_item_id: "W-1",
    });
    const launch = compileAssignmentLaunch({
      assignment: { assignment_id: "A-1", run_id: "R-1" },
      role: {
        role_id: "coder",
        harness,
        launch_profile: "fixture",
        core_prompt: corePromptFor("coder"),
        allowed_tools: ["whoami", "get_card", "submit_delivery"],
        worktree: "none",
      },
      launch: parseLaunchConfig({
        profiles: { fixture: { harness, model: "fixture" } },
      }),
      mcp: { url: "http://127.0.0.1:3004/mcp" },
      run_dir: join(root, "run"),
      work_dir: root,
      first_prompt: message,
      secrets: {},
    });
    for (const file of launch.files) {
      await mkdir(dirname(file.path), { recursive: true });
      await writeFile(file.path, file.content, { mode: file.mode });
    }
    await writeFile(launch.token_file, "fixture-token", { mode: 0o600 });
    // The wrapper waits for the dispatch sentinel (see START_FILE_NAME).
    await writeFile(join(root, "run", START_FILE_NAME), "", { mode: 0o600 });
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(
      join(bin, launch.command),
      "#!/usr/bin/env node\nconsole.log(JSON.stringify({args:process.argv.slice(2),stdin:require('node:fs').readFileSync(0,'utf8')}));\n",
      { mode: 0o700 },
    );
    const running = exec(launch.launch_script, [], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    running.child.stdin?.end();
    const received = JSON.parse((await running).stdout);
    expect([...received.args, received.stdin].join("\n")).toContain(message);
  },
);
