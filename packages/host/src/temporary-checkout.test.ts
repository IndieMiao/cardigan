import {
  type ChildProcessWithoutNullStreams,
  execFile,
  spawn,
} from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  AGENT_PATH,
  type AgentExecution,
  type ExecutionConfig,
} from "@cardigan/runtime-herdr";
import { afterEach, expect, test, vi } from "vitest";
import { CHECKOUT_LIMITS } from "./checkout-limits.js";
import { sweepCheckoutOrphans } from "./checkout-orphans.js";
import { CHECKOUT_WORKER } from "./checkout-worker.js";
import {
  type CheckoutInput,
  ExecutorPreparationError,
  runInTemporaryCheckout,
} from "./temporary-checkout.js";

const exec = promisify(execFile);
const roots: string[] = [];
const recordedProcesses: { pid: number; root: string }[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const { pid, root } of recordedProcesses.splice(0)) {
    const exe = await readlink(`/proc/${pid}/exe`).catch(() => "");
    if (exe.startsWith(`${root}/`))
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
  }
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
  const aliases = join(
    execution.mode === "local" ? execution.dataDir : execution.agentRoot,
    "s",
  );
  const clean = async () => {
    await expect(stat(container)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await git("worktree", "list", "--porcelain")).match(/^worktree /gm),
    ).toHaveLength(1);
    expect(await git("rev-parse", "HEAD")).toBe(input.sha);
    expect(await readFile(join(repository, "file"), "utf8")).toBe("original\n");
    expect(
      await readdir(aliases).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      }),
    ).toEqual([]);
  };
  return { input, git, clean, repository, container, aliases, root };
}

test("short private aliases keep Unix sockets usable for long attempts and are removed with their targets", async () => {
  const f = await fixture(),
    attempt = "a".repeat(80),
    container = join(f.container, "..", attempt);
  const result = await runInTemporaryCheckout({
    ...f.input,
    attempt,
    checks: [
      {
        name: "socket",
        run: node(`
    const fs=require('node:fs'), path=require('node:path'), assert=require('node:assert/strict');
    for(const [key,target] of [['TMPDIR','tmp'],['XDG_RUNTIME_DIR','runtime']]) {
      assert.equal(fs.realpathSync(process.env[key]),path.join(${JSON.stringify(container)},target));
      const owner=fs.statSync(path.dirname(process.env[key]));
      assert.equal(owner.uid,process.getuid()); assert.equal(owner.mode & 0o777,0o700);
    }
    const dir=path.join(process.env.TMPDIR,'cardigan-e2e-x','run','cardigan');
    fs.mkdirSync(dir,{recursive:true});
    const server=require('node:net').createServer();
    server.on('error',()=>process.exit(1));
    server.listen(path.join(dir,'e2e-123-123.sock'),()=>server.close());
  `),
      },
    ],
  });
  expect(result.status).toBe("passed");
  expect(result.cleanup_errors).toEqual([]);
  await expect(stat(container)).rejects.toMatchObject({ code: "ENOENT" });
  await f.clean();
});

test
  .skipIf(process.platform !== "linux")
  .each(["passed", "timed_out"] as const)(
  "%s checks reap detached core/holder PIDs only from this attempt",
  async (expected) => {
    const f = await fixture(),
      outside = join(f.root, "outside");
    let output = "";
    const result = await runInTemporaryCheckout({
      ...f.input,
      checks: [
        {
          name: "cores",
          timeoutMs: 400,
          run: node(`
      const fs=require('node:fs'), path=require('node:path'), {spawn}=require('node:child_process');
      const outside=${JSON.stringify(outside)}; fs.mkdirSync(outside);
      const own=path.join(process.env.TMPDIR,'herdr-core'), other=path.join(outside,'herdr-core');
      for(const binary of [own,other]){fs.copyFileSync('/usr/bin/python3',binary);fs.chmodSync(binary,0o700);}
      const launch=(binary,runtime)=>{const c=spawn(binary,['-c','import time; time.sleep(60)'],{cwd:binary===other?outside:process.cwd(),detached:true,stdio:'ignore',env:{PATH:process.env.PATH,XDG_RUNTIME_DIR:runtime}});c.unref();return c.pid;};
      console.log(JSON.stringify([launch(own,process.env.XDG_RUNTIME_DIR),launch(own,fs.realpathSync(process.env.TMPDIR)+'/holder'),launch(other,outside)]));
      ${expected === "timed_out" ? "setInterval(()=>{},1000);" : "setTimeout(()=>{},50);"}
    `),
        },
      ],
      onOutput: (name, text) => {
        if (name === "cores") {
          output += text;
          try {
            for (const pid of JSON.parse(output) as number[])
              recordedProcesses.push({ pid, root: f.root });
          } catch {}
        }
      },
    });
    const [core, holder, other] = JSON.parse(output) as number[];
    expect(result.status).toBe(expected);
    expect(result.cleanup_errors).toEqual([]);
    for (const pid of [core, holder]) {
      const state = await readFile(`/proc/${pid}/stat`, "utf8").catch(
        () => "gone",
      );
      expect(state === "gone" || /\) Z /u.test(state)).toBe(true);
    }
    expect(() => process.kill(other as number, 0)).not.toThrow();
    await f.clean();
  },
);

