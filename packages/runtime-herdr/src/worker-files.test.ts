import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { ExecutionConfig } from "./execution.js";
import {
  workerFileRequest,
  workerLaunchPath,
  workerPublishLimits,
} from "./worker-files.js";

const policy = {
  header_max_bytes: 4096,
  file_max_bytes: 2048,
  batch_max_bytes: 8192,
  timeout_ms: 2000,
};
const identity = {
  project: "fixture",
  assignment: "A-1",
  run: "R-1",
  generation: "a".repeat(32),
  target: "b".repeat(64),
};
const config: Extract<ExecutionConfig, { mode: "agent-ssh" }> = {
  mode: "agent-ssh",
  dataDir: "/host-private",
  agentRoot: "/independent-worker",
  gid: 1,
  machine: "fixture",
  identityFile: "/host-private/identity",
  knownHostsFile: "/host-private/known",
  target: {
    project_id: "fixture",
    machine_id: "worker",
    session: "fixture",
    generation: "one",
    fingerprint: identity.target,
  },
  publication: policy,
};
const remote = workerLaunchPath(config, identity).value;
const files = [
  { path: `${remote}/token`, content: "SYNTHETIC-TOKEN", mode: 0o600 },
  { path: `${remote}/launch.sh`, content: "#!/bin/sh\nexit 0\n", mode: 0o700 },
  {
    path: `${remote}/codex/config.toml`,
    content: "synthetic = true",
    mode: 0o600,
  },
];
const roots: string[] = [];
afterEach(() => {
  for (const path of roots.splice(0))
    rmSync(path, { recursive: true, force: true });
});
function disk() {
  const path = mkdtempSync(join(tmpdir(), "publication-"));
  roots.push(path);
  mkdirSync(join(path, "A-1"), { mode: 0o700 });
  return join(path, "A-1");
}
// Exercise actual openat/flock/rename on an independent synthetic disk. Only
// the administrator-installed parent namespace is substituted by a pinned FD;
// the production entry's rejection of an unprotected namespace is tested too.
const harness = `import importlib.util,json,os,sys
spec=importlib.util.spec_from_file_location('files',sys.argv[1])
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
p=m.limits(json.loads(sys.argv[3]));h=m.manifest(sys.stdin.buffer,p)
root_path=os.path.dirname(sys.argv[2])
root=os.open(root_path,m.DIRECTORY)
def check_root():
    current=os.open(root_path,m.DIRECTORY)
    try: m.require(m.inode(current)==m.inode(root))
    finally: os.close(current)
fd=m.Namespace(root,h,check_root)
try: print(json.dumps(m.operate(fd,h,sys.stdin.buffer,p)))
finally: fd.close()
`;
const helper = resolve("deploy/worker-files.py");
const args = (path: string, limits = policy) => [
  "-B",
  "-c",
  harness,
  helper,
  path,
  JSON.stringify(limits),
];
function run(path: string, input: Buffer, limits = policy) {
  return spawnSync("python3", args(path, limits), {
    input,
    encoding: "utf8",
    timeout: 4000,
  });
}
const request = (
  operation: "publish" | "commit" | "clear" | "status",
  generation = identity.generation,
) =>
  workerFileRequest(
    config,
    { ...identity, generation },
    operation,
    operation === "publish" ? files : [],
  );
const generationDir = (path: string) =>
  join(path, "generations", identity.generation);

