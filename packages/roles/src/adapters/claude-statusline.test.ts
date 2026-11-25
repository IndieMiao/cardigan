import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  type CompileAssignmentInput,
  compileAssignmentLaunch,
  parseLaunchConfig,
} from "../index.js";
import { relayHostname } from "./claude-statusline.js";

const SECRET = "sk-fixture-secret-0123456789";
const QUERY_SECRET = "query-secret-value";
const root = mkdtempSync(join(tmpdir(), "cardigan-statusline-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function compile(overrides: Partial<CompileAssignmentInput> = {}) {
  return compileAssignmentLaunch({
    assignment: {
      assignment_id: "A-7",
      run_id: "R-70",
      card_id: "C-9",
      work_item_id: "W-90",
    },
    employee: {
      launch_profile_ref: "fixture",
      identity: { name: "孙悟空", title: "开发工程师", bio: "" },
    },
    role: {
      role_id: "coder",
      harness: "claude-code",
      launch_profile: "fixture",
      core_prompt: "Fixed role",
      allowed_tools: ["whoami"],
      worktree: "write",
    },
    launch: parseLaunchConfig({
      providers: {
        gateway: {
          harness: "claude-code",
          env: {
            ANTHROPIC_BASE_URL: `https://user:${SECRET}@relay.example.net:8443/v1?key=${QUERY_SECRET}`,
          },
          secret_env: { ANTHROPIC_AUTH_TOKEN: "KEY" },
        },
      },
      profiles: { fixture: { harness: "claude-code", provider: "gateway" } },
    }),
    run_dir: "/fixture/runs/project/A-7",
    work_dir: "/fixture/worktrees/project/A-7",
    first_prompt: "fixture",
    mcp: { url: "http://localhost/mcp" },
    secrets: { KEY: SECRET },
    status_line: {
      base_ref: "origin/main",
      handoff_remaining_pct: 25,
      restart_remaining_pct: 20,
    },
    ...overrides,
  });
}

function settingsOf(compiled: ReturnType<typeof compile>) {
  const path = compiled.args[compiled.args.indexOf("--settings") + 1];
  const file = compiled.files.find((f) => f.path === path);
  if (!file) throw new Error("settings file missing");
  return {
    content: file.content,
    settings: JSON.parse(file.content) as {
      statusLine: { type: string; command: string; padding: number };
    },
  };
}

/** Run the generated command exactly as Claude Code does: through a shell. */
function run(
  command: string,
  input: unknown,
  options: { cwd?: string; env?: Record<string, string> } = {},
) {
  const result = spawnSync("/bin/sh", ["-c", command], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    cwd: options.cwd ?? root,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...options.env },
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  return result.stdout;
}
const ESC = String.fromCharCode(27);
const plain = (text: string) =>
  text.replaceAll(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout;
}
function repository() {
  const repo = join(root, `repo-${Math.random().toString(36).slice(2)}`);
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "base");
  git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(repo, "checkout", "-q", "-b", "agent/C-9/W-90");
  git(repo, "commit", "-q", "--allow-empty", "-m", "one");
  git(repo, "commit", "-q", "--allow-empty", "-m", "two");
  return repo;
}

const full = (cwd: string, extra: Record<string, unknown> = {}) => ({
  session_id: "s-1",
  model: { id: "claude-opus-5-5", display_name: "Opus 5.5" },
  workspace: { current_dir: cwd },
  context_window: {
    context_window_size: 200_000,
    used_percentage: 40,
    current_usage: {
      input_tokens: 10,
      output_tokens: 500,
      cache_creation_input_tokens: 1_990,
      cache_read_input_tokens: 78_000,
    },
  },
  cost: {
    total_cost_usd: 1.234,
    total_duration_ms: 3_725_000,
    total_lines_added: 12,
    total_lines_removed: 3,
  },
  ...extra,
});