test("local checkout uses an explicit environment, runs in order, warns, and removes ignored build output", async () => {
  const f = await fixture(),
    output: [string, string][] = [];
  vi.stubEnv("HC_SESSION", "production-session");
  vi.stubEnv("CARDIGAN_TOKEN", "host-secret");
  vi.stubEnv("XDG_RUNTIME_DIR", "/production/socket");
  vi.stubEnv("SSH_AUTH_SOCK", "/production/agent");
  vi.stubEnv("NODE_OPTIONS", "--require=/employee/test-workers.cjs");
  vi.stubEnv("HOME", "/host-only-home");
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
          "const fs=require('node:fs'), assert=require('node:assert/strict'); for(const key of ['XDG_RUNTIME_DIR','TMPDIR']) assert.equal(fs.statSync(process.env[key]).mode & 0o777, 0o700); console.log(fs.readFileSync('build.tmp', 'utf8'))",
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
    HOME: userInfo().homedir,
    XDG_RUNTIME_DIR: expect.stringContaining(`${f.aliases}/`),
    TMPDIR: expect.stringContaining(`${f.aliases}/`),
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

test.skipIf(process.platform !== "linux")(
  "one persistent OS lock serializes checks from two projects and does not leak its descriptor",
  async () => {
    const f = await fixture(),
      other = join(f.repository, "..", "other"),
      occupied = join(f.root, "occupied");
    await exec("git", ["clone", f.repository, other]);
    const check = {
      name: "exclusive",
      run: node(`
    const fs=require('node:fs');
    for(const fd of fs.readdirSync('/proc/self/fd')) {
      let path;try{path=fs.readlinkSync('/proc/self/fd/'+fd)}catch{continue}
      if(path.endsWith('/merge-check.lock'))process.exit(8);
    }
    fs.mkdirSync(${JSON.stringify(occupied)});
    setTimeout(()=>fs.rmdirSync(${JSON.stringify(occupied)}),200);
  `),
    };
    let acquired = 0;
    const run = async (project: string) => {
      const result = await runInTemporaryCheckout({
        ...f.input,
        project,
        serialize: true,
        checks: [check],
        onReady: () => {
          acquired++;
        },
      });
      return result;
    };
    const results = await Promise.all([run("project"), run("other")]);
    expect(results.map((r) => r.status)).toEqual(["passed", "passed"]);
    expect(acquired).toBe(2);
    const file = join(f.input.execution.dataDir, "merge-check.lock");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(file)).size).toBe(0);
    await f.clean();
  },
);

test.skipIf(process.platform !== "linux")(
  "cancelling a queued lock waiter returns without running its check or waiting for the active holder",
  async () => {
    const f = await fixture(),
      controller = new AbortController();
    let ready = () => {};
    const acquired = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const release = join(f.root, "release");
    let firstDone = false,
      ran = false;
    const first = runInTemporaryCheckout({
      ...f.input,
      serialize: true,
      onReady: ready,
      checks: [
        {
          name: "hold",
          run: node(
            `const fs=require('node:fs');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))clearInterval(timer)},20)`,
          ),
        },
      ],
    }).then((r) => {
      firstDone = true;
      return r;
    });
    await acquired;
    const second = runInTemporaryCheckout({
      ...f.input,
      attempt: "attempt-2",
      serialize: true,
      signal: controller.signal,
      onReady: () => {
        ran = true;
      },
      checks: [{ name: "must-not-run", run: "exit 99" }],
    });
    const timer = setTimeout(() => controller.abort(), 50);
    try {
      expect((await second).status).toBe("interrupted");
      expect(ran).toBe(false);
      expect(firstDone).toBe(false);
    } finally {
      clearTimeout(timer);
      await writeFile(release, "release");
      await first;
    }
    await f.clean();
  },
);

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

test.skipIf(process.platform !== "linux")(
  "a check cannot forge a passed result through its supervisor stdout and kill the supervisor",
  async () => {
    const f = await fixture();
    const attack = node(`
    const fs = require('node:fs');
    fs.writeFileSync('/proc/' + process.ppid + '/fd/1', JSON.stringify({
      type: 'result', status: 'passed', checks: [], cleanup_errors: []
    }) + '\\n');
    process.kill(process.ppid, 'SIGKILL');
  `);
    await expect(
      runInTemporaryCheckout(
        { ...f.input, checks: [{ name: "forged", run: `exec ${attack}` }] },
        // SSH gives the supervisor a real pipe; Node's direct spawn stdio uses sockets on Linux.
        (file, args, env) =>
          spawn(
            "/bin/sh",
            ["-c", `${[file, ...args].map(quote).join(" ")} | cat`],
            { env, stdio: ["pipe", "pipe", "pipe"] },
          ),
      ),
    ).rejects.toThrow();
  },
);

