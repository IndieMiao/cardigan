import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { getPriority, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { compileAssignmentLaunch, parseLaunchConfig } from "@cardigan/roles";
import {
  type ExecutionConfig,
  executionPaths,
  HerdrRuntime,
  writeAgentLaunch,
  writeAgentSentinel,
} from "@cardigan/runtime-herdr";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { HC_RELEASE } from "../../runtime-herdr/src/hc-version.js";
import {
  assignment,
  machine,
  ref,
  role,
  value,
} from "../../runtime-herdr/src/test-support.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cg-claude-config-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function fixture(mode: "local" | "agent-ssh", agentNice?: number) {
  const dataDir = join(root, "data"),
    agentRoot = join(root, "agent");
  await mkdir(dataDir, { mode: 0o700 });
  await mkdir(agentRoot, { mode: 0o2750 });
  await chmod(agentRoot, 0o2750);
  const identityFile = join(root, "key"),
    knownHostsFile = join(root, "known_hosts");
  for (const path of [identityFile, knownHostsFile])
    await writeFile(path, "fixture", { mode: 0o600 });
  const execution: ExecutionConfig =
    mode === "local"
      ? { mode, dataDir }
      : {
          mode,
          dataDir,
          agentRoot,
          gid: process.getgid?.() ?? 0,
          machine: "cardigan-agent",
          identityFile,
          knownHostsFile,
        };
  const { runDir } = executionPaths(execution, "project", assignment.id);
  const configDir = join(runDir, "claude"),
    home = join(root, "home"),
    bin = join(root, "bin");
  await mkdir(home, { mode: 0o500 });
  await mkdir(bin);
  // A real child process simulates Claude saving state. No model, hc core or sudo is invoked.
  await writeFile(
    join(bin, "claude"),
    `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const directory = process.env.CLAUDE_CONFIG_DIR;
const initial = JSON.parse(fs.readFileSync(path.join(directory, '.claude.json'), 'utf8'));
const settings = JSON.parse(fs.readFileSync(path.join(directory, 'settings.json'), 'utf8'));
fs.mkdirSync(path.join(directory, 'sessions'), {recursive: true, mode: 0o700});
const record = path.join(directory, 'sessions', 'fixture-session.json');
const visits = fs.existsSync(record) ? Number(fs.readFileSync(record, 'utf8')) + 1 : 1;
fs.writeFileSync(record, String(visits));
fs.writeFileSync(path.join(directory, '.claude.json'), '{}');
const niceness = require('node:os').getPriority();
const childNiceness = Number(require('node:child_process').execFileSync(process.execPath, ['-e', "console.log(require('node:os').getPriority())"]));
console.log(JSON.stringify({directory, visits, initial, settings, niceness, childNiceness, prompt: process.argv.at(-1)}));
`,
    { mode: 0o700 },
  );
  async function prepare(run: string, workDir = runDir) {
    const compiled = compileAssignmentLaunch({
      ...(agentNice === undefined ? {} : { agent_nice: agentNice }),
      assignment: { assignment_id: assignment.id, run_id: run },
      role: {
        role_id: "coder",
        harness: "claude-code",
        launch_profile: "claude",
        core_prompt: "Fixture",
        allowed_tools: ["whoami"],
        worktree: workDir === runDir ? "none" : "write",
      },
      launch: parseLaunchConfig({
        profiles: {
          claude: {
            harness: "claude-code",
            model: "fixture",
            ...(run === "R-2" ? { args: ["--resume", "fixture-session"] } : {}),
          },
        },
      }),
      run_dir: runDir,
      work_dir: workDir,
      first_prompt: `run=${run}`,
      mcp: { url: "http://localhost/mcp" },
      secrets: {},
    });
    if (execution.mode === "agent-ssh") {
      await writeAgentLaunch(
        execution,
        "project",
        assignment.id,
        compiled.files,
        "fixture-token",
      );
    } else {
      for (const file of compiled.files) {
        await mkdir(dirname(file.path), { recursive: true, mode: 0o700 });
        await writeFile(file.path, file.content, { mode: file.mode });
      }
      await writeFile(compiled.token_file, "fixture-token", { mode: 0o600 });
    }
    await writeAgentSentinel(execution, "project", assignment.id);
    expect(compiled.env.CLAUDE_CONFIG_DIR).toBe(configDir);
    // Host launch files stay outside the private Claude directory, including on replacement.
    expect(
      compiled.files.every((file) => !file.path.startsWith(`${configDir}/`)),
    ).toBe(true);
    return {
      command: compiled.launch_script,
      args: [],
      cwd: runDir,
      agent_name: ref.agent_name,
      labels: { project: "project", assignment: assignment.id, run },
    };
  }
  const observations: {
    directory: string;
    visits: number;
    initial: unknown;
    settings: unknown;
    prompt: string;
    niceness: number;
    childNiceness: number;
  }[] = [];
  const launches: (readonly string[])[] = [];
  const runtime = value(
    await HerdrRuntime.create({
      execution,
      session: "claude-config-test",
      client: {
        available: async () => true,
        exec: async (args) => {
          if (args[0] === "--version") return `hc ${HC_RELEASE.version}`;
          if (args[0] === "machine")
            return JSON.stringify(
              args[1] === "ls"
                ? { machines: [] }
                : { version: HC_RELEASE.version },
            );
          if (args[0] === "run") {
            launches.push(args);
            const index = args.indexOf("--"),
              command = args[index + 1];
            if (!command) throw new Error("Missing launch command");
            observations.push(
              JSON.parse(
                execFileSync(command, args.slice(index + 2), {
                  encoding: "utf8",
                  cwd: runDir,
                  env: {
                    ...process.env,
                    HOME: home,
                    CLAUDE_CONFIG_DIR: join(home, ".claude"),
                    PATH: `${bin}:${process.env.PATH ?? ""}`,
                  },
                }),
              ),
            );
          }
          return JSON.stringify({
            address: `${mode === "agent-ssh" ? "cardigan-agent/" : ""}t${launches.length}`,
            state: "live",
            status: { state: "idle" },
          });
        },
        async *lines() {
          yield "";
        },
      },
    }),
  );
  return { runDir, configDir, home, prepare, runtime, observations, launches };
}

