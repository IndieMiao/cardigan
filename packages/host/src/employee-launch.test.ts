import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Assignment,
  type Employee,
  queueRun,
  type Role,
  type Runtime,
} from "@cardigan/domain";
import { corePromptFor, parseLaunchConfig } from "@cardigan/roles";
import { Store, writeRole } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { applyCommand } from "./commands.js";
import { launchRun } from "./launch.js";

test.each(["claude-code", "codex", "pi"] as const)(
  "host launch injects the stored employee through %s, including dispatcher first prompts",
  async (harness) => {
    const dataDir = await mkdtemp(join(tmpdir(), "cg-employee-launch-"));
    const store = Store.open({ dataDir });
    const project = "employee-launch";
    const clock = { now: () => "2026-01-01T00:00:00.000Z" };
    const role: Role = {
      role_id: "pm",
      version: 1,
      display_name: "PM",
      kind: "standing",
      harness,
      core_prompt: corePromptFor("pm", "旧显示名"),
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
          expect(core).toBe(role.core_prompt);
          expect(first).not.toContain(employee.name);
          expect(first).toContain("kind=initial");
        }
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