describe("C-686 Agent Claude status line", () => {
  test("every Claude Assignment settings file carries the status line, without secrets", () => {
    const { content, settings } = settingsOf(compile());
    expect(settings.statusLine).toMatchObject({ type: "command", padding: 0 });
    expect(settings.statusLine.command.startsWith("'/usr/bin/python3' ")).toBe(
      true,
    );
    expect(settings.statusLine.command).toContain(
      '"relay":"relay.example.net"',
    );
    // The settings keep the provider URL env, as before; the status line
    // configuration itself carries the hostname only.
    expect(settings.statusLine.command).not.toContain(QUERY_SECRET);
    expect(settings.statusLine.command).not.toContain(SECRET);
    expect(content).not.toContain(`"${SECRET}"`);
    expect(content).not.toContain("ANTHROPIC_AUTH_TOKEN");
  });

  test("full input prints identity, git, context, cost, time, lines and relay host", () => {
    const repo = repository();
    const { settings } = settingsOf(compile());
    const out = run(settings.statusLine.command, full(repo), {
      env: {
        MCP_TOKEN: SECRET,
        ANTHROPIC_AUTH_TOKEN: SECRET,
        ANTHROPIC_BASE_URL: `https://relay.example.net/?key=${QUERY_SECRET}`,
      },
    });
    expect(plain(out)).toBe(
      "孙悟空 | A-7 | coder | C-9/W-90 | R-70\n" +
        "Opus 5.5 | agent/C-9/W-90 ↑2 ↓0 | ████░░░░░░ 80k/200k 40% | $1.23 | 1h02m | +12 -3 | relay.example.net\n",
    );
    expect(out).toContain("\u001b[32m");
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(QUERY_SECRET);
  });

  test.each([
    [74, "32"],
    [75, "33"],
    [79.9, "33"],
    [80, "31"],
  ])(
    "used %s%% with handoff 25%% / restart 20%% remaining is colour %s",
    (used, colour) => {
      const { settings } = settingsOf(compile());
      const out = run(settings.statusLine.command, {
        context_window: {
          context_window_size: 1_000_000,
          used_percentage: used,
        },
      });
      expect(out).toContain(`\u001b[${colour}m`);
    },
  );

  test("missing fields, garbage input and a non-git directory still print", () => {
    const { settings } = settingsOf(compile());
    const plainDir = join(root, "not-git");
    mkdirSync(plainDir, { recursive: true });
    for (const input of [
      {},
      "",
      "not json",
      "[1,2]",
      { model: 7, cost: "x", context_window: { current_usage: null } },
      { workspace: { current_dir: plainDir }, model: { id: "m" } },
      { workspace: { current_dir: "/does/not/exist" } },
    ]) {
      const out = run(settings.statusLine.command, input, { cwd: plainDir });
      expect(out.split("\n")[0]).toBe("孙悟空 | A-7 | coder | C-9/W-90 | R-70");
      expect(out).not.toContain("Traceback");
    }
    expect(
      run(settings.statusLine.command, {
        workspace: { current_dir: plainDir },
        model: { display_name: "Opus\u001b[2J 5.5" },
      }).split("\n")[1],
    ).toBe("Opus[2J 5.5 | relay.example.net");
  });

  test("remote worker: the worker's interpreter and paths, no host paths", () => {
    const compiled = compile({
      run_dir: "/Users/agent/cardigan/runs/project/A-7",
      work_dir: "/Users/agent/cardigan/worktrees/project/A-7",
      mcp: {
        url: "http://127.0.0.1:3004/mcp",
        bridge_python: "/opt/homebrew/bin/python3",
      },
      worker_launch: {
        command: ["/opt/homebrew/bin/python3", "-I", "/x/worker-files.py"],
        session_dir: "/Users/agent/cardigan/sessions/project/A-7",
      },
    });
    const { settings } = settingsOf(compiled);
    expect(
      settings.statusLine.command.startsWith("'/opt/homebrew/bin/python3' "),
    ).toBe(true);
    expect(settings.statusLine.command).not.toContain("/fixture/");
    const launch = compiled.files.find((f) => f.path.endsWith("launch.json"));
    expect(launch?.content).not.toContain("statusline");
    // The worker runs the identical command; check it with this machine's python.
    const command = settings.statusLine.command.replace(
      "'/opt/homebrew/bin/python3'",
      "'/usr/bin/python3'",
    );
    const repo = repository();
    const out = plain(
      run(command, full(repo), {
        env: {
          CLAUDE_CONFIG_DIR: join(root, "missing-session-dir", "claude"),
        },
      }),
    );
    expect(out).toContain("A-7 | coder | C-9/W-90 | R-70");
    expect(out).toContain("agent/C-9/W-90 ↑2 ↓0");
    expect(() =>
      compile({ mcp: { url: "http://localhost/mcp", bridge_python: "py" } }),
    ).toThrow("absolute path");
  });

  test("a later bell in the transcript updates card and Run, remembered across /clear", () => {
    const session = join(root, "session-claude");
    mkdirSync(session, { recursive: true });
    const transcript = join(root, "t.jsonl");
    const line = (v: unknown) => `${JSON.stringify(v)}\n`;
    writeFileSync(
      transcript,
      line({
        type: "user",
        message: { content: "[bell] card=C-9 asg=A-7 run=R-70 seq=1..1" },
      }) +
        line({
          type: "user",
          message: {
            content: [
              {
                type: "text",
                text: "[bell] card=C-12 asg=A-7 run=R-88 seq=3..4\n→ 请调用",
              },
            ],
          },
        }) +
        // Tool output, other Assignments and sidechains never move the line.
        line({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                content: "[bell] card=C-1 asg=A-7 run=R-1",
              },
            ],
          },
        }) +
        line({
          type: "user",
          message: { content: "[bell] card=C-2 asg=A-99 run=R-2" },
        }) +
        line({
          type: "user",
          isSidechain: true,
          message: { content: "[bell] card=C-3 asg=A-7 run=R-3" },
        }) +
        line({
          type: "assistant",
          message: { content: "[bell] card=C-4 asg=A-7 run=R-4" },
        }),
    );
    const { settings } = settingsOf(compile());
    const env = { CLAUDE_CONFIG_DIR: session };
    expect(
      run(
        settings.statusLine.command,
        { transcript_path: transcript },
        { env },
      ).split("\n")[0],
    ).toBe("孙悟空 | A-7 | coder | C-12 | R-88");
    // After /clear the new transcript has no bell yet.
    const cleared = join(root, "cleared.jsonl");
    writeFileSync(cleared, line({ type: "user", message: { content: "hi" } }));
    expect(
      run(
        settings.statusLine.command,
        { transcript_path: cleared },
        { env },
      ).split("\n")[0],
    ).toBe("孙悟空 | A-7 | coder | C-12 | R-88");
    // The first bell is found at the head when the tail has none.
    const long = join(root, "long.jsonl");
    writeFileSync(
      long,
      line({
        type: "user",
        message: { content: "[bell] card=C-9 asg=A-7 run=R-71 seq=1..1" },
      }) +
        line({ type: "assistant", message: { content: "x".repeat(600_000) } }),
    );
    expect(
      run(settings.statusLine.command, { transcript_path: long }).split(
        "\n",
      )[0],
    ).toBe("孙悟空 | A-7 | coder | C-9/W-90 | R-71");
  });

  test("relay hostname never returns credentials, port, path or query", () => {
    expect(relayHostname(`https://u:${SECRET}@h.example:1/p?key=1`)).toBe(
      "h.example",
    );
    expect(relayHostname("not a url")).toBeUndefined();
    expect(relayHostname(undefined)).toBeUndefined();
  });

  test("runs well within 100 ms on a git worktree", () => {
    const repo = repository();
    const { settings } = settingsOf(compile());
    const times: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const start = performance.now();
      run(settings.statusLine.command, full(repo));
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    // Median including /bin/sh and process spawn; a loose bound against
    // loaded check machines. Measured locally about 30–40 ms.
    expect(times[2]).toBeLessThan(250);
  });
});