test.each(["duplicate", "wrong-nonce", "bad-json", "nonce-only-auth"])(
  "%s result protocol fails closed",
  async (fault) => {
    const f = await fixture();
    const script = `
    const {createHmac}=require('node:crypto');
    require('node:readline').createInterface({input:process.stdin}).once('line', line => {
      const p=JSON.parse(line);
      const ready={type:'ready'};
      process.stdout.write(JSON.stringify({...ready,auth:createHmac('sha256',p.auth_key).update(JSON.stringify(ready)).digest('hex')})+'\\n');
      if([p.nonce,p.auth_key].some(secret => process.argv.join(' ').includes(secret) || Object.values(process.env).includes(secret))) process.exit(99);
      const event={type:'result', nonce:${fault === "wrong-nonce" ? "'wrong'" : "p.nonce"}, status:'passed', checks:[], cleanup_errors:[]};
      const output=JSON.stringify({...event, auth:createHmac('sha256',${fault === "nonce-only-auth" ? "p.nonce" : "p.auth_key"}).update(JSON.stringify(event)).digest('hex')})+'\\n';
      process.stdout.write(${fault === "bad-json" ? "'not json\\n'" : fault === "duplicate" ? "output+output" : "output"});
      process.stdin.destroy();
    });`;
    await expect(
      runInTemporaryCheckout(f.input, (_file, _args, env) =>
        spawn(process.execPath, ["-e", script], {
          env,
          stdio: ["pipe", "pipe", "pipe"],
        }),
      ),
    ).rejects.toThrow();
    await f.clean();
  },
);

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

test.skipIf(process.platform !== "linux").each(["group", "cwd"] as const)(
  "an unkillable child identified by %s exits its supervisor, releases flock and preserves its directory",
  async (identity) => {
    const f = await fixture();
    const output: string[] = [];
    const lock = join(f.input.execution.dataDir, "merge-check.lock");
    let worker: ChildProcessWithoutNullStreams | undefined;
    let lockedWhileRunning: Promise<number | string> | undefined;
    // Model D state and a child that never emits close; never create actual kernel stalls.
    const inject = String.raw`
    const fakePid = 900000001;
    const cp = require('node:child_process'), fs = require('node:fs/promises');
    const originalSpawn = cp.spawn, originalRead = fs.readFile, originalLink = fs.readlink, originalList = fs.readdir, originalKill = process.kill;
    let fakeCwd;
    cp.spawn = (file, args, options) => {
      if (file !== '/bin/sh' || args[1] !== 'simulated-d-child') return originalSpawn(file, args, options);
      fakeCwd = options.cwd;
      const child = new (require('node:events').EventEmitter)();
      child.pid = fakePid;
      child.stdout = new (require('node:stream').PassThrough)();
      child.stderr = new (require('node:stream').PassThrough)();
      child.unref = () => {};
      return child;
    };
    process.kill = (pid, signal) => Math.abs(pid) === fakePid ? true : originalKill(pid, signal);
    fs.readdir = async (path, ...args) => {
      const entries = await originalList(path, ...args);
      return path === '/proc' && fakeCwd ? [...entries, String(fakePid)] : entries;
    };
    fs.readlink = async (path, ...args) => path === '/proc/' + fakePid + '/cwd' ? fakeCwd : originalLink(path, ...args);
    fs.readFile = async (path, ...args) => {
      if (!String(path).startsWith('/proc/' + fakePid + '/')) return originalRead(path, ...args);
      if (path.endsWith('/status')) return 'Uid:\t' + Array(4).fill(process.getuid()).join('\t');
      if (path.endsWith('/wchan')) return 'exit_mm';
      if (!path.endsWith('/stat')) throw new Error('Forbidden simulated D-state read');
      const fields = Array(20).fill('0');
      fields[0] = 'D'; fields[1] = String(process.pid); fields[2] = ${identity === "group" ? "String(fakePid)" : "'0'"}; fields[19] = '100';
      return fakePid + ' (biome) ' + fields.join(' ');
    };
  `;
    // Fail if the supervisor needs the host's 120-second hard-stop fallback.
    // The watchdog also prevents a regressed worker from leaking its real lock.
    const watchdog = setTimeout(() => worker?.kill("SIGKILL"), 8_000);
    let result: Awaited<ReturnType<typeof runInTemporaryCheckout>>;
    try {
      result = await runInTemporaryCheckout(
        {
          ...f.input,
          serialize: true,
          checks: [{ name: "wait", run: "simulated-d-child", timeoutMs: 50 }],
          onReady: () => {
            lockedWhileRunning = exec(
              "flock",
              ["--nonblock", "--conflict-exit-code", "75", lock, "true"],
              { timeout: 1_000 },
            ).then(
              () => 0,
              (error: { code: number | string }) => error.code,
            );
          },
          onOutput: (_name, text) => output.push(text),
        },
        (file, args, env) => {
          worker = spawn(
            file,
            args.map((arg) => (arg === CHECKOUT_WORKER ? inject + arg : arg)),
            { env, stdio: ["pipe", "pipe", "pipe"] },
          );
          return worker;
        },
      );
    } finally {
      clearTimeout(watchdog);
      if (worker?.exitCode === null) worker.kill("SIGKILL");
    }
    expect(await lockedWhileRunning).toBe(75);
    expect(worker?.exitCode).toBe(0);
    expect(worker?.signalCode).toBeNull();
    await expect(
      exec("flock", ["--nonblock", lock, "true"], { timeout: 1_000 }),
    ).resolves.toMatchObject({ stderr: "" });
    expect(result).toMatchObject({
      status: "timed_out",
      manual_attention: true,
    });
    expect(output.join("")).toContain("PID 900000001 state=D wchan=exit_mm");
    const marker = join(f.container, "manual-attention.json");
    expect(JSON.parse(await readFile(marker, "utf8"))).toMatchObject({
      kind: "merge_check_manual_attention",
      processes: [
        { pid: 900000001, start: "100", state: "D", wchan: "exit_mm" },
      ],
    });
    expect((await stat(marker)).mode & 0o777).toBe(0o600);
    expect(await f.git("worktree", "list", "--porcelain")).toContain(
      join(f.container, "worktree"),
    );
    expect(await readFile(join(f.container, "worktree/file"), "utf8")).toBe(
      "original\n",
    );
  },
  10_000,
);

