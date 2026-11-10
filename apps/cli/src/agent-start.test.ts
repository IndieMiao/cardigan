import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  type Assignment,
  assign,
  createCard,
  type Role,
  type RuntimeRef,
} from "@cardigan/domain";
import { corePromptFor, parseLaunchConfig } from "@cardigan/roles";
import { resolveExecutionConfig } from "@cardigan/runtime-herdr";
import { Store, writeRole } from "@cardigan/store";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type LaunchRuntime,
  type StartOptions,
  startAssignment,
  startAssignmentCommand,
  stopAssignment,
} from "./assignment.js";
import { humanActor, runCommand } from "./host.js";
import type { CliIo } from "./io.js";
import { registerTemplateRoles } from "./template-fixtures.js";
import { runWorkflowCommand } from "./workflow.js";

const exec = promisify(execFile);
const project_id = "p-agent" as never;
const secret = "fixture-provider-value";
const launch = {
  config: parseLaunchConfig({
    providers: {
      gateway: { harness: "pi", secret_env: { PROVIDER_API_KEY: "provider" } },
      codex: { harness: "codex", secret_env: { OPENAI_API_KEY: "provider" } },
    },
    profiles: {
      agent: { harness: "pi", provider: "gateway", model: "fixture-model" },
      "codex-agent": {
        harness: "codex",
        provider: "codex",
        model: "fixture-model",
      },
    },
  }),
  secrets: { provider: secret },
};
const ok = <T>(value: T) => ({ ok: true as const, value });
describe.skipIf(process.platform !== "linux" || process.getgid?.() === 0)(
  "isolated Assignment launch wiring",
  () => {
    let root: string,
      dataDir: string,
      agentRoot: string,
      runDir: string,
      source: string;
    let store: Store,
      io: CliIo,
      runtime: LaunchRuntime & Required<Pick<LaunchRuntime, "captureAgent">>,
      assignment: Assignment;
    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), "cg-agent-start-"));
      dataDir = join(root, "private");
      agentRoot = join(root, "agent");
      source = join(root, "source");
      await mkdir(dataDir, { mode: 0o700 });
      await mkdir(agentRoot, { mode: 0o2750 });
      await chmod(agentRoot, 0o2750);
      store = Store.open({ dataDir });
      store.createProject({ id: project_id, name: "Agent" });
      io = {
        cwd: root,
        platform: "linux",
        signals: { on() {}, off() {} },
        stdout: vi.fn(),
        stderr: vi.fn(),
        env: {
          CARDIGAN_RUNTIME_MODE: "agent-ssh",
          CARDIGAN_DATA_DIR: dataDir,
          CARDIGAN_AGENT_ROOT: agentRoot,
          CARDIGAN_AGENT_GID: String(process.getgid?.()),
          CARDIGAN_AGENT_IDENTITY: join(root, "key"),
          CARDIGAN_AGENT_KNOWN_HOSTS: join(root, "known"),
          CARDIGAN_CONFIG_DIR: join(root, "config"),
        },
        captureCommand: vi.fn(async () => {
          throw new Error("host CLI must not run");
        }),
        spawnInherit() {
          throw new Error("unexpected host spawn");
        },
      };
      runtime = {
        captureAgent: vi.fn(async (command, args) =>
          command === "git"
            ? ok((await exec("git", [...args])).stdout)
            : ok(`${command} fixture-agent-version\n`),
        ),
        provision: vi.fn(async (_a, _r, _m, launch) =>
          ok({
            machine_id: "local",
            runtime_machine: "cardigan-agent",
            terminal_ref: "cardigan-agent/t1",
            agent_name: launch.agent_name,
          } as RuntimeRef),
        ),
        release: vi.fn(async () => ok(undefined)),
        wake: async () => ok({ sent: true }),
        interrupt: async () => ok(undefined),
        status: async () =>
          ok({ process: "alive", agent: "idle", observed_seq: 1 }),
        human_entry: async () => ok("fixture attach"),
        resume_or_replace: async () => {
          throw new Error("unused");
        },
      };
    });
    afterEach(async () => {
      vi.unstubAllEnvs();
      store.close();
      await rm(root, { recursive: true, force: true });
    });
    function seed(
      worktree: Role["worktree"] = "none",
      harness: "pi" | "codex" = "pi",
    ) {
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
            harness,
            launch_profile_ref: harness === "codex" ? "codex-agent" : "agent",
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
      const card = runCommand(store, {
        project_id,
        actor: humanActor(project_id),
        reduce: (s, a, p) =>
          createCard(
            s,
            a,
            {
              title: "Launch",
              goal: "Isolate",
              acceptance_criteria: ["starts"],
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
      if (!item) throw new Error("Template produce work item missing");
      assignment = runCommand(store, {
        project_id,
        actor: humanActor(project_id),
        reduce: (s, a, p) =>
          assign(s, a, { work_item_id: item.id, role_id: "coder" }, p),
      });
      runDir = join(agentRoot, "runs", project_id, assignment.id);
      return assignment;
    }
    const options = (): StartOptions => ({
      store,
      io,
      runtime,
      dataDir,
      project_id,
      assignment_id: assignment.id,
      launch,
      mcpUrl: "http://127.0.0.1:3004/mcp",
    });
    const state = () =>
      store.uow.run((tx) => ({
        runs: tx.runs.list(project_id),
        tokens: tx.tokensForAssignment(project_id, assignment.id),
      }));
    test.each(["callbacks", "instance methods", "codex trust"])(
      "start command wires Agent Git, versions and shared files (%s); stop revokes credentials and keeps the worktree",
      async (implementation) => {
        const capture = runtime.captureAgent;
        if (implementation === "instance methods") {
          // A plain vi.fn does not need a receiver and cannot catch detached methods.
          class StatefulRuntime {
            #capture = capture;
            captureAgent(...args: Parameters<typeof capture>) {
              return this.#capture(...args);
            }
          }
          const { captureAgent: _capture, ...operations } = runtime;
          runtime = Object.assign(new StatefulRuntime(), operations);
        }
        const harness = implementation === "codex trust" ? "codex" : "pi";
        seed("write", harness);
        for (const name of ["key", "known"])
          await writeFile(join(root, name), "fixture-only", { mode: 0o600 });
        const bin = join(root, "bin");
        await mkdir(bin);
        await writeFile(
          join(bin, "ssh"),
          `#!/usr/bin/env node
const {spawnSync} = require('node:child_process');
const args = process.argv.slice(2), at = args.indexOf('--');
if (args[at + 1] !== 'agent@localhost') process.exit(99);
const child = spawnSync('sh', ['-c', args.slice(at + 2).join(' ')], {cwd: ${JSON.stringify(agentRoot)}, stdio:'inherit'});
process.exit(child.status ?? 98);
`,
          { mode: 0o700 },
        );
        vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
        vi.stubEnv("CARDIGAN_GIT_QUERY_TIMEOUT_MS", "12345");
        await exec("git", ["init", "-b", "main", source]);
        await writeFile(join(source, "file"), "fixture");
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
          "fixture",
        ]);
        store.setProjectRepo({ project_id, repo_path: source });
        const configDir = join(root, "config");
        await mkdir(configDir);
        await writeFile(
          join(configDir, "launch.yaml"),
          JSON.stringify(launch.config),
        );
        await writeFile(
          join(configDir, "secrets.env"),
          `provider=${secret}\n`,
          {
            mode: 0o600,
          },
        );
        await startAssignmentCommand({
          store,
          io,
          runtime,
          dataDir,
          project_id,
          assignment_id: assignment.id,
        });
        const path = join(agentRoot, "worktrees", project_id, assignment.id);
        expect(await readFile(join(path, "file"), "utf8")).toBe("fixture");
        expect((await lstat(runDir)).mode & 0o7777).toBe(0o2770);
        for (const name of [
          "token",
          "secrets.env",
          harness === "codex" ? "codex/config.toml" : "pi/mcp.json",
        ])
          expect((await lstat(join(runDir, name))).mode & 0o777).toBe(0o660);
        expect((await lstat(join(runDir, "launch.sh"))).mode & 0o777).toBe(
          0o770,
        );
        expect(state().runs[0]).toMatchObject({
          status: "dispatched",
          agent_cli_version: `${harness} fixture-agent-version`,
        });
        expect(vi.mocked(runtime.provision).mock.calls[0]?.[3]).toMatchObject({
          cwd: path,
          command: join(runDir, "launch.sh"),
        });
        expect(io.captureCommand).not.toHaveBeenCalled();
        expect(capture).toHaveBeenCalledWith(harness, ["--version"]);
        if (harness === "codex") {
          // Test-only real Git verifies the common dir of the actual service-created
          // worktree. Production host compilation must not execute Git here.
          const common = (
            await exec("git", [
              "-C",
              path,
              "rev-parse",
              "--path-format=absolute",
              "--git-common-dir",
            ])
          ).stdout.trim();
          const config = await readFile(
            join(runDir, "codex/config.toml"),
            "utf8",
          );
          expect(common).toBe(join(agentRoot, "repos", project_id, ".git"));
          expect(
            [...config.matchAll(/^\[projects\.(.+)\]$/gm)].map((m) =>
              JSON.parse(m[1] ?? ""),
            ),
          ).toEqual([path, join(agentRoot, "repos", project_id)]);
        }
        const gitCalls = vi
          .mocked(capture)
          .mock.calls.filter(([command]) => command === "git");
        expect(gitCalls.length).toBeGreaterThan(0);
        expect(gitCalls.every((call) => call[2] === 12345)).toBe(true);
        const token = (await readFile(join(runDir, "token"), "utf8")).trim();
        expect(JSON.stringify(vi.mocked(io.stdout).mock.calls)).not.toContain(
          token,
        );
        expect(JSON.stringify(vi.mocked(io.stdout).mock.calls)).not.toContain(
          secret,
        );
        await stopAssignment({
          store,
          project_id,
          assignment_id: assignment.id,
          runtime,
          execution: resolveExecutionConfig(io.env),
        });
        for (const name of ["token", "secrets.env"])
          await expect(lstat(join(runDir, name))).rejects.toThrow();
        expect(state().tokens.every((t) => t.revoked_at !== null)).toBe(true);
        expect(await readFile(join(path, "file"), "utf8")).toBe("fixture");
      },
    );
    test("roles without worktrees run in the shared run directory and duplicate starts preserve the live token", async () => {
      seed();
      const first = await startAssignment(options());
      const token = await readFile(join(runDir, "token"), "utf8");
      expect(vi.mocked(runtime.provision).mock.calls[0]?.[3].cwd).toBe(runDir);
      await expect(startAssignment(options())).rejects.toMatchObject({
        exitCode: 2,
        message: `无法启动 Assignment ${assignment.id}：这个 Assignment 或工作区已有尚未结束的 Run，不能重复启动（invariant_violation）`,
      });
      expect(await readFile(join(runDir, "token"), "utf8")).toBe(token);
      expect(state().runs).toHaveLength(1);
      expect(
        state().tokens.find((t) => t.id === first.token_id)?.revoked_at,
      ).toBeNull();
    });
    test.each(["permissions", "worktree", "compile", "provision", "dispatch"])(
      "%s failure cancels the queued Run and revokes/removes any new credentials",
      async (phase) => {
        seed(phase === "worktree" ? "write" : "none");
        const input = options();
        if (phase === "permissions") await chmod(agentRoot, 0o2770);
        if (phase === "worktree") {
          store.setProjectRepo({ project_id, repo_path: source });
          Object.assign(input, {
            worktree: async () => {
              throw new Error("Git unavailable");
            },
          });
        }
        if (phase === "compile")
          Object.assign(input, {
            launch: { config: launch.config, secrets: {} },
          });
        if (phase === "provision")
          vi.mocked(runtime.provision).mockResolvedValue({
            ok: false,
            error: { code: "runtime_unavailable", message: "fixture" },
          });
        if (phase === "dispatch") {
          vi.mocked(runtime.provision).mockResolvedValue(
            ok({
              machine_id: "other",
              runtime_machine: "cardigan-agent",
              terminal_ref: "cardigan-agent/t1",
              agent_name: "fixture",
            } as RuntimeRef),
          );
        }
        await expect(startAssignment(input)).rejects.toThrow();
        expect(state().runs).toHaveLength(1);
        expect(state().runs[0]?.status).toBe("cancelled");
        expect(state().tokens).toHaveLength(
          ["compile", "provision", "dispatch"].includes(phase) ? 1 : 0,
        );
        expect(state().tokens.every((t) => t.revoked_at !== null)).toBe(true);
        for (const name of ["token", "secrets.env"])
          await expect(lstat(join(runDir, name))).rejects.toThrow();
        if (phase === "dispatch")
          expect(runtime.release).toHaveBeenCalledOnce();
      },
    );
    test("release failure still revokes tokens and cancels the Run", async () => {
      seed();
      vi.mocked(runtime.provision).mockResolvedValue(
        ok({
          machine_id: "other",
          runtime_machine: "cardigan-agent",
          terminal_ref: "cardigan-agent/t1",
          agent_name: "fixture",
        } as RuntimeRef),
      );
      vi.mocked(runtime.release).mockRejectedValue(new Error("release failed"));
      await expect(startAssignment(options())).rejects.toThrow();
      expect(state().runs[0]?.status).toBe("cancelled");
      expect(state().tokens.every((t) => t.revoked_at !== null)).toBe(true);
      expect(io.stderr).toHaveBeenCalledWith("终端回收失败，需要人工检查");
      await expect(lstat(join(runDir, "token"))).rejects.toThrow();
    });
    test("Agent version failure never falls back to a host CLI", async () => {
      seed();
      vi.mocked(runtime.captureAgent).mockResolvedValue({
        ok: false,
        error: { code: "runtime_unavailable", message: "offline" },
      });
      await expect(startAssignment(options())).rejects.toMatchObject({
        exitCode: 1,
        message: `无法启动 Assignment ${assignment.id}：运行时不可用，请检查运行服务（runtime_unavailable）`,
      });
      expect(state().runs).toEqual([]);
      expect(state().tokens).toEqual([]);
      expect(io.captureCommand).not.toHaveBeenCalled();
    });
    test("assign --start refuses unsafe data permissions before changing the Assignment", async () => {
      seed();
      await chmod(dataDir, 0o750);
      const start = vi.fn();
      await expect(
        runWorkflowCommand(
          ["assign", "W-1", "--role", "coder", "--start"],
          io,
          { start },
        ),
      ).rejects.toThrow(/0700/);
      expect(start).not.toHaveBeenCalled();
      expect(
        store.uow.read((tx) => tx.assignments.list(project_id)),
      ).toHaveLength(1);
    });
  },
);
