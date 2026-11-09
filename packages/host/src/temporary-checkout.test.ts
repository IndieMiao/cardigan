import { execFile, spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  AGENT_PATH,
  type AgentExecution,
  type ExecutionConfig,
} from "@cardigan/runtime-herdr";
import { afterEach, expect, test, vi } from "vitest";
import {
  type CheckoutInput,
  runInTemporaryCheckout,
} from "./temporary-checkout.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const node = (script: string) =>
  `${quote(process.execPath)} -e ${quote(script)}`;
async function fixture(agent = false) {
  const root = await mkdtemp(join(tmpdir(), "cg-checkout-"));
  roots.push(root);
  const execution: ExecutionConfig = agent
    ? {
        mode: "agent-ssh",
        dataDir: join(root, "data"),
        agentRoot: join(root, "agent"),
        gid: process.getgid?.() ?? 0,
        machine: "cardigan-agent",
        identityFile: join(root, "identity"),
        knownHostsFile: join(root, "known"),
      }
    : { mode: "local", dataDir: join(root, "data") };
  await mkdir(execution.dataDir, { mode: 0o700 });
  if (execution.mode === "agent-ssh") {
    await mkdir(execution.agentRoot, { mode: 0o2750 });
    await chmod(execution.agentRoot, 0o2750);
    for (const file of [execution.identityFile, execution.knownHostsFile])
      await writeFile(file, "fixture", { mode: 0o600 });
  }
  const base =
    execution.mode === "local"
      ? join(execution.dataDir, "agent")
      : execution.agentRoot;
  const repository = join(base, "repos", "project");
  await mkdir(repository, { recursive: true });
  const git = async (...args: string[]) =>
    (await exec("git", ["-C", repository, ...args])).stdout.trim();
  await git("init", "-b", "main");
  await writeFile(join(repository, "file"), "original\n");
  await git("add", "file");
  await git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "initial",
  );
  const input: CheckoutInput = {
    execution,
    project: "project",
    attempt: "attempt-1",
    sha: await git("rev-parse", "HEAD"),
    tree: await git("rev-parse", "HEAD^{tree}"),
    checks: [{ name: "check", run: "true" }],
    totalTimeoutMs: 5000,
  };
  const container = join(base, "checks", "project", "attempt-1");
  const clean = async () => {
    await expect(stat(container)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await git("worktree", "list", "--porcelain")).match(/^worktree /gm),
    ).toHaveLength(1);
    expect(await git("rev-parse", "HEAD")).toBe(input.sha);
    expect(await readFile(join(repository, "file"), "utf8")).toBe("original\n");
  };
  return { input, git, clean, repository, container };
}

test("local checkout uses an explicit environment, runs in order, warns, and removes ignored build output", async () => {
  const f = await fixture(),
    output: [string, string][] = [];
  vi.stubEnv("HC_SESSION", "production-session");
  vi.stubEnv("CARDIGAN_TOKEN", "host-secret");
  vi.stubEnv("XDG_RUNTIME_DIR", "/production/socket");
  vi.stubEnv("SSH_AUTH_SOCK", "/production/agent");
  const result = await runInTemporaryCheckout({
    ...f.input,
    env: { CHECK_VALUE: "explicit" },
    checks: [
      {
        name: "first",
        run: node(
          "console.log(JSON.stringify(process.env)); require('node:fs').writeFileSync('build.tmp', 'compiled')",
        ),
      },
      {
        name: "second",
        run: node(
          "console.log(require('node:fs').readFileSync('build.tmp', 'utf8'))",
        ),
      },
    ],
    onOutput: (name, text) => output.push([name, text]),
  });
  expect(result.status).toBe("passed");
  expect(result.cleanup_errors).toEqual([]);
  expect(output[0]?.[1]).toContain("没有 Agent 账号隔离");
  expect(
    JSON.parse(
      output
        .filter(([n]) => n === "first")
        .map(([, s]) => s)
        .join(""),
    ),
  ).toEqual({
    PATH: "/usr/local/bin:/usr/bin:/bin",
    PWD: join(f.container, "worktree"),
    CHECK_VALUE: "explicit",
  });
  expect(
    output
      .filter(([n]) => n === "second")
      .map(([, s]) => s)
      .join(""),
  ).toContain("compiled");
  expect(result.checks.map((c) => c.name)).toEqual(["first", "second"]);
  await f.clean();
});

test("a failed command stops later checks and still removes the worktree", async () => {
  const f = await fixture();
  const result = await runInTemporaryCheckout({
    ...f.input,
    checks: [
      { name: "fail", run: "echo 'FAIL example' >&2; exit 7" },
      { name: "later", run: "true" },
    ],
  });
  expect(result.status).toBe("failed");
  expect(result.checks).toMatchObject([
    { name: "fail", exit_code: 7 },
    { name: "later", status: "not_run" },
  ]);
  await f.clean();
});