test("merge checks discard employee test injection and preserve maxWorkers=4", async () => {
  const f = await fixture();
  vi.stubEnv("NODE_OPTIONS", "--require=/employee/test-workers.cjs");
  let output = "";
  const result = await runInTemporaryCheckout({
    ...f.input,
    checks: [
      {
        name: "worker-policy",
        run: node(`
      const fs=require('node:fs'), cp=require('node:child_process'), assert=require('node:assert/strict');
      assert.equal(process.env.NODE_OPTIONS, undefined);
      fs.writeFileSync('vitest.mjs', 'console.log(JSON.stringify(process.argv.slice(2)))');
      const result=cp.spawnSync(process.execPath,['vitest.mjs','run','--maxWorkers=4'],{encoding:'utf8'});
      assert.equal(result.status,0); process.stdout.write(result.stdout);
    `),
      },
    ],
    onOutput: (_name, text) => {
      output += text;
    },
  });
  expect(result.status).toBe("passed");
  expect(output).toContain('["run","--maxWorkers=4"]');
  await f.clean();
});

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
      "HOME",
      "__proto__",
      "TMPDIR",
      "HC_SESSION",
      "HC_SOCKET",
      "CARDIGAN_DATA_DIR",
      "CARDIGAN_AFFECTED_PATHS",
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
      HOME: userInfo().homedir,
      XDG_RUNTIME_DIR: expect.stringContaining(`${f.aliases}/`),
      TMPDIR: expect.stringContaining(`${f.aliases}/`),
      PWD: join(f.container, "worktree"),
    });
    await f.clean();
  },
);

test("cancelling after readiness but before checkout reports cancellation without a cleanup error", async () => {
  const f = await fixture();
  const ready = vi.fn();
  // Deterministic: the supervisor receives "cancel" right after its payload, before `worktree add`.
  const result = await runInTemporaryCheckout(
    {
      ...f.input,
      onReady: ready,
      checks: [{ name: "must-not-run", run: "exit 99" }],
    },
    (file, args, env) =>
      spawn(
        "/bin/sh",
        [
          "-c",
          `(IFS= read -r line; printf '%s\\ncancel\\n' "$line") | ${[file, ...args].map(quote).join(" ")}`,
        ],
        { env, stdio: ["pipe", "pipe", "pipe"] },
      ),
  );
  expect(ready).toHaveBeenCalledOnce();
  expect(result).toEqual({
    status: "interrupted",
    checks: [{ name: "must-not-run", status: "not_run" }],
    cleanup_errors: [],
    reason: "临时工作区建好之前已取消",
  });
  await f.clean();
});

