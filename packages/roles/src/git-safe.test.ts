import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import {
  compileAssignmentLaunch,
  corePromptFor,
  parseLaunchConfig,
} from "./index.js";

test("S8 coder tells requested_verifiers to select only the current work item's targets", () => {
  const prompt = corePromptFor("coder");
  expect(prompt).toContain("target_work_item_id");
  expect(prompt).toContain("等于本工作项");
  expect(prompt).toContain("PM 验收");
  expect(prompt).toContain("不填");
  expect(prompt).not.toContain("`requested_verifiers` 写全所有必需验证项");
});

test.each(
  (["claude-code", "codex", "pi"] as const).flatMap((harness) =>
    [false, true].map((inherited) => ({ harness, inherited })),
  ),
)(
  "S9 $harness trusts only the Assignment Git paths (inherited wildcard=$inherited)",
  ({ harness, inherited }) => {
    const root = mkdtempSync(join(tmpdir(), "cardigan-safe-git-"));
    try {
      const repo = join(root, "repos", "project 'quoted"),
        work = join(root, "worktrees", "project 'quoted", "A-1"),
        other = join(root, "unrelated"),
        run = join(root, "runs", "A-1"),
        bin = join(root, "bin");
      const git = (...args: string[]) =>
        execFileSync("git", args, {
          stdio: ["ignore", "pipe", "pipe"],
          encoding: "utf8",
        }).trim();
      mkdirSync(dirname(repo), { recursive: true });
      git("init", "-qb", "main", repo);
      writeFileSync(join(repo, "file"), "fixture");
      git("-C", repo, "add", ".");
      git(
        "-C",
        repo,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-qm",
        "initial",
      );
      git("-C", repo, "worktree", "add", "-b", "agent/a1", work);
      git("init", "-q", other);
      const global = join(root, "gitconfig");
      writeFileSync(global, "[safe]\n\tdirectory = *\n");
      const env = {
        ...process.env,
        GIT_TEST_ASSUME_DIFFERENT_OWNER: "1",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: inherited ? global : "/dev/null",
        GIT_CONFIG_COUNT: inherited ? "1" : "0",
        GIT_CONFIG_KEY_0: "safe.directory",
        GIT_CONFIG_VALUE_0: "*",
        GIT_CONFIG_PARAMETERS: inherited ? "'safe.directory=*'" : "",
        PATH: `${bin}:${process.env.PATH}`,
      };
      const denied = spawnSync("git", ["-C", work, "status", "--porcelain"], {
        encoding: "utf8",
        env: {
          ...env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_COUNT: "0",
          GIT_CONFIG_PARAMETERS: "",
        },
      });
      expect(denied.status).not.toBe(0);
      expect(denied.stderr).toContain("dubious ownership");
      const compiled = compileAssignmentLaunch({
        assignment: { assignment_id: "A-1", run_id: "R-1" },
        role: {
          role_id: "coder",
          harness,
          launch_profile: "fixture",
          core_prompt: "Fixture",
          allowed_tools: [],
          worktree: "write",
        },
        launch: parseLaunchConfig({ profiles: { fixture: { harness } } }),
        mcp: { url: "http://localhost/mcp" },
        run_dir: run,
        work_dir: work,
        repository_root: repo,
        first_prompt: "hello",
        secrets: {},
      });
      for (const file of compiled.files) {
        mkdirSync(dirname(file.path), { recursive: true });
        writeFileSync(file.path, file.content, { mode: file.mode });
      }
      writeFileSync(compiled.token_file, "fixture-token");
      writeFileSync(join(run, "start"), "");
      mkdirSync(bin);
      writeFileSync(
        join(bin, compiled.command),
        `#!${process.execPath}
const {spawnSync}=require('node:child_process');
const paths=${JSON.stringify([work, repo, other])};
const results=paths.map(path=>{const r=spawnSync('git',['-C',path,'status','--porcelain'],{encoding:'utf8'});return {status:r.status,stderr:r.stderr};});
console.log(JSON.stringify({results,config:spawnSync('git',['config','--get-all','safe.directory'],{encoding:'utf8'}).stdout,parameters:process.env.GIT_CONFIG_PARAMETERS??null}));
`,
        { mode: 0o700 },
      );
      chmodSync(compiled.launch_script, 0o700);
      const observed = JSON.parse(
        execFileSync(compiled.launch_script, {
          env,
          cwd: work,
          encoding: "utf8",
        }),
      );
      expect(observed.results.map((r: { status: number }) => r.status)).toEqual(
        [0, 0, 128],
      );
      expect(observed.results[2].stderr).toContain("dubious ownership");
      expect(observed.config.split("\n").slice(-4)).toEqual([
        "",
        work,
        repo,
        "",
      ]);
      expect(observed.parameters).toBeNull();
      expect(readFileSync(global, "utf8")).toBe("[safe]\n\tdirectory = *\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("S9 a role without a worktree grants no Git ownership exceptions", () => {
  const compiled = compileAssignmentLaunch({
    assignment: { assignment_id: "A-1", run_id: "R-1" },
    role: {
      role_id: "pm",
      harness: "claude-code",
      launch_profile: "fixture",
      core_prompt: "Fixture",
      allowed_tools: [],
      worktree: "none",
    },
    launch: parseLaunchConfig({
      profiles: { fixture: { harness: "claude-code" } },
    }),
    mcp: { url: "http://localhost/mcp" },
    run_dir: "/fixture/runs/A-1",
    work_dir: "/fixture/runs/A-1",
    repository_root: "/fixture/repos/project",
    first_prompt: "hello",
    secrets: {},
  });
  expect(compiled.env.GIT_CONFIG_COUNT).toBe("1");
  expect(compiled.env.GIT_CONFIG_KEY_0).toBe("safe.directory");
  expect(compiled.env.GIT_CONFIG_VALUE_0).toBe("");
  expect(compiled.env.GIT_CONFIG_VALUE_1).toBeUndefined();
});

test("P2a-3 a readonly verifier's build checkout is trusted next to its worktree", () => {
  for (const harness of ["claude-code", "codex"] as const) {
    const compiled = compileAssignmentLaunch({
      assignment: { assignment_id: "A-2", run_id: "R-2" },
      role: {
        role_id: "reviewer",
        harness,
        launch_profile: "fixture",
        core_prompt: "Fixture",
        allowed_tools: [],
        worktree: "readonly",
      },
      launch: parseLaunchConfig({
        profiles: { fixture: { harness } },
      }),
      mcp: { url: "http://localhost/mcp" },
      run_dir: "/fixture/runs/A-2",
      work_dir: "/fixture/worktrees/project/A-2",
      repository_root: "/fixture/repos/project",
      build_dir: "/fixture/builds/project/A-2",
      first_prompt: "hello",
      secrets: {},
    });
    expect(compiled.env.GIT_CONFIG_COUNT).toBe("4");
    expect(compiled.env.GIT_CONFIG_VALUE_3).toBe("/fixture/builds/project/A-2");
    if (harness === "codex")
      expect(
        compiled.files.find((file) => file.path.endsWith("config.toml"))
          ?.content,
      ).toContain('[projects."/fixture/builds/project/A-2"]');
  }
});
