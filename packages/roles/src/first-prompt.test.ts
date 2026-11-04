import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import type { Harness } from "./harness.js";
import {
  compileAssignmentLaunch,
  firstPrompt,
  parseLaunchConfig,
} from "./index.js";

/**
 * M2.4 / M2 §4 step 7: the wrapper must hand the first task message to the CLI.
 *
 * first.md alone never triggers an Agent turn: an interactive CLI started with
 * no prompt just waits for input. All three harnesses take the first message as
 * the last positional argument of the interactive invocation (claude [prompt],
 * codex [PROMPT], pi [messages...]).
 */

const launch = parseLaunchConfig({
  profiles: {
    "claude-agent": { harness: "claude-code", model: "opus" },
    "codex-agent": { harness: "codex", model: "gpt-6-astra" },
    "pi-agent": { harness: "pi", model: "deepseek-flash" },
  },
});

const profileFor: Readonly<Record<Harness, string>> = {
  "claude-code": "claude-agent",
  codex: "codex-agent",
  pi: "pi-agent",
};

interface Received {
  readonly argv: readonly string[];
  readonly stdin: string;
}

/** Compile, write, and run the wrapper with a stand-in CLI that reports argv. */
async function runWrapper(
  harness: Harness,
  message: string,
): Promise<Received> {
  const root = await mkdtemp(join(tmpdir(), "cardigan-first-prompt-"));
  try {
    const compiled = compileAssignmentLaunch({
      assignment: { assignment_id: "A-1", run_id: "R-1" },
      role: {
        role_id: "coder",
        harness,
        launch_profile: profileFor[harness],
        core_prompt: "Core prompt.",
        allowed_tools: ["whoami", "get_card"],
        worktree: "none",
      },
      launch,
      mcp: { url: "http://127.0.0.1:3004/mcp" },
      run_dir: join(root, "run"),
      work_dir: root,
      first_prompt: message,
      secrets: {},
    });
    for (const file of compiled.files) {
      await mkdir(dirname(file.path), { recursive: true });
      await writeFile(file.path, file.content, { mode: file.mode });
    }
    await writeFile(compiled.token_file, "fictional-token\n", { mode: 0o600 });

    // The stand-in CLI writes down exactly what it was started with.
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(
      join(bin, compiled.command),
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  argv: process.argv.slice(2),
  stdin: require("node:fs").readFileSync(0, "utf8"),
}));
`,
      { mode: 0o700 },
    );

    const received = await new Promise<Received>((resolve, reject) => {
      const child = spawn(compiled.launch_script, [], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (chunk: Buffer) => {
        out += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        err += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0
          ? resolve(JSON.parse(out) as Received)
          : reject(new Error(`wrapper exited ${code}: ${err}`)),
      );
    });
    return received;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const message = firstPrompt({
  assignment_id: "A-1",
  run_id: "R-1",
  card_id: "C-1",
  work_item_id: "W-1",
});

test.each(["claude-code", "codex", "pi"] as const)(
  "%s receives first.md as its last positional argument, verbatim",
  async (harness) => {
    const received = await runWrapper(harness, message);
    // The message is the last argument, not glued to an option value and not
    // hidden inside a file path. first.md holds it with a trailing newline.
    expect(received.argv.at(-1)).toBe(`${message}\n`);
    // It is not piped through stdin: an interactive CLI reads stdin itself.
    expect(received.stdin).toBe("");
  },
);

test.each(["claude-code", "codex", "pi"] as const)(
  "%s keeps quotes, newlines and trailing whitespace in the message",
  async (harness) => {
    const tricky = `${message}\n\nit's "quoted" and $VAR, with a trailing blank line\n\n`;
    const received = await runWrapper(harness, tricky);
    // Written as-is: the file already ends with a newline, so nothing is added
    // and nothing is stripped.
    expect(received.argv.at(-1)).toBe(tricky);
  },
);

test("the message is read from first.md at start, not embedded in the script", async () => {
  const harness = "pi" as const;
  const root = await mkdtemp(join(tmpdir(), "cardigan-first-prompt-"));
  try {
    const compiled = compileAssignmentLaunch({
      assignment: { assignment_id: "A-1", run_id: "R-1" },
      role: {
        role_id: "coder",
        harness,
        launch_profile: profileFor[harness],
        core_prompt: "Core prompt.",
        allowed_tools: ["whoami"],
        worktree: "none",
      },
      launch,
      mcp: { url: "http://127.0.0.1:3004/mcp" },
      run_dir: join(root, "run"),
      work_dir: root,
      first_prompt: message,
      secrets: {},
    });
    const script = compiled.files.find(
      (file) => file.path === compiled.launch_script,
    )?.content;
    expect(script).toContain("first_file=");
    expect(script).not.toContain(message);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing first.md fails the start instead of launching an idle CLI", async () => {
  const harness = "codex" as const;
  const root = await mkdtemp(join(tmpdir(), "cardigan-first-prompt-"));
  try {
    const compiled = compileAssignmentLaunch({
      assignment: { assignment_id: "A-1", run_id: "R-1" },
      role: {
        role_id: "coder",
        harness,
        launch_profile: profileFor[harness],
        core_prompt: "Core prompt.",
        allowed_tools: ["whoami"],
        worktree: "none",
      },
      launch,
      mcp: { url: "http://127.0.0.1:3004/mcp" },
      run_dir: join(root, "run"),
      work_dir: root,
      first_prompt: message,
      secrets: {},
    });
    for (const file of compiled.files) {
      await mkdir(dirname(file.path), { recursive: true });
      await writeFile(file.path, file.content, { mode: file.mode });
    }
    await writeFile(compiled.token_file, "fictional-token\n", { mode: 0o600 });
    await rm(join(root, "run", "first.md"));

    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(compiled.launch_script, [], {
        env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}` },
        stdio: ["ignore", "ignore", "pipe"],
      });
      child.on("error", reject);
      child.on("close", (exit) => resolve(exit ?? -1));
    });
    expect(code).toBe(78);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
