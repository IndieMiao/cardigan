/** M2.T2: expectations from M2.2/M2.4 and §6.3/§10/§14; public APIs only. */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import {
  assign,
  createCard,
  queueRun,
  type Role,
  saveMachine,
} from "@cardigan/domain";
import {
  compileAssignmentLaunch,
  corePromptFor,
  firstPrompt,
  type Harness,
  parseLaunchConfig,
  START_FILE_NAME,
} from "@cardigan/roles";
import {
  getRoleVersion,
  listRoleVersions,
  Store,
  writeRole,
} from "@cardigan/store";
import { afterEach, beforeEach, expect, test } from "vitest";
import { humanActor, runCommand } from "./index.js";
import { registerTemplateRoles } from "./template-fixtures.js";

const exec = promisify(execFile);
const project = "p-acceptance" as never;
let root: string, store: Store;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cg-m2-roles-"));
  store = Store.open({ dataDir: join(root, "data") });
  store.createProject({ id: project, name: "Acceptance" });
});
afterEach(async () => {
  store.close();
  await rm(root, { recursive: true, force: true });
});
const role = (): Role => ({
  role_id: "coder",
  version: 1,
  display_name: "Coder",
  kind: "work",
  core_prompt: "Version one instructions",
  harness: "codex",
  launch_profile_ref: "fixture",
  allowed_tools: ["whoami", "get_card", "submit_delivery"],
  capabilities: ["code"],
  abilities: ["vision"],
  worktree: "write",
  required_machine_tags: ["fixture-toolchain"],
});
const add = () =>
  store.uow.run((tx) => writeRole(tx, project, role(), { mode: "add" }).role);
const update = () =>
  store.uow.run(
    (tx) =>
      writeRole(
        tx,
        project,
        {
          ...role(),
          core_prompt: "Version two instructions",
          launch_profile_ref: "fixture-v2",
        },
        { mode: "update" },
      ).role,
  );

test("L01 role edits append a version and preserve the complete old definition", () => {
  const first = add(),
    second = update();
  expect(first.version).toBe(1);
  expect(second.version).toBe(2);
  store.uow.run((tx) => {
    expect(getRoleVersion(tx, project, "coder", 1)).toEqual(first);
    expect(getRoleVersion(tx, project, "coder")).toEqual(second);
    expect(listRoleVersions(tx, project)).toEqual([first, second]);
  });
});
test("L02 an explicit old role version cannot overwrite history", () => {
  const first = add();
  expect(() =>
    store.uow.run((tx) =>
      writeRole(
        tx,
        project,
        { ...role(), core_prompt: "overwrite" },
        { mode: "update", version: 1 },
      ),
    ),
  ).toThrow();
  expect(
    store.uow.run((tx) => getRoleVersion(tx, project, "coder", 1)),
  ).toEqual(first);
});
test("L03 invariant 12: a queued Run keeps its Assignment's role version after a registry update", () => {
  const original = add();
  registerTemplateRoles(store, project);
  const actor = humanActor(project);
  const card = runCommand(store, {
    project_id: project,
    actor,
    reduce: (s, a, p) =>
      createCard(
        s,
        a,
        {
          title: "Pinned role",
          goal: "Reproducible",
          acceptance_criteria: ["fixed role"],
          source: { kind: "quote", text: "fixture" },
          repo: "fixture/repo",
          base_branch: "main",
        },
        p,
      ),
  });
  const item = store.uow.read((tx) =>
    tx.work_items
      .list(project)
      .find((w) => w.card_id === card.id && w.kind === "produce"),
  );
  if (!item) throw new Error("Missing template produce item");
  const assignItem = () =>
    runCommand(store, {
      project_id: project,
      actor,
      reduce: (s, a, p) =>
        assign(s, a, { work_item_id: item.id, role_id: "coder" }, p),
    });
  expect(assignItem).toThrow("tag=fixture-toolchain");
  runCommand(store, {
    project_id: project,
    actor,
    reduce: (state, who, ports) => {
      const local = state.machines?.find((machine) => machine.id === "local");
      if (!local) throw new Error("Missing registered local fixture");
      return saveMachine(
        state,
        who,
        {
          operation: "update",
          machine: { ...local, tags: ["fixture-toolchain"] },
        },
        ports,
      );
    },
  });
  const assignment = assignItem();
  update();
  const run = runCommand(store, {
    project_id: project,
    actor,
    reduce: (s, a, p) =>
      queueRun(
        s,
        a,
        {
          assignment_id: assignment.id,
          model: "fixture-model",
          agent_cli_version: "fixture-cli-1",
        },
        p,
      ),
  });
  expect(run).toMatchObject({
    role_version: 1,
    model: "fixture-model",
    agent_cli_version: "fixture-cli-1",
  });
  expect(
    store.uow.run((tx) =>
      getRoleVersion(tx, project, "coder", run.role_version),
    ),
  ).toEqual(original);
});
test("L04 reopening and repeating migrations preserve full role history and project Git configuration", () => {
  const first = add(),
    second = update();
  const repo = join(root, "registered-source");
  expect(
    store.setProjectRepo({
      project_id: project,
      repo_path: repo,
      base_branch: "integration",
    }).ok,
  ).toBe(true);
  const version = store.schemaVersion();
  expect(version).toBeGreaterThanOrEqual(3);
  store.close();
  store = Store.open({ dataDir: join(root, "data") });
  expect(store.migrate()).toEqual([]);
  expect(store.migrate()).toEqual([]);
  expect(store.schemaVersion()).toBe(version);
  expect(store.uow.run((tx) => listRoleVersions(tx, project))).toEqual([
    first,
    second,
  ]);
  expect(store.getProject(project)).toMatchObject({
    repo_path: repo,
    base_branch: "integration",
  });
});

