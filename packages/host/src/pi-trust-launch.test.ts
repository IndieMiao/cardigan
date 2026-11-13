import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Assignment,
  queueRun,
  type Role,
  type Runtime,
} from "@cardigan/domain";
import { parseLaunchConfig } from "@cardigan/roles";
import { Store, writeRole } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { applyCommand } from "./commands.js";
import { launchRun } from "./launch.js";

/**
 * C-235: the real host start flow writes pi's trust.json keyed by the path
 * pi will look up (realpath of its cwd), and never pre-trusts a worktree
 * whose leaf is a symlink.
 */
test.each([
  { name: "symlinked ancestor", leafLink: false },
  { name: "symlinked leaf", leafLink: true },
])("C-235 host launch pre-trusts pi worktree: $name", async ({ leafLink }) => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "cg-pi-trust-")));
  const dataDir = join(root, "data");
  await mkdir(dataDir, { mode: 0o700 });
  // <root>/srv -> <root>/disk: the configured worktree path crosses a link.
  const disk = join(root, "disk", "worktrees");
  await mkdir(disk, { recursive: true });
  await symlink(join(root, "disk"), join(root, "srv"));
  if (leafLink) await symlink(disk, join(disk, "A-1"));
  else await mkdir(join(disk, "A-1"));
  const configured = join(root, "srv", "worktrees", "A-1");

  const store = Store.open({ dataDir });
  const project = "pi-trust";
  const clock = { now: () => "2026-01-01T00:00:00.000Z" };
  const role: Role = {
    role_id: "pm",
    version: 1,
    display_name: "PM",
    kind: "standing",
    harness: "pi",
    core_prompt: "Fixture",
    launch_profile_ref: "fixture",
    allowed_tools: ["whoami", "finish_run"],
    capabilities: [],
    abilities: [],
    worktree: "write",
    required_machine_tags: [],
  };
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
    store.createProject({ id: project, name: "Pi trust" });
    const assignment: Assignment = {
      id: "A-1",
      scope: "standing",
      standing_mode: "ops",
      role_id: "pm",
      role_version: 1,
      status: "active",
      runtime_state: "not_provisioned",
      runtime_ref: null,
      machine_id: "local",
      mcp_token_id: "fixture",
      created_at: clock.now(),
    };
    store.uow.run((tx) => {
      writeRole(tx, project, role, { mode: "add" });
      tx.assignments.put(project, assignment);
    });
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
    const launched = await launchRun(
      {
        store,
        runtime,
        dataDir,
        execution: { mode: "local", dataDir },
        clock,
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
        actor,
        run,
        worktree: {
          path: configured,
          base_sha: "a".repeat(40),
          branch: "agent/A-1",
        },
      },
    );
    expect(launched.run.status).toBe("dispatched");
    const trust = join(launched.run_dir, "pi", "trust.json");
    if (leafLink) {
      await expect(readFile(trust, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } else {
      const saved = JSON.parse(await readFile(trust, "utf8"));
      // Exactly one key: the canonical worktree pi looks up, not the link.
      expect(saved).toEqual({ [realpathSync(configured)]: true });
      expect(realpathSync(configured)).toBe(join(disk, "A-1"));
    }
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