// The supervisor's PATH is fixed by the host; rewrite only the payload so a fake `git`
// can deliver SIGTERM (a supervisor cancellation signal) at a chosen point of `worktree add`.
async function cancelDuringAdd(
  f: Awaited<ReturnType<typeof fixture>>,
  beforeCancel: string,
) {
  const bin = join(f.root, "bin");
  await mkdir(bin);
  const real = (await exec("/bin/sh", ["-c", "command -v git"])).stdout.trim();
  await writeFile(
    join(bin, "git"),
    `#!/bin/sh\nREAL=${quote(real)}\ncase " $* " in *" worktree add "*) ${beforeCancel}\n  kill -TERM $PPID; sleep 10; exit 1;; esac\nexec "$REAL" "$@"\n`,
    { mode: 0o755 },
  );
  return runInTemporaryCheckout(
    { ...f.input, checks: [{ name: "must-not-run", run: "exit 99" }] },
    (file, args, env) => {
      const child = spawn(file, args, { env, stdio: ["pipe", "pipe", "pipe"] });
      const write = child.stdin.write.bind(child.stdin) as (
        chunk: string,
      ) => boolean;
      let first = true;
      child.stdin.write = ((chunk: string) => {
        if (!first) return write(chunk);
        first = false;
        const payload = JSON.parse(chunk);
        return write(
          `${JSON.stringify({ ...payload, path: `${bin}:${payload.path}` })}\n`,
        );
      }) as typeof child.stdin.write;
      return child;
    },
  );
}

test("cancelling after Git starts but before it registers the worktree reports no cleanup error", async () => {
  const f = await fixture();
  const result = await cancelDuringAdd(f, ":");
  expect(result).toEqual({
    status: "interrupted",
    checks: [{ name: "must-not-run", status: "not_run" }],
    cleanup_errors: [],
    reason: "临时工作区建好之前已取消",
  });
  await f.clean();
});

test("a cancelled checkout still reports a registration that could not be removed", async () => {
  const f = await fixture();
  // Register and lock the worktree before cancelling, so `worktree remove --force` fails.
  const result = await cancelDuringAdd(
    f,
    // The worktree directory is the second-to-last argument of `worktree add`.
    `"$REAL" "$@" >/dev/null 2>&1; for a; do dir=$last; last=$a; done; "$REAL" -C "$dir" worktree lock "$dir";`,
  );
  expect(result).toMatchObject({
    status: "interrupted",
    reason: "临时工作区建好之前已取消",
    cleanup_errors: ["Could not remove temporary worktree registration"],
  });
  expect(await f.git("worktree", "list", "--porcelain")).toContain("locked");
  await f.git("worktree", "unlock", join(f.container, "worktree"));
  await f.git("worktree", "prune");
  await f.clean();
});

test("a real checkout failure keeps its reason and registration cleanup error", async () => {
  const f = await fixture();
  const result = await runInTemporaryCheckout({
    ...f.input,
    sha: "b".repeat(40),
  });
  expect(result).toMatchObject({
    status: "failed",
    checks: [{ name: "check", status: "not_run" }],
    reason: "Temporary checkout failed",
  });
  expect(result.cleanup_errors).toContain(
    "Could not remove temporary worktree registration",
  );
  await f.clean();
});

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

test.skipIf(process.platform !== "linux")(
  "SSH connection failure returns a distinct terminal result without running locally",
  async () => {
    const f = await fixture(true);
    const output = vi.fn();
    const ready = vi.fn();
    const start = vi.fn(
      (file: string, _args: readonly string[], env: NodeJS.ProcessEnv) => {
        expect(file).toBe("ssh");
        return spawn(
          process.execPath,
          [
            "-e",
            "process.stderr.write('private SSH diagnostic'); process.exit(255)",
          ],
          { env, stdio: ["pipe", "pipe", "pipe"] },
        );
      },
    );
    const result = await runInTemporaryCheckout(
      { ...f.input, onReady: ready, onOutput: output },
      start,
    );
    expect(result).toMatchObject({
      status: "executor_unreachable",
      checks: [],
    });
    expect(JSON.stringify(result)).not.toContain("private SSH diagnostic");
    expect(start).toHaveBeenCalledTimes(1);
    expect(ready).not.toHaveBeenCalled();
    expect(output).not.toHaveBeenCalled();
    await f.clean();
  },
);