test.each(["single", "total", "cancel"] as const)(
  "%s termination kills the recorded command process group and cleans up",
  async (kind) => {
    const f = await fixture(),
      controller = new AbortController();
    let pid = 0;
    const result = await runInTemporaryCheckout({
      ...f.input,
      signal: controller.signal,
      totalTimeoutMs: kind === "total" ? 500 : 5000,
      checks: [
        {
          name: "wait",
          timeoutMs: kind === "single" ? 300 : 4000,
          run: node("console.log(process.pid); setInterval(() => {}, 1000)"),
        },
      ],
      onOutput: (name, text) => {
        if (name === "wait") {
          pid = Number(text.trim());
          if (kind === "cancel") controller.abort();
        }
      },
    });
    expect(result.status).toBe(kind === "cancel" ? "interrupted" : "timed_out");
    expect(pid).toBeGreaterThan(0);
    const status = await readFile(`/proc/${pid}/stat`, "utf8").catch(
      () => "gone",
    );
    expect(status === "gone" || /\) Z /u.test(status)).toBe(true);
    await f.clean();
  },
);

test.each(["wrong-tree", "dirty", "staged"] as const)(
  "%s cannot report a passed check",
  async (kind) => {
    const f = await fixture();
    const result = await runInTemporaryCheckout({
      ...f.input,
      ...(kind === "wrong-tree" ? { tree: "a".repeat(40) } : {}),
      checks: [
        {
          name: "mutation",
          run:
            kind === "wrong-tree"
              ? "true"
              : `echo changed >>file${kind === "staged" ? "; git add file" : ""}`,
        },
      ],
    });
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("HEAD or tree");
    await f.clean();
  },
);

test("invalid input and reserved runtime variables fail before creating a checkout", async () => {
  const f = await fixture();
  for (const patch of [
    { project: "../escape" },
    { sha: "HEAD" },
    { attempt: "../escape" },
    { checks: [] },
    { totalTimeoutMs: 0 },
    { checks: [{ name: "x", run: " " }] },
    ...[
      "PATH",
      "HC_SESSION",
      "HC_SOCKET",
      "CARDIGAN_DATA_DIR",
      "XDG_RUNTIME_DIR",
    ].map((key) => ({ env: { [key]: "bad" } })),
  ])
    await expect(
      runInTemporaryCheckout({ ...f.input, ...patch }),
    ).rejects.toThrow();
  await f.clean();
});

test.skipIf(process.platform !== "linux")(
  "Agent entry uses pinned SSH and whitelist env; all checkout Git runs through that entry",
  async () => {
    const f = await fixture(true),
      calls: string[] = [],
      output: string[] = [];
    const config = f.input.execution as AgentExecution;
    const result = await runInTemporaryCheckout(
      {
        ...f.input,
        checks: [
          {
            name: "env",
            run: node("console.log(JSON.stringify(process.env))"),
          },
        ],
        onOutput: (name, text) => {
          if (name === "env") output.push(text);
        },
      },
      (file, args, env) => {
        calls.push(file);
        expect(file).toBe("ssh");
        expect(env).toEqual({ PATH: AGENT_PATH });
        expect(args).toEqual(
          expect.arrayContaining([
            "-F",
            "/dev/null",
            "IdentitiesOnly=yes",
            "IdentityAgent=none",
            "StrictHostKeyChecking=yes",
            config.identityFile,
            "agent@localhost",
          ]),
        );
        expect(args.at(-1)).toContain("'env' '-i'");
        // Fake Agent execution entrance: the real worker and Git still run, with no SSH connection.
        const remote = (args.at(-1) ?? "").replace(
          "'node' '-e'",
          `${quote(process.execPath)} '-e'`,
        );
        return spawn("/bin/sh", ["-c", remote], {
          env,
          stdio: ["pipe", "pipe", "pipe"],
        });
      },
    );
    expect(result.status).toBe("passed");
    expect(calls).toEqual(["ssh"]);
    expect(JSON.parse(output.join(""))).toEqual({
      PATH: AGENT_PATH,
      PWD: join(f.container, "worktree"),
    });
    await f.clean();
  },
);

test("cleanup failure is reported without changing a passed conclusion", async () => {
  const f = await fixture();
  const result = await runInTemporaryCheckout({
    ...f.input,
    checks: [{ name: "lock", run: "git worktree lock ." }],
  });
  expect(result.status).toBe("passed");
  expect(result.cleanup_errors).toContain(
    "Could not remove temporary worktree registration",
  );
});
