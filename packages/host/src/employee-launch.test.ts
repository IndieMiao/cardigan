import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  type Assignment,
  type Employee,
  queueRun,
  type Role,
  type Runtime,
} from "@cardigan/domain";
import {
  corePromptFor,
  instructionsFor,
  parseLaunchConfig,
  RUN_RESOURCE_RULE,
} from "@cardigan/roles";
import { Store, writeRole } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { applyCommand } from "./commands.js";
import { launchRun } from "./launch.js";

test.each(
  (["claude-code", "codex", "pi"] as const).flatMap((harness) =>
    [false, true].map((modern) => ({ harness, modern })),
  ),
)(
  "host launch injects the stored employee through $harness (instructions=$modern), including dispatcher first prompts",
  async ({ harness, modern }) => {
    const dataDir = await mkdtemp(join(tmpdir(), "cg-employee-launch-"));
    const configDir = join(dataDir, "config");
    await mkdir(configDir, { mode: 0o700 });
    const probe = join(dataDir, "vitest.mjs");
    await writeFile(
      probe,
      "console.log(JSON.stringify(process.argv.slice(2)))\n",
    );
    const store = Store.open({ dataDir });
    const project = "employee-launch";
    const clock = { now: () => "2026-01-01T00:00:00.000Z" };
    const role: Role = {
      role_id: "pm",
      version: 1,
      display_name: "PM",
      kind: "standing",
      harness,
      core_prompt: modern
        ? "Ignored legacy field"
        : corePromptFor("pm", "旧显示名"),
      ...(modern ? { instructions: instructionsFor("pm", "旧显示名") } : {}),
      launch_profile_ref: "fixture",
      allowed_tools: ["whoami", "get_updates", "finish_run"],
      capabilities: [],
      abilities: [],
      worktree: "none",
      required_machine_tags: [],
    };
    const employee: Employee = {
      id: "E-1",
      name: "诸葛亮 Mary",
      title: "项目经理",
      bio: "负责协作。",
      avatar: null,
      role_id: "pm",
      launch_profile_ref: null,
      status: "inactive",
      created_at: clock.now(),
      updated_at: clock.now(),
    };
    // Persisted inactive employees still own their existing Assignment.
    const runtime = {
      provision: vi.fn(async () => ({
        ok: true,
        value: {
          machine_id: "local",
          runtime_machine: "local",
          terminal_ref: "fixture",
          agent_name: "fixture",
        },
      })),
      release: vi.fn(async () => ({ ok: true, value: undefined })),
    } as unknown as Runtime;
    try {
      store.createProject({ id: project, name: "Launch" });
      store.uow.run((tx) => {
        writeRole(tx, project, role, { mode: "add" });
        tx.employees.put(employee);
      });
      for (const named of [false, true]) {
        if (named)
          await writeFile(
            join(configDir, "agent-tests.yaml"),
            "max_workers: 1\n",
            { mode: 0o600 },
          );
        const assignment: Assignment = {
          id: named ? "A-2" : "A-1",
          scope: "standing",
          standing_mode: "ops",
          role_id: "pm",
          role_version: 1,
          status: "active",
          runtime_state: "not_provisioned",
          runtime_ref: null,
          machine_id: "local",
          mcp_token_id: named ? "named" : "anonymous",
          created_at: clock.now(),
          ...(named ? { employee_id: employee.id } : {}),
        };
        store.uow.run((tx) => tx.assignments.put(project, assignment));
        const actor = { kind: "human" as const, project_id: project };
        const run = applyCommand(store, {
          project,
          actor,
          clock,
          reduce: (state, who, ports) =>
            queueRun(
              state,
              who,
              {
                assignment_id: assignment.id,
                model: "fixture",
                agent_cli_version: "fixture",
              },
              ports,
            ),
        });
        const bell = "[bell] asg=A-2 run=R-2 seq=7 kind=followup";
        const launched = await launchRun(
          {
            store,
            runtime,
            dataDir,
            configDir,
            execution: {
              mode: "local",
              dataDir,
              ...(named ? { agentNice: 17 } : {}),
            },
            clock,
            mcpUrl: "http://localhost/mcp",
            launch: {
              config: parseLaunchConfig({
                profiles: { fixture: { harness, model: "fixture" } },
              }),
              secrets: {},
            },
          },
          {
            project,
            assignment_id: assignment.id,
            actor,
            run,
            ...(named ? { first_prompt: bell } : {}),
          },
        );
        const core = await readFile(join(launched.run_dir, "core.md"), "utf8");
        expect(vi.mocked(runtime.provision).mock.calls.at(-1)?.[2]).toEqual(
          store.uow.read((tx) =>
            tx.machines.get(project, assignment.machine_id),
          ),
        );
        const script = await readFile(
          join(launched.run_dir, "launch.sh"),
          "utf8",
        );
        // C-656: host launches start the CLI through the session wrapper.
        expect(script).toContain(
          `exec /usr/bin/python3 -IB -c "$CARDIGAN_RUN_COMMAND" session -- nice -n ${named ? 17 : 10} `,
        );
        expect(script).toContain("export NODE_OPTIONS=");
        expect(script).toContain("export CARDIGAN_AGENT_LOCAL_TESTS='1'");
        if (harness === "pi") {
          expect(
            await readFile(
              join(
                launched.run_dir,
                "pi",
                "extensions",
                "cardigan-context-usage.js",
              ),
              "utf8",
            ),
          ).toContain('pi.on("turn_end"');
        }
        const guarded = await promisify(execFile)(
          process.execPath,
          [
            "--require",
            join(launched.run_dir, "test-workers.cjs"),
            probe,
            "run",
            "--maxWorkers=9",
          ],
          { env: { ...process.env, NODE_OPTIONS: "" } },
        );
        // The enclosing employee Run may impose a lower limit than this
        // fixture's launch policy; the child must preserve that lower limit.
        const inheritedWorkers = Number(process.env.VITEST_MAX_WORKERS);
        const expectedWorkers =
          Number.isSafeInteger(inheritedWorkers) && inheritedWorkers > 0
            ? Math.min(named ? 1 : 4, inheritedWorkers)
            : named
              ? 1
              : 4;
        expect(JSON.parse(guarded.stdout)).toEqual([
          "run",
          `--maxWorkers=${expectedWorkers}`,
        ]);
        const first = await readFile(
          join(launched.run_dir, "first.md"),
          "utf8",
        );
        if (named) {
          for (const text of [core, first]) {
            expect(text).toContain('你是 "诸葛亮 Mary"，职位 "项目经理"');
            expect(text).toContain('简介："负责协作。"');
          }
          expect(core).not.toContain("旧显示名");
          expect(first).toContain(bell);
        } else {
          expect(core).toBe(
            `${corePromptFor("pm", "旧显示名")}\n\n${RUN_RESOURCE_RULE}\n`,
          );
          expect(first).not.toContain(employee.name);
          expect(first).toContain("kind=initial");
        }
        expect(core).toContain(
          'python3 -IB -c "$CARDIGAN_RUN_COMMAND" R-n --private --',
        );
        expect(core).toContain("--private-vite-on-demand 已分配端口");
        expect(core).toContain("临时文件写入该命令的 $TMPDIR");
        expect(first).toContain("PM Ops");
        expect(launched.run.status).toBe("dispatched");
      }
      expect(runtime.provision).toHaveBeenCalledTimes(2);
    } finally {
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);