// Shared-group IO runs under this test UID; real cross-UID SSH remains a smoke test.
describe.skipIf(process.platform !== "linux")(
  "Claude Assignment session directory",
  () => {
    test.each(["local", "agent-ssh"] as const)(
      "%s creates private state as the CLI user and preserves it across resume_or_replace",
      async (mode) => {
        const parentNiceness = getPriority();
        const agentNice = mode === "agent-ssh" ? 17 : undefined;
        const f = await fixture(mode, agentNice);
        const first = await f.prepare("R-1");
        await expect(stat(f.configDir)).rejects.toMatchObject({
          code: "ENOENT",
        });
        const firstRef = value(
          await f.runtime.provision(
            assignment,
            { ...role, harness: "claude-code" },
            machine,
            first,
          ),
        );
        const initial = await stat(f.configDir);
        expect(f.observations[0]?.niceness).toBe(
          Math.min(19, parentNiceness + (agentNice ?? 10)),
        );
        expect(f.observations[0]?.childNiceness).toBe(
          f.observations[0]?.niceness,
        );
        expect(getPriority()).toBe(parentNiceness);
        expect(initial.mode & 0o7777).toBe(0o700);
        expect(initial.uid).toBe(process.getuid?.());
        for (const name of [".claude.json", "settings.json"]) {
          const file = await stat(join(f.configDir, name));
          expect(file.mode & 0o777).toBe(0o600);
          expect(file.uid).toBe(process.getuid?.());
        }
        if (mode === "agent-ssh")
          expect((await stat(f.runDir)).mode & 0o7777).toBe(0o2770);
        const next = await f.prepare("R-2");
        const settings = {
          theme: "light",
          skipDangerousModePermissionPrompt: true,
          autoMemoryEnabled: true,
          custom: "preserved",
        };
        await writeFile(
          join(f.configDir, "settings.json"),
          JSON.stringify(settings),
        );
        expect(next.command).toBe(first.command);
        const replaced = value(
          await f.runtime.resume_or_replace(firstRef, next),
        );
        expect(replaced.terminal_ref).not.toBe(firstRef.terminal_ref);
        expect(f.observations).toMatchObject([
          {
            directory: f.configDir,
            visits: 1,
            initial: {
              hasCompletedOnboarding: true,
              lastOnboardingVersion: "2.1.318",
              projects: { [f.runDir]: { hasTrustDialogAccepted: true } },
            },
            settings: {
              theme: "dark",
              skipDangerousModePermissionPrompt: true,
              autoMemoryEnabled: false,
            },
            prompt: "run=R-1\n",
          },
          {
            directory: f.configDir,
            visits: 2,
            // C-823: the state Claude saved ('{}') gets trust back on resume.
            initial: {
              hasCompletedOnboarding: true,
              lastOnboardingVersion: "2.1.318",
              projects: { [f.runDir]: { hasTrustDialogAccepted: true } },
            },
            settings,
            prompt: "run=R-2\n",
          },
        ]);
        expect((await stat(f.configDir)).ino).toBe(initial.ino);
        expect((await stat(f.configDir)).mode & 0o7777).toBe(0o700);
        expect(await readFile(join(f.configDir, ".claude.json"), "utf8")).toBe(
          "{}",
        );
        await expect(stat(join(f.home, ".claude"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(stat(join(f.home, ".claude.json"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(f.launches[1]).not.toContain("--keep"); // C-667
        if (mode === "agent-ssh")
          for (const args of f.launches)
            expect(args.slice(1, 3)).toEqual(["--on", "cardigan-agent"]);
      },
    );

    test.each(["local", "agent-ssh"] as const)(
      "%s trusts a new worktree cwd in saved state that trusted the run directory (C-823)",
      async (mode) => {
        const f = await fixture(mode);
        const firstRef = value(
          await f.runtime.provision(
            assignment,
            { ...role, harness: "claude-code" },
            machine,
            await f.prepare("R-1"),
          ),
        );
        // State as an earlier Run left it: trust for the old cwd only.
        const saved = {
          hasCompletedOnboarding: true,
          lastOnboardingVersion: "2.1.300",
          userID: "kept",
          projects: {
            [f.runDir]: { hasTrustDialogAccepted: true, allowedTools: ["x"] },
          },
        };
        await writeFile(
          join(f.configDir, ".claude.json"),
          JSON.stringify(saved),
          { mode: 0o600 },
        );
        // The worktree is reached through a symlinked parent: both forms.
        const real = join(root, "real-worktrees");
        await mkdir(join(real, "A-1"), { recursive: true });
        await symlink(real, join(root, "worktrees"), "dir");
        const worktree = join(root, "worktrees", "A-1");
        value(
          await f.runtime.resume_or_replace(
            firstRef,
            await f.prepare("R-2", worktree),
          ),
        );
        expect(f.observations[1]?.initial).toEqual({
          ...saved,
          projects: {
            ...saved.projects,
            [worktree]: { hasTrustDialogAccepted: true },
            [join(real, "A-1")]: { hasTrustDialogAccepted: true },
          },
        });
        const file = await stat(join(f.configDir, ".claude.json"));
        expect(file.mode & 0o777).toBe(0o600);
      },
    );

    test.each(["symlink", "invalid"] as const)(
      "refuses a %s Claude state file instead of launching untrusted",
      async (kind) => {
        const f = await fixture("local"),
          launch = await f.prepare("R-1");
        await mkdir(f.configDir, { mode: 0o700 });
        const target = join(root, "target.json");
        await writeFile(target, "untouched");
        if (kind === "symlink")
          await symlink(target, join(f.configDir, ".claude.json"));
        else await writeFile(join(f.configDir, ".claude.json"), "{not json");
        expect(
          await f.runtime.provision(
            assignment,
            { ...role, harness: "claude-code" },
            machine,
            launch,
          ),
        ).toMatchObject({ ok: false });
        expect(f.observations).toEqual([]);
        expect(await readFile(target, "utf8")).toBe("untouched");
      },
    );

    test.each(["symlink", "file"])(
      "refuses an existing %s at the private directory without touching its target",
      async (kind) => {
        const f = await fixture("local"),
          launch = await f.prepare("R-1");
        if (kind === "symlink") await symlink(f.home, f.configDir, "dir");
        else await writeFile(f.configDir, "untouched");
        expect(
          await f.runtime.provision(
            assignment,
            { ...role, harness: "claude-code" },
            machine,
            launch,
          ),
        ).toMatchObject({ ok: false });
        expect(f.observations).toEqual([]);
        expect((await stat(f.home)).mode & 0o777).toBe(0o500);
        if (kind === "file")
          expect(await readFile(f.configDir, "utf8")).toBe("untouched");
      },
    );
  },
);
