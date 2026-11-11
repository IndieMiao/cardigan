import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Assignment,
  assign,
  createCard,
  createRole,
  queueRun,
  type Role,
  type Runtime,
  toolNames,
  updateRole,
} from "@cardigan/domain";
import { corePromptFor, parseLaunchConfig } from "@cardigan/roles";
import {
  defaultMigrationsDir,
  getRoleVersion,
  listMigrations,
  listRoleVersions,
  roleDocument,
  Store,
} from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { applyCommand, launchEntities } from "./commands.js";
import { launchRun } from "./launch.js";

test.each(["codex", "claude-code", "pi"] as const)(
  "legacy database roles remain readable, assignable and launchable through %s without write-policy revalidation",
  async (harness) => {
    const root = await mkdtemp(join(tmpdir(), "cg-legacy-roles-"));
    const dataDir = join(root, "data"),
      oldMigrations = join(root, "old-migrations");
    await mkdir(oldMigrations);
    for (const migration of listMigrations(defaultMigrationsDir).filter(
      (item) => item.version <= 3,
    )) {
      await writeFile(
        join(
          oldMigrations,
          `${String(migration.version).padStart(4, "0")}_${migration.name}.sql`,
        ),
        migration.sql,
      );
    }
    const project = "legacy-roles",
      actor = { kind: "human", project_id: project } as const;
    const clock = { now: () => "2026-01-01T00:00:00.000Z" };
    const roles: Role[] = (["coder", "reviewer", "pm"] as const).map(
      (role_id) => ({
        role_id,
        version: 2,
        display_name: role_id,
        kind: "work",
        harness,
        core_prompt: corePromptFor(role_id),
        launch_profile_ref: "fixture",
        // Historical documents can contain both work-item actions and record_decision.
        // They must remain usable even though a new write would reject this scope.
        allowed_tools: [...toolNames],
        capabilities: [],
        abilities: [],
        worktree: role_id === "coder" ? "write" : "readonly",
        required_machine_tags: [],
      }),
    );
    let store = Store.open({ dataDir, migrationsDir: oldMigrations });
    const runtime = {
      provision: vi.fn(async (assignment: Assignment) => ({
        ok: true,
        value: {
          machine_id: "local",
          runtime_machine: "local",
          terminal_ref: assignment.id,
          agent_name: assignment.role_id,
        },
      })),
      release: vi.fn(async () => ({ ok: true, value: undefined })),
    } as unknown as Runtime;
    try {
      store.createProject({ id: project });
      for (const role of roles) {
        store.database
          .prepare(
            "INSERT INTO roles(project_id, role_id, role_version, doc) VALUES (?, ?, ?, ?)",
          )
          .run(
            project,
            role.role_id,
            role.version,
            JSON.stringify(roleDocument(role)),
          );
      }
      store.close();
      store = Store.open({ dataDir });
      expect(store.uow.read((tx) => listRoleVersions(tx, project))).toEqual(
        roles.slice().sort((a, b) => a.role_id.localeCompare(b.role_id)),
      );
      applyCommand(store, {
        project,
        actor,
        clock,
        reduce: (state, who, ports) =>
          createCard(
            state,
            who,
            {
              title: "Legacy roles",
              goal: "Preserve existing role documents",
              acceptance_criteria: ["Can launch"],
              source: { kind: "quote", text: "Legacy compatibility" },
              repo: "fixture/repo",
              base_branch: "main",
            },
            ports,
          ),
      });
      const items = store.uow.read((tx) => tx.work_items.list(project));
      for (const role of roles) {
        const loaded = store.uow.read((tx) =>
          getRoleVersion(tx, project, role.role_id),
        );
        expect(loaded).toEqual(role);
        const { version: _version, ...definition } = role;
        store.uow.run((tx) => {
          const state = {
            project_id: project,
            roles: listRoleVersions(tx, project),
          };
          const ports = { clock, ids: tx.ids };
          expect(
            createRole({ ...state, roles: [] }, actor, definition, ports).ok,
          ).toBe(false);
          expect(
            updateRole(
              state,
              actor,
              role.role_id,
              { display_name: "New version" },
              ports,
            ).ok,
          ).toBe(false);
        });
        const item = items.find((item) => item.role_id === role.role_id);
        if (!item) throw new Error("Missing default work item");
        const assignment = applyCommand(store, {
          project,
          actor,
          clock,
          reduce: (state, who, ports) =>
            assign(
              state,
              who,
              { work_item_id: item.id, role_id: role.role_id },
              ports,
            ),
        });
        expect(assignment.role_version).toBe(2);
        expect(launchEntities(store, project, assignment.id).role).toEqual(
          role,
        );
        const queue = () =>
          applyCommand(store, {
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
        if (item.kind === "verify") {
          // Legacy role compatibility does not bypass the current-target rule.
          expect(queue).toThrow("验证工作项尚无当前可审交付");
          store.uow.run((tx) => {
            const producer = tx.work_items
              .list(project)
              .find(
                (candidate) =>
                  candidate.card_id === item.card_id &&
                  candidate.kind === "produce" &&
                  (!item.target_work_item_id ||
                    candidate.id === item.target_work_item_id),
              );
            const producerRun = tx.runs
              .list(project)
              .find((run) => run.assignment_id === producer?.assignment_id);
            if (!producer || !producerRun)
              throw new Error("Missing producer launch fixture");
            // Seed the persisted target independently of role write validation:
            // code review needs code, while PM acceptance needs a completion.
            tx.deliveries.put(project, {
              id: tx.ids.next(project, "delivery"),
              work_item_id: producer.id,
              run_id: producerRun.id,
              kind: item.target_work_item_id ? "code" : "card_completion",
              summary: "Legacy role launch target",
              subject: { kind: "git_head", value: "a".repeat(40) },
              status: "submitted",
              requested_verifiers: [item.id],
              evidence: [],
              attachments: [],
              known_gaps: [],
            });
          });
        }
        const run = queue();
        const worktree = join(root, assignment.id);
        await mkdir(worktree);
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
            // Prepared fixture directories avoid real Git and hc; the host still
            // performs token issuance, prompt compilation and domain dispatch.
            worktree: {
              path: worktree,
              base_sha: "a".repeat(40),
              ...(role.worktree === "write"
                ? { branch: `agent/${assignment.id}` }
                : {}),
            },
          },
        );
        expect(launched.run).toMatchObject({
          role_version: 2,
          status: "dispatched",
        });
        expect(await readFile(join(launched.run_dir, "core.md"), "utf8")).toBe(
          role.core_prompt,
        );
        expect(
          store.database
            .prepare(
              "SELECT doc FROM roles WHERE project_id = ? AND role_id = ?",
            )
            .get(project, role.role_id)?.doc,
        ).toBe(JSON.stringify(roleDocument(role)));
      }
      expect(runtime.provision).toHaveBeenCalledTimes(3);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