const harnesses = ["claude-code", "codex", "pi"] as const;
const secret = "fictional-provider-key-DO-NOT-PERSIST";
const token = "fictional-mcp-token-ONE-RUN";
function compile(harness: Harness) {
  return compileAssignmentLaunch({
    assignment: {
      assignment_id: "A-1",
      run_id: "R-1",
      card_id: "C-1",
      work_item_id: "W-1",
      project_id: project,
    },
    role: {
      role_id: "coder",
      harness,
      launch_profile: "fixture",
      core_prompt: corePromptFor("coder"),
      allowed_tools: ["whoami", "get_card", "submit_delivery"],
      worktree: "write",
    },
    launch: parseLaunchConfig({
      providers: {
        fixture: { harness, secret_env: { FIXTURE_API_KEY: "key" } },
      },
      profiles: {
        fixture: { harness, provider: "fixture", model: "fixture-model" },
      },
    }),
    mcp: { url: "http://127.0.0.1:3004/mcp" },
    run_dir: join(root, "run"),
    work_dir: join(root, "worktree"),
    first_prompt: firstPrompt({
      assignment_id: "A-1",
      run_id: "R-1",
      card_id: "C-1",
      work_item_id: "W-1",
    }),
    secrets: { key: secret },
  });
}
test.each(harnesses)(
  "L05 %s launch wiring matches the plan's harness contract",
  (harness) => {
    const output = compile(harness);
    const file = (name: string) => {
      const match = output.files.find(
        (f) => relative(join(root, "run"), f.path) === name,
      );
      if (!match) throw new Error(`Missing ${name}`);
      return match.content;
    };
    expect(file("core.md")).toBe(`${corePromptFor("coder").trimEnd()}\n`);
    expect(file("first.md")).toContain("asg=A-1 run=R-1");
    if (harness === "claude-code") {
      expect(output.args).toEqual(
        expect.arrayContaining([
          "--strict-mcp-config",
          "--mcp-config",
          join(root, "run", "mcp.json"),
          "--append-system-prompt-file",
          join(root, "run", "core.md"),
          "--allowedTools",
          "mcp__card__whoami,mcp__card__get_card,mcp__card__submit_delivery",
        ]),
      );
      expect({
        mcp: JSON.parse(file("mcp.json")),
        autoUpdate: output.env.DISABLE_AUTOUPDATER,
      }).toMatchInlineSnapshot(`
      {
        "autoUpdate": "1",
        "mcp": {
          "mcpServers": {
            "card": {
              "headers": {
                "Authorization": "Bearer \${MCP_TOKEN}",
              },
              "type": "http",
              "url": "http://127.0.0.1:3004/mcp",
            },
          },
        },
      }
    `);
    } else if (harness === "codex") {
      expect(output.env.CODEX_HOME).toBe(join(root, "run", "codex"));
      const config = file("codex/config.toml").replaceAll(
        join(root, "run"),
        "<run>",
      );
      expect(config).toContain('model_instructions_file = "<run>/core.md"');
      expect(config).toContain('bearer_token_env_var = "MCP_TOKEN"');
      for (const tool of ["whoami", "get_card"])
        expect(config).toContain(
          `[mcp_servers.card.tools.${tool}]\napproval_mode = "approve"`,
        );
      expect(
        config.match(
          /\[mcp_servers.card\][\s\S]*?(?=\n\[mcp_servers.card.tools)/u,
        )?.[0],
      ).toMatchInlineSnapshot(`
      "[mcp_servers.card]
      url = "http://127.0.0.1:3004/mcp"
      bearer_token_env_var = "MCP_TOKEN"
      "
    `);
    } else {
      expect(output.env.PI_CODING_AGENT_DIR).toBe(join(root, "run", "pi"));
      expect(output.args).toEqual(
        expect.arrayContaining([
          "--append-system-prompt",
          join(root, "run", "core.md"),
        ]),
      );
      expect(output.args).not.toContain("--no-extensions");
      expect(JSON.parse(file("pi/mcp.json"))).toMatchInlineSnapshot(`
        {
          "mcpServers": {
            "card": {
              "exposure": "direct",
              "headers": {
                "Authorization": "Bearer \${MCP_TOKEN}",
              },
              "url": "http://127.0.0.1:3004/mcp",
            },
          },
        }
      `);
    }
  },
);
test.each(["pm", "coder", "reviewer", "designer", "tester"] as const)(
  "L06 %s includes every §6.3 rule independently of exported protocol constants",
  (name) => {
    const prompt = corePromptFor(name);
    for (const rule of [
      /开始.*get_updates.*结束前.*一次/u,
      /读完.*ack_events/u,
      /产出.*submit_delivery.*submit_review/u,
      /request_decision.*finish_run\(outcome=blocked\)/u,
      /Run.*结束.*finish_run/u,
      /空闲.*没有.*门铃.*低频.*get_updates/u,
    ])
      expect(prompt).toMatch(rule);
  },
);
test.each(harnesses)(
  "L07 %s wrapper consumes both credentials before exec and leaves no plaintext in persistent files",
  async (harness) => {
    const output = compile(harness);
    for (const file of output.files) {
      expect(file.content).not.toContain(token);
      if (!file.path.endsWith("/secrets.env"))
        expect(file.content).not.toContain(secret);
      await mkdir(dirname(file.path), { recursive: true, mode: 0o700 });
      await writeFile(file.path, file.content, { mode: file.mode });
    }
    expect(
      JSON.stringify({ args: output.args, env: output.env }),
    ).not.toContain(secret);
    await writeFile(output.token_file, token, { mode: 0o600 });
    // The wrapper waits for the dispatch sentinel (see START_FILE_NAME).
    await writeFile(join(root, "run", START_FILE_NAME), "", { mode: 0o600 });
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(
      join(bin, output.command),
      `#!/usr/bin/env node\nconst fs = require('node:fs');\nconsole.log(JSON.stringify({token:process.env.MCP_TOKEN,key:process.env.FIXTURE_API_KEY,tokenExists:fs.existsSync(${JSON.stringify(output.token_file)}),secretsExist:fs.existsSync(${JSON.stringify(join(root, "run", "secrets.env"))})}));\n`,
      { mode: 0o700 },
    );
    const result = await exec(output.launch_script, [], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    expect(JSON.parse(result.stdout)).toEqual({
      token,
      key: secret,
      tokenExists: false,
      secretsExist: false,
    });
    expect(result.stderr).toBe("");
    for (const file of output.files)
      if (existsSync(file.path)) {
        const remaining = await readFile(file.path, "utf8");
        expect(remaining).not.toContain(token);
        expect(remaining).not.toContain(secret);
      }
  },
);