test("Q-535 has no defaults and rejects incomplete, unknown, fractional, overflow and inconsistent limits", () => {
  expect(workerPublishLimits(policy)).toEqual(policy);
  for (const value of [
    undefined,
    null,
    {},
    [],
    { ...policy, extra: 1 },
    ...Object.keys(policy).flatMap((key) =>
      [0, -1, 1.1, Number.MAX_SAFE_INTEGER + 1, Infinity, "1", undefined].map(
        (n) => ({ ...policy, [key]: n }),
      ),
    ),
    { ...policy, file_max_bytes: policy.batch_max_bytes + 1 },
    { ...policy, timeout_ms: 2147483648 },
  ])
    expect(() => workerPublishLimits(value)).toThrow("limits invalid");
});
test("encoding is independent of host paths, counts UTF-8 bytes and never hashes credentials", () => {
  const data = request("publish");
  const line = data.subarray(0, data.indexOf(10));
  const header = JSON.parse(line.toString());
  expect(header.files.map((f: { name: string }) => f.name)).toEqual([
    "launch.sh",
    "codex/config.toml",
    "token",
  ]);
  expect(header.files.at(-1)).not.toHaveProperty("sha256");
  expect(line.toString()).not.toContain("SYNTHETIC-TOKEN");
  expect(line.toString()).not.toContain(
    createHash("sha256").update("SYNTHETIC-TOKEN").digest("hex"),
  );
  expect(() =>
    workerFileRequest(
      { ...config, publication: undefined },
      identity,
      "publish",
      files,
    ),
  ).toThrow();
  expect(() =>
    workerFileRequest(config, identity, "publish", [...files, ...files]),
  ).toThrow();
  expect(() =>
    workerFileRequest(config, identity, "publish", [
      ...files,
      { path: `${remote}/../escape`, content: "x", mode: 0o600 },
    ]),
  ).toThrow();
  expect(() =>
    workerFileRequest(
      config,
      identity,
      "publish",
      files.map((f) => ({ ...f, content: "中".repeat(1000) })),
    ),
  ).toThrow();
});
test("publish/commit/clear bind one generation; old revocation cannot alter another", () => {
  const path = disk(),
    gen = generationDir(path);
  expect(run(path, request("publish")).status).toBe(0);
  expect(existsSync(join(gen, "start"))).toBe(false);
  expect(run(path, request("commit")).status).toBe(0);
  expect(JSON.parse(readFileSync(join(gen, "start"), "utf8"))).toMatchObject(
    identity,
  );
  const newer = "c".repeat(32);
  const nextFiles = files.map((f) => ({
    ...f,
    path: f.path.replace(identity.generation, newer),
  }));
  expect(
    run(
      path,
      workerFileRequest(
        config,
        { ...identity, generation: newer },
        "publish",
        nextFiles,
      ),
    ).status,
  ).toBe(0);
  expect(run(path, request("clear")).status).toBe(0);
  expect(existsSync(join(gen, "token"))).toBe(false);
  expect(existsSync(join(path, "generations", newer, "token"))).toBe(true);
  expect(run(path, request("commit")).status).not.toBe(0);
  expect(run(path, request("publish")).status).not.toBe(0);
});
test("clear before publish leaves a durable tombstone; identity mismatch cannot reuse it", () => {
  const path = disk();
  expect(run(path, request("clear")).status).toBe(0);
  expect(run(path, request("publish")).status).not.toBe(0);
  expect(
    run(path, workerFileRequest(config, { ...identity, run: "R-2" }, "clear"))
      .status,
  ).not.toBe(0);
});
test.each([1, 10, 30])(
  "truncated publication (%s bytes) never publishes or starts and can be revoked",
  (cut) => {
    const path = disk();
    const packet = request("publish");
    expect(run(path, packet.subarray(0, packet.length - cut)).status).not.toBe(
      0,
    );
    expect(existsSync(join(generationDir(path), "published"))).toBe(false);
    expect(run(path, request("commit")).status).not.toBe(0);
    expect(run(path, request("clear")).status).toBe(0);
    expect(existsSync(join(generationDir(path), "token"))).toBe(false);
  },
);
test("receiver enforces its own byte/header/trailer limits before confirmation", () => {
  for (const limits of [
    { ...policy, header_max_bytes: 1 },
    { ...policy, file_max_bytes: 1 },
    { ...policy, batch_max_bytes: 20, file_max_bytes: 20 },
  ]) {
    const path = disk();
    expect(run(path, request("publish"), limits).status).not.toBe(0);
    expect(existsSync(join(generationDir(path), "published"))).toBe(false);
  }
  expect(
    run(disk(), Buffer.concat([request("publish"), Buffer.from("trailing")]))
      .status,
  ).not.toBe(0);
});
test("exact UTF-8 byte limits are accepted at both boundaries", () => {
  const boundedFiles = files.map((file) => ({
    ...file,
    content: "中".repeat(10),
  }));
  const byteLimits = { ...policy, file_max_bytes: 30, batch_max_bytes: 90 };
  const packet = workerFileRequest(
    { ...config, publication: byteLimits },
    identity,
    "publish",
    boundedFiles,
  );
  const exactLimits = {
    ...byteLimits,
    header_max_bytes: packet.indexOf(10) + 1,
  };
  expect(
    workerFileRequest(
      { ...config, publication: exactLimits },
      identity,
      "publish",
      boundedFiles,
    ),
  ).toEqual(packet);
  expect(run(disk(), packet, exactLimits).status).toBe(0);
  for (const limits of [
    { ...exactLimits, header_max_bytes: exactLimits.header_max_bytes - 1 },
    { ...exactLimits, file_max_bytes: 29 },
    { ...exactLimits, batch_max_bytes: 89 },
  ]) {
    expect(() =>
      workerFileRequest(
        { ...config, publication: limits },
        identity,
        "publish",
        boundedFiles,
      ),
    ).toThrow();
    expect(run(disk(), packet, limits).status).not.toBe(0);
  }
});
test.each([
  "generations",
  `generations/${identity.generation}`,
  `generations/${identity.generation}/codex`,
])("rejects a symlink at %s without touching its target", (entry) => {
  const path = disk(),
    victim = disk(),
    link = join(path, entry);
  mkdirSync(resolve(link, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(join(victim, "untouched"), "sentinel");
  symlinkSync(victim, link);
  expect(run(path, request("publish")).status).not.toBe(0);
  expect(readFileSync(join(victim, "untouched"), "utf8")).toBe("sentinel");
  expect(existsSync(join(victim, "token"))).toBe(false);
});
test.each(["symlink", "hardlink", "fifo", "directory", "mode"])(
  "rejects unsafe token destination: %s",
  (attack) => {
    const path = disk(),
      gen = generationDir(path),
      victim = join(disk(), "sentinel");
    mkdirSync(gen, { recursive: true, mode: 0o700 });
    writeFileSync(victim, "untouched", { mode: 0o600 });
    const dest = join(gen, "token");
    if (attack === "symlink") symlinkSync(victim, dest);
    else if (attack === "hardlink") linkSync(victim, dest);
    else if (attack === "fifo") spawnSync("mkfifo", [dest]);
    else if (attack === "directory") mkdirSync(dest, { mode: 0o700 });
    else {
      writeFileSync(dest, "x");
      chmodSync(dest, 0o644);
    }
    expect(run(path, request("publish")).status).not.toBe(0);
    expect(readFileSync(victim, "utf8")).toBe("untouched");
  },
);
test.each([
  "m.native.acl_safe=lambda _:False",
  "original=m.os.getuid();m.os.getuid=lambda:original+1",
  "original=m.os.getgid();m.os.getgid=lambda:original+1",
])(
  "synthetic ACL/owner/group observations reject publication: %s",
  (observation) => {
    const path = disk();
    const injected = harness.replace(
      "p=m.limits",
      `${observation}\np=m.limits`,
    );
    const result = spawnSync(
      "python3",
      ["-B", "-c", injected, helper, path, JSON.stringify(policy)],
      { input: request("publish"), timeout: 4000 },
    );
    expect(result.status).not.toBe(0);
    expect(existsSync(join(generationDir(path), "published"))).toBe(false);
  },
);
test("group-writable generation parents are rejected without repairing permissions", () => {
  const path = disk(),
    parent = join(path, "generations");
  mkdirSync(parent, { mode: 0o700 });
  chmodSync(parent, 0o770);
  expect(run(path, request("publish")).status).not.toBe(0);
  expect(existsSync(generationDir(path))).toBe(false);
});
test("production entry rejects a worker-writable parent namespace with sanitized diagnostics", () => {
  const path = disk();
  const packet = request("publish"),
    end = packet.indexOf(10);
  const header = {
    ...JSON.parse(packet.subarray(0, end).toString()),
    root: join(path, "namespace"),
  };
  mkdirSync(header.root, { mode: 0o700 });
  const result = spawnSync(
    "python3",
    ["-I", "-B", helper, JSON.stringify(policy)],
    {
      input: Buffer.concat([
        Buffer.from(`${JSON.stringify(header)}\n`),
        packet.subarray(end + 1),
      ]),
      encoding: "utf8",
      timeout: 4000,
    },
  );
  expect(result.status).not.toBe(0);
  expect(result.stderr).toBe("worker_publication_rejected\n");
  expect(result.stdout).toBe("");
});
test("two processes serialize an in-flight publication and revocation", async () => {
  const path = disk(),
    packet = request("publish");
  const publishing = spawn("python3", args(path), {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const published = new Promise<number | null>((resolve) =>
    publishing.on("close", resolve),
  );
  publishing.stdin.write(packet.subarray(0, packet.indexOf(10) + 1));
  try {
    await expect
      .poll(() => existsSync(join(generationDir(path), "receiving")))
      .toBe(true);
    const clearing = spawn("python3", args(path), {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const cleared = new Promise<number | null>((resolve) =>
      clearing.on("close", resolve),
    );
    clearing.stdin.end(request("clear"));
    publishing.stdin.end(packet.subarray(packet.indexOf(10) + 1));
    expect(await published).toBe(0);
    expect(await cleared).toBe(0);
    expect(run(path, request("commit")).status).not.toBe(0);
    expect(existsSync(join(generationDir(path), "token"))).toBe(false);
  } finally {
    publishing.kill("SIGKILL");
  }
});
test("a directory replacement after pinning cannot publish or write through the replacement link", async () => {
  const path = disk(),
    victim = disk(),
    packet = request("publish");
  const publishing = spawn("python3", args(path), {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const finished = new Promise<number | null>((resolve) =>
    publishing.on("close", resolve),
  );
  publishing.stdin.write(packet.subarray(0, packet.indexOf(10) + 1));
  try {
    await expect
      .poll(() => existsSync(join(generationDir(path), "receiving")))
      .toBe(true);
    renameSync(generationDir(path), `${generationDir(path)}-old`);
    symlinkSync(victim, generationDir(path));
    publishing.stdin.end(packet.subarray(packet.indexOf(10) + 1));
    expect(await finished).not.toBe(0);
    expect(existsSync(join(victim, "token"))).toBe(false);
    expect(existsSync(join(victim, "published"))).toBe(false);
    expect(existsSync(join(`${generationDir(path)}-old`, "published"))).toBe(
      false,
    );
  } finally {
    publishing.kill("SIGKILL");
  }
});
test.each(["assignment", "generations", "generation"])(
  "%s replacement during publish rejects the old operation and future false revocation",
  async (layer) => {
    const path = disk();
    const packet = request("publish");
    const original =
      layer === "assignment"
        ? path
        : layer === "generations"
          ? join(path, "generations")
          : generationDir(path);
    const retired = `${original}-retired`;
    const publishing = spawn("python3", args(path), {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const finished = new Promise<number | null>((resolve) =>
      publishing.on("close", resolve),
    );
    publishing.stdin.write(packet.subarray(0, packet.indexOf(10) + 1));
    try {
      await expect
        .poll(() => existsSync(join(generationDir(path), "receiving")))
        .toBe(true);
      renameSync(original, retired);
      mkdirSync(original, { mode: 0o700 });
      publishing.stdin.end(packet.subarray(packet.indexOf(10) + 1));
      expect(await finished).not.toBe(0);
      const pinned =
        layer === "assignment"
          ? generationDir(retired)
          : layer === "generations"
            ? join(retired, identity.generation)
            : retired;
      expect(existsSync(join(pinned, "published"))).toBe(false);
      expect(existsSync(join(pinned, "token"))).toBe(false);
      expect(run(path, request("clear")).status).not.toBe(0);
      expect(run(path, request("publish")).status).not.toBe(0);
      expect(existsSync(join(generationDir(path), "revoked"))).toBe(false);
      rmSync(original, { recursive: true });
      renameSync(retired, original);
      expect(run(path, request("clear")).status).toBe(0);
      expect(run(path, request("publish")).status).not.toBe(0);
    } finally {
      publishing.kill("SIGKILL");
    }
  },
);
test.each(["clear", "commit"] as const)(
  "Assignment replacement during %s cannot acknowledge a different namespace",
  async (operation) => {
    const path = disk();
    expect(run(path, request("publish")).status).toBe(0);
    const packet = request(operation);
    const child = spawn("python3", args(path), {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const finished = new Promise<number | null>((resolve) =>
      child.on("close", resolve),
    );
    child.stdin.write(packet.subarray(0, packet.indexOf(10) + 1));
    try {
      // Both operations acquire the pinned generation lock before reading trailer.
      await expect
        .poll(() => {
          const probe = spawnSync("python3", [
            "-c",
            "import fcntl,sys; f=open(sys.argv[1]); fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)",
            join(generationDir(path), ".lock"),
          ]);
          return probe.status;
        })
        .not.toBe(0);
      renameSync(path, `${path}-retired`);
      mkdirSync(path, { mode: 0o700 });
      child.stdin.end(packet.subarray(packet.indexOf(10) + 1));
      expect(await finished).not.toBe(0);
      expect(run(path, request("clear")).status).not.toBe(0);
      expect(existsSync(join(generationDir(`${path}-retired`), "start"))).toBe(
        false,
      );
      rmSync(path, { recursive: true });
      renameSync(`${path}-retired`, path);
      expect(run(path, request("clear")).status).toBe(0);
      expect(existsSync(join(generationDir(path), "token"))).toBe(false);
    } finally {
      child.kill("SIGKILL");
    }
  },
);
test("a previously published Assignment cannot be replaced between helper invocations", () => {
  const path = disk();
  expect(run(path, request("publish")).status).toBe(0);
  renameSync(path, `${path}-retired`);
  mkdirSync(path, { mode: 0o700 });
  for (const operation of ["publish", "commit", "clear", "status"] as const)
    expect(run(path, request(operation)).status).not.toBe(0);
  expect(existsSync(join(generationDir(`${path}-retired`), "token"))).toBe(
    true,
  );
  rmSync(path, { recursive: true });
  renameSync(`${path}-retired`, path);
  expect(run(path, request("clear")).status).toBe(0);
  expect(existsSync(join(generationDir(path), "token"))).toBe(false);
});
test.each(
  ["rename", "unlink"].flatMap((attack) =>
    ["header", "trailer"].map((boundary) => ({ attack, boundary })),
  ),
)(
  "replacing the generation lock by $attack at $boundary cannot split revocation from an in-flight publisher",
  async ({ attack, boundary }) => {
    const path = disk();
    const gen = generationDir(path);
    const packet = workerFileRequest(config, identity, "publish", [
      ...files,
      {
        path: `${remote}/secrets.env`,
        content: JSON.stringify({ FIXTURE_PROVIDER: "SYNTHETIC-PROVIDER" }),
        mode: 0o600,
      },
    ]);
    const publishing = spawn("python3", args(path), {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const finished = new Promise<number | null>((resolve) =>
      publishing.on("close", resolve),
    );
    const pauseAt =
      boundary === "header"
        ? packet.indexOf(10) + 1
        : packet.length - Buffer.byteLength("\nCARDIGAN-PUBLISH-1\n");
    publishing.stdin.write(packet.subarray(0, pauseAt));
    try {
      await expect
        .poll(() =>
          existsSync(
            join(gen, boundary === "header" ? "receiving" : "secrets.env"),
          ),
        )
        .toBe(true);
      if (attack === "rename")
        renameSync(join(gen, ".lock"), join(gen, ".lock-retired"));
      else rmSync(join(gen, ".lock"));
      const cleared = run(path, request("clear"));
      publishing.stdin.end(packet.subarray(pauseAt));
      const published = await finished;
      // Replacement locks cannot inherit the durable generation binding.
      // The old pinned publisher must scrub even though clear was rejected.
      expect(existsSync(join(gen, "token"))).toBe(false);
      expect(existsSync(join(gen, "secrets.env"))).toBe(false);
      expect(existsSync(join(gen, "published"))).toBe(false);
      expect(published).not.toBe(0);
      expect(cleared.status).not.toBe(0);
      expect(run(path, request("commit")).status).not.toBe(0);
      expect(existsSync(join(gen, "start"))).toBe(false);
      if (attack === "rename") {
        rmSync(join(gen, ".lock"));
        renameSync(join(gen, ".lock-retired"), join(gen, ".lock"));
        expect(run(path, request("clear")).status).toBe(0);
        expect(run(path, request("publish")).status).not.toBe(0);
      }
    } finally {
      publishing.kill("SIGKILL");
    }
  },
);
test("a replacement generation lock cannot inherit a completed publication or start its wrapper", () => {
  const path = disk();
  const gen = generationDir(path);
  expect(run(path, request("publish")).status).toBe(0);
  renameSync(join(gen, ".lock"), join(gen, ".lock-retired"));
  writeFileSync(join(gen, ".lock"), "", { mode: 0o600 });
  const runHarness = harness.replace(
    "print(json.dumps(m.operate(fd,h,sys.stdin.buffer,p)))",
    "h['root']=root_path; m.run_worker(fd,h,p)",
  );
  const worker = spawnSync(
    "python3",
    ["-B", "-c", runHarness, helper, path, JSON.stringify(policy)],
    { input: request("status"), timeout: 4000 },
  );
  expect(worker.status).toBe(1);
  expect(existsSync(join(gen, "process"))).toBe(false);
  for (const operation of ["status", "commit", "clear"] as const)
    expect(run(path, request(operation)).status).not.toBe(0);
  expect(existsSync(join(gen, "start"))).toBe(false);
  rmSync(join(gen, ".lock"));
  renameSync(join(gen, ".lock-retired"), join(gen, ".lock"));
  expect(run(path, request("clear")).status).toBe(0);
  expect(existsSync(join(gen, "token"))).toBe(false);
});
test("the receiver's explicit deadline also covers a peer withholding the header", async () => {
  const limits = { ...policy, timeout_ms: 100 };
  const receiving = spawn(
    "python3",
    ["-I", "-B", helper, JSON.stringify(limits)],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let diagnostic = "";
  receiving.stderr.on("data", (data) => {
    diagnostic += data.toString();
  });
  const finished = new Promise<number | null>((resolve) =>
    receiving.on("close", resolve),
  );
  receiving.stdin.write("{");
  try {
    expect(await finished).toBe(1);
    expect(diagnostic).toBe("worker_publication_rejected\n");
  } finally {
    receiving.kill("SIGKILL");
  }
});
test("native wrapper waits for this generation, consumes credentials once and preserves separate session state", async () => {
  const path = disk();
  const workerPolicy = {
    ...policy,
    file_max_bytes: 4096,
    batch_max_bytes: 16384,
  };
  const envelope = {
    harness: "codex",
    command: "/usr/bin/python3",
    args: [
      "-c",
      "import os,stat; from pathlib import Path; assert os.environ['MCP_TOKEN']=='SYNTHETIC-TOKEN'; assert os.environ['SYNTHETIC_PROVIDER']=='fixture-only'; base=Path.cwd(); assert Path(os.environ['TMPDIR'])==base/'temporary'; assert Path(os.environ['XDG_CACHE_HOME'])==base/'cache'; assert os.environ['TMP']==os.environ['TEMP']==os.environ['TMPDIR']; assert Path(os.environ['npm_config_store_dir'])==base/'cache/pnpm'; assert stat.S_IMODE((base/'temporary').stat().st_mode)==0o700; print('ok')",
    ],
    env: {
      CODEX_HOME: join(path, "sessions", identity.generation, "codex"),
      TMPDIR: "/shared/temporary",
      XDG_CACHE_HOME: "/shared/cache",
    },
    cwd: path,
    nice: 0,
  };
  const contents = [
    ...files,
    {
      path: `${remote}/launch.json`,
      content: JSON.stringify(envelope),
      mode: 0o600,
    },
    {
      path: `${remote}/first.md`,
      content: "Synthetic first prompt\n",
      mode: 0o600,
    },
    {
      path: `${remote}/secrets.env`,
      content: JSON.stringify({ SYNTHETIC_PROVIDER: "fixture-only" }),
      mode: 0o600,
    },
  ];
  expect(
    run(
      path,
      workerFileRequest(
        { ...config, publication: workerPolicy },
        identity,
        "publish",
        contents,
      ),
      workerPolicy,
    ).status,
  ).toBe(0);
  const runHarness = harness.replace(
    "print(json.dumps(m.operate(fd,h,sys.stdin.buffer,p)))",
    "h['root']=root_path; m.run_worker(fd,h,p)",
  );
  const child = spawn(
    "python3",
    ["-B", "-c", runHarness, helper, path, JSON.stringify(workerPolicy)],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  const finished = new Promise<number | null>((resolve) =>
    child.on("close", resolve),
  );
  child.stdin.end(request("status"));
  try {
    await expect
      .poll(() => existsSync(join(generationDir(path), "process")))
      .toBe(true);
    expect(existsSync(join(path, "sessions"))).toBe(false);
    expect(existsSync(join(generationDir(path), "token"))).toBe(true);
    expect(run(path, request("commit")).status).toBe(0);
    expect(await finished).toBe(0);
    expect(output).toBe("ok\n");
    expect(existsSync(join(generationDir(path), "token"))).toBe(false);
    expect(existsSync(join(generationDir(path), "secrets.env"))).toBe(false);
    expect(
      readFileSync(
        join(path, "sessions", identity.generation, "codex", "config.toml"),
        "utf8",
      ),
    ).toBe("synthetic = true");
    expect(JSON.parse(run(path, request("status")).stdout)).toMatchObject({
      phase: "running",
      observed: "exited",
    });
    expect(run(path, request("commit")).status).not.toBe(0);
  } finally {
    child.kill("SIGKILL");
  }
});