/** C-130: an executor with a host shares no disk with the host. */
async function remoteFixture() {
  const f = await fixture(true);
  const execution: AgentExecution = {
    ...(f.input.execution as AgentExecution),
    // Not the host's group: host-side Agent root checks must not run.
    gid: 2_000_001,
    machine: "cardigan-ci",
    host: "cardigan-ci",
    port: 22,
    user: "agent",
    hostKeyAlias: "cardigan-ci",
  };
  const calls: string[][] = [];
  /**
   * Operator provisioning (§12.5 C-130): empty read-only slot locks. The test
   * account owns its temporary agent root, so the fake SSH stubs exactly the
   * "lock and ancestors are not the account's" rule; runtime-herdr tests run
   * that rule unmodified.
   */
  const provision = async (...names: string[]) => {
    for (const name of names) {
      const path = join(execution.agentRoot, name);
      await writeFile(path, "", { mode: 0o444 });
      await chmod(path, 0o444);
    }
  };
  /** Fake SSH: runs the remote half locally, standing in for the executor's disk. */
  const ssh =
    (fail: (index: number) => boolean = () => false) =>
    (file: string, args: readonly string[], env: NodeJS.ProcessEnv) => {
      calls.push([file, ...args]);
      expect(file).toBe("ssh");
      expect(env).toEqual({ PATH: AGENT_PATH });
      expect(args).toEqual(
        expect.arrayContaining([
          "HostKeyAlias=cardigan-ci",
          "agent@cardigan-ci",
        ]),
      );
      const remote = fail(calls.length - 1)
        ? "exit 255"
        : (args.at(-1) ?? "")
            .replace("'node' '-e'", `${quote(process.execPath)} '-e'`)
            .replace("anchored() {", "anchored() { return 0;")
            .replace('foreign() { [ ! -O "$1" ]; }', "foreign() { :; }");
      return spawn("/bin/sh", ["-c", remote], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    };
  return {
    ...f,
    input: { ...f.input, execution },
    execution,
    calls,
    ssh,
    provision,
  };
}

test.each([true, false])(
  "orphan sweep audits only fixed records and requires the completion trailer (complete=%s)",
  async (complete) => {
    const f = await remoteFixture();
    const audit = vi.fn();
    const output =
      "untrusted raw diagnostic\norphan 10 100 SIGTERM sent\n" +
      (complete ? "sweep-complete\n" : "");
    const sweep = sweepCheckoutOrphans(
      f.execution,
      audit,
      (file, args, env) => {
        expect(file).toBe("ssh");
        expect(args).toContain("agent@cardigan-ci");
        expect(env).toEqual({ PATH: AGENT_PATH });
        return spawn(
          process.execPath,
          [
            "-e",
            `process.stdout.write(${JSON.stringify(output)}); process.stderr.write('private SSH diagnostic');`,
          ],
          { env, stdio: ["pipe", "pipe", "pipe"] },
        );
      },
    );
    if (complete) await expect(sweep).resolves.toBeUndefined();
    else await expect(sweep).rejects.toThrow("远程检查孤儿巡检失败");
    expect(audit.mock.calls).toEqual([["orphan 10 100 SIGTERM sent"]]);
  },
);

test.skipIf(process.platform !== "linux")(
  "a remote executor prepares, runs and cleans up the checkout entirely over its SSH entry",
  async () => {
    const f = await remoteFixture();
    await f.provision("merge-check-1.lock");
    let ready = false;
    const registered = vi.fn();
    const result = await runInTemporaryCheckout(
      {
        ...f.input,
        serialize: true,
        lockSlot: 1,
        onReady: () => {
          ready = true;
        },
        onRegistered: registered,
      },
      f.ssh(),
    );
    expect(result).toMatchObject({ status: "passed", cleanup_errors: [] });
    expect(ready).toBe(true);
    expect(registered).toHaveBeenCalledOnce();
    expect(registered.mock.calls[0]?.[0]).toMatchObject({
      git_layout: "checkout",
      registration_name: "worktree",
      container: { uid: process.getuid?.() },
      worktree: { uid: process.getuid?.() },
    });
    // prepare, worker, cleanup — every step on the executor.
    expect(f.calls).toHaveLength(3);
    expect(f.calls[0]?.at(-1)).toContain(quote(f.execution.agentRoot));
    expect(f.calls[1]?.at(-1)).toContain(
      quote(join(f.execution.agentRoot, "merge-check-1.lock")),
    );
    expect(f.calls[2]?.at(-1)).toContain(quote(f.container));
    const lock = await stat(join(f.execution.agentRoot, "merge-check-1.lock"));
    expect([lock.mode & 0o777, lock.size]).toEqual([0o444, 0]);
    await f.clean();
  },
);

test.skipIf(process.platform !== "linux")(
  "a worker with no handshake exits and releases its flock",
  async () => {
    const f = await fixture();
    const lock = join(f.root, "handshake.lock");
    const script = `const schedule = setTimeout; global.setTimeout = (fn, ms) => schedule(fn, ms === ${CHECKOUT_LIMITS.handshakeMs} ? 50 : ms);\n${CHECKOUT_WORKER}`;
    const child = spawn(
      "flock",
      [
        "--exclusive",
        "--no-fork",
        lock,
        process.execPath,
        "-e",
        script,
        "--",
        f.root,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    try {
      // Keep stdin open without a line, reproducing the orphaned SSH pipe.
      expect((await once(child, "close"))[0]).toBe(124);
      await expect(
        exec("flock", ["--nonblock", lock, "true"]),
      ).resolves.toMatchObject({ stderr: "" });
    } finally {
      child.kill("SIGKILL");
    }
  },
);

test.skipIf(process.platform !== "linux")(
  "a remote total timeout removes the checkout and Git registration",
  async () => {
    const f = await remoteFixture();
    await f.provision("merge-check.lock");
    const result = await runInTemporaryCheckout(
      {
        ...f.input,
        serialize: true,
        totalTimeoutMs: 500,
        checks: [{ name: "wait", run: node("setInterval(() => {}, 1000)") }],
      },
      f.ssh(),
    );
    expect(result).toMatchObject({ status: "timed_out", cleanup_errors: [] });
    await f.clean();
  },
);

test.skipIf(process.platform !== "linux")(
  "an occupied remote slot times out without starting checks or falling back",
  async () => {
    const f = await remoteFixture();
    await f.provision("merge-check.lock");
    const holder = spawn(
      "flock",
      [
        "--exclusive",
        "--no-fork",
        join(f.execution.agentRoot, "merge-check.lock"),
        process.execPath,
        "-e",
        "console.log('locked'); process.stdin.resume()",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const closed = once(holder, "close");
    try {
      await once(holder.stdout, "data");
      const onReady = vi.fn();
      const ssh = f.ssh();
      const result = await runInTemporaryCheckout(
        { ...f.input, serialize: true, onReady },
        (file, args, env) => {
          const command = args.at(-1) ?? "";
          if (command.includes("'flock'"))
            expect(command).toContain(
              `'--wait' '${CHECKOUT_LIMITS.lockWaitMs / 1000}'`,
            );
          return ssh(
            file,
            [
              ...args.slice(0, -1),
              command.replace(
                `'--wait' '${CHECKOUT_LIMITS.lockWaitMs / 1000}'`,
                "'--wait' '0.05'",
              ),
            ],
            env,
          );
        },
      );
      expect(result).toMatchObject({
        status: "executor_unreachable",
        checks: [],
        cleanup_errors: [],
      });
      expect(onReady).not.toHaveBeenCalled();
      expect(f.calls).toHaveLength(3);
      await f.clean();
    } finally {
      holder.kill("SIGKILL");
      await closed;
    }
  },
);

test.skipIf(process.platform !== "linux")(
  "a failed SSH preparation is a start failure: no worker, no host-side checkout, no local fallback",
  async () => {
    const f = await remoteFixture();
    let ready = false;
    await expect(
      runInTemporaryCheckout(
        {
          ...f.input,
          serialize: true,
          onReady: () => {
            ready = true;
          },
        },
        f.ssh(() => true),
      ),
    ).rejects.toThrow("Executor checkout preparation failed");
    expect(ready).toBe(false);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.[0]).toBe("ssh");
    expect((await readdir(f.execution.agentRoot)).sort()).toEqual(["repos"]);
    await expect(
      stat(join(f.execution.dataDir, "agent")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(f.execution.dataDir)).toEqual([]);
  },
);

test.each([
  [3, "根目录缺失、为链接或无法进入"],
  [4, "槽位锁的父目录可被执行账号替换"],
  [5, "检查容器或短别名无法独占创建"],
  [7, "槽位锁缺失或属性不安全"],
  [8, "创建后的容器路径已改变"],
  [9, "准备目录为链接或无法进入"],
  [10, "准备目录的真实路径、属主或身份不符"],
  [255, "SSH 通道失败"],
  [0, "完成标记缺失或无效"],
  [42, "命令返回未知错误"],
  [null, "命令未正常结束"],
] as const)(
  "remote preparation exit %s remains a safe start failure",
  async (code, reason) => {
    const f = await remoteFixture();
    const start = vi.fn(
      (_file: string, _args: readonly string[], env: NodeJS.ProcessEnv) =>
        spawn(
          process.execPath,
          [
            "-e",
            "process.stdout.write('private output'); process.stderr.write('Permission denied (publickey): private diagnostic'); " +
              (code === null
                ? "process.kill(process.pid, 'SIGKILL')"
                : `process.exit(${code})`),
          ],
          { env, stdio: ["pipe", "pipe", "pipe"] },
        ),
    );
    const onReady = vi.fn();
    const error = await runInTemporaryCheckout(
      { ...f.input, onReady },
      start,
    ).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ExecutorPreparationError);
    expect(error).toMatchObject({
      exitCode: code,
      summary: `远程检查准备失败：${reason}，请检查执行环境后重新检查`,
    });
    expect(start).toHaveBeenCalledTimes(1);
    expect(onReady).not.toHaveBeenCalled();
    expect(await readdir(f.execution.agentRoot)).toEqual(["repos"]);
  },
);

test.skipIf(process.platform !== "linux")(
  "a failed SSH cleanup is reported without changing a passed conclusion",
  async () => {
    const f = await remoteFixture();
    const result = await runInTemporaryCheckout(
      f.input,
      f.ssh((index) => index === 2),
    );
    expect(result.status).toBe("passed");
    expect(result.cleanup_errors).toEqual([
      "Could not remove temporary checkout container",
    ]);
    expect(f.calls).toHaveLength(3);
  },
);

test("remote executor path injection is rejected before any SSH command", async () => {
  const f = await remoteFixture();
  for (const agentRoot of [
    "/srv/agent;touch /tmp/pwn",
    "/srv/agent$(id)",
    "/srv/a'b",
    "/srv/agent/../etc",
  ])
    await expect(
      runInTemporaryCheckout(
        { ...f.input, execution: { ...f.execution, agentRoot } },
        f.ssh(),
      ),
    ).rejects.toThrow();
  for (const patch of [
    { project: "p;id" },
    { project: "../escape" },
    { attempt: "a$(id)" },
    { attempt: "../escape" },
    { lockSlot: 64, serialize: true },
  ])
    await expect(
      runInTemporaryCheckout({ ...f.input, ...patch }, f.ssh()),
    ).rejects.toThrow();
  expect(f.calls).toEqual([]);
});

test.skipIf(process.platform !== "linux")(
  "V-405: a check that unlinks the slot lock cannot let a second same-slot check run alongside it",
  async () => {
    const f = await remoteFixture();
    await f.provision("merge-check.lock");
    const lock = join(f.execution.agentRoot, "merge-check.lock"),
      unlinked = join(f.root, "unlinked"),
      release = join(f.root, "release");
    let secondReady = false;
    const first = runInTemporaryCheckout(
      {
        ...f.input,
        serialize: true,
        checks: [
          {
            name: "unlink",
            // On a correctly provisioned executor this unlink is refused;
            // here it succeeds, so the next preparation must still fail.
            run: node(
              `const fs=require('node:fs');fs.rmSync(${JSON.stringify(lock)});fs.writeFileSync(${JSON.stringify(unlinked)},'');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))clearInterval(t)},20)`,
            ),
          },
        ],
      },
      f.ssh(),
    );
    while (
      !(await stat(unlinked).then(
        () => true,
        () => false,
      ))
    )
      await new Promise((resolve) => setTimeout(resolve, 20));
    try {
      await expect(
        runInTemporaryCheckout(
          {
            ...f.input,
            attempt: "attempt-2",
            serialize: true,
            onReady: () => {
              secondReady = true;
            },
            checks: [{ name: "must-not-run", run: "exit 99" }],
          },
          f.ssh(),
        ),
      ).rejects.toThrow("Executor checkout preparation failed");
      expect(secondReady).toBe(false);
      await expect(stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await writeFile(release, "");
    }
    expect((await first).status).toBe("passed");
  },
);

test.skipIf(process.platform !== "linux").each([false, true])(
  "SSH worker failure after remote preparation stays unreachable even when cleanup fails (%s)",
  async (cleanupFails) => {
    const f = await remoteFixture();
    await f.provision("merge-check.lock");
    const ready = vi.fn();
    const result = await runInTemporaryCheckout(
      { ...f.input, serialize: true, onReady: ready },
      f.ssh((index) => index === 1 || (cleanupFails && index === 2)),
    );
    expect(result).toMatchObject({
      status: "executor_unreachable",
      checks: [],
    });
    expect(result.cleanup_errors).toEqual(
      cleanupFails ? ["Could not remove temporary checkout container"] : [],
    );
    expect(ready).not.toHaveBeenCalled();
    // Preparation, worker, and cleanup all use the selected remote SSH entry.
    expect(f.calls).toHaveLength(3);
    await expect(
      stat(join(f.execution.dataDir, "agent")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    if (!cleanupFails) await f.clean();
  },
);

test("A3: docs skips do not execute; affected paths are isolated to the selected step", async () => {
  const f = await fixture();
  const result = await runInTemporaryCheckout({
    ...f.input,
    checks: [
      { name: "test", run: "exit 1", skipReason: "docs_only" },
      {
        name: "affected",
        affectedPaths: ["packages/store", "apps/server"],
        run: 'test "$CARDIGAN_AFFECTED_PATHS" = "packages/store apps/server"',
      },
      {
        name: "full",
        affectedPaths: [],
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Shell parameter expansion.
        run: 'test "${CARDIGAN_AFFECTED_PATHS+set}" = set && test -z "$CARDIGAN_AFFECTED_PATHS"',
      },
      {
        name: "unscoped",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Shell parameter expansion.
        run: 'test "${CARDIGAN_AFFECTED_PATHS+set}" != set',
      },
      { name: "e2e", run: "exit 1", skipReason: "docs_only" },
    ],
  });
  expect(result.status).toBe("passed");
  expect(result.checks.map((c) => [c.name, c.status])).toEqual([
    ["test", "skipped"],
    ["affected", "passed"],
    ["full", "passed"],
    ["unscoped", "passed"],
    ["e2e", "skipped"],
  ]);
  expect(result.checks[0]).toEqual({
    name: "test",
    status: "skipped",
    reason: "docs_only",
  });
  await f.clean();
});

test.each([
  "../apps/web",
  "apps/web;false",
  "apps/web\npackages/store",
  "apps/web file",
])("A3: rejects unsafe affected path %j before starting", async (path) => {
  const f = await fixture(),
    start = vi.fn();
  await expect(
    runInTemporaryCheckout(
      {
        ...f.input,
        checks: [{ name: "test", run: "true", affectedPaths: [path] }],
      },
      start,
    ),
  ).rejects.toThrow("Invalid checkout scope metadata");
  expect(start).not.toHaveBeenCalled();
});
