import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { fixture } from "../../../test-support/worker-capabilities.js";
import {
  resumeWorkerLog,
  sampleWorkerPaths,
  stageWorkerArtifact,
  type WorkerPathObservation,
  type WorkerPreflight,
  workerPreflight,
} from "./worker-preflight.js";

test("unknown mount, ownership, space, paths and credentials fail closed without path disclosure", () => {
  const { manifest, requirements } = fixture();
  const actual: WorkerPathObservation = {
    kind: "generated",
    path: "/fixture/work",
    realpath: "/fixture/work",
    mount: "/fixture",
    volume: "fixture-volume",
    uid: 501,
    common_dir: "/fixture/repo/.git",
    assignment: "A-1",
    sha: "a".repeat(40),
    dirty: true,
    mounted: true,
    acl_safe: true,
    free_bytes: 100,
    root_free_bytes: 100,
    project_private: true,
    lock_verified: true,
  };
  const {
    mounted: _m,
    acl_safe: _a,
    free_bytes: _f,
    root_free_bytes: _r,
    project_private: _p,
    lock_verified: _l,
    ...expected
  } = actual;
  const config: WorkerPreflight = {
    requirements,
    paths: [{ ...expected, assignment: "A-1" }],
    minimum_free_bytes: { root: 10, work: 20 },
    credentials: [
      {
        category: "harness",
        owner_role: "coder",
        credential_ref: "harness-login",
        scope: "model-use",
        available: true,
      },
    ],
  };
  expect(workerPreflight(config, manifest, [actual])).toEqual({
    ready: true,
    blockers: [],
  });
  for (const mutation of [
    { mounted: false },
    { volume: "changed" },
    { uid: 0 },
    { acl_safe: false },
    { free_bytes: 19 },
    { root_free_bytes: 9 },
    { realpath: "/another" },
    { project_private: false },
    { lock_verified: false },
  ]) {
    expect(
      workerPreflight(config, manifest, [{ ...actual, ...mutation }]),
    ).toEqual({ ready: false, blockers: ["path:0"] });
  }
  const credential = config.credentials[0];
  if (credential) credential.available = null;
  expect(workerPreflight(config, manifest, [actual]).blockers).toEqual([
    "credential:0",
  ]);
  config.minimum_free_bytes.work = Number.NaN;
  expect(workerPreflight(config, manifest, []).blockers).toContain(
    "space_thresholds",
  );
});

const native = {
  python: execFileSync("sh", ["-c", "command -v python3"], {
    encoding: "utf8",
  }).trim(),
  helper: fileURLToPath(
    new URL("../../../deploy/worker-primitives.py", import.meta.url),
  ),
  timeout_ms: 3000,
};
const git = execFileSync("sh", ["-c", "command -v git"], {
  encoding: "utf8",
}).trim();

test("real private Git path sampling checks mount/owner/ACL and never invokes repository filters", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "worker-paths-")));
  try {
    const command = (...args: string[]) =>
      execFileSync(git, ["-C", root, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    command("init");
    await writeFile(join(root, "file"), "fixture");
    command("add", "file");
    command(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "fixture",
    );
    const expected = {
      kind: "worktree" as const,
      path: root,
      realpath: root,
      mount: "/",
      volume: "sampled-below",
      uid: process.getuid?.() ?? -1,
      common_dir: join(root, ".git"),
      assignment: "A-1",
      sha: command("rev-parse", "HEAD"),
      dirty: false,
    };
    const sample = sampleWorkerPaths(native, {
      paths: [expected],
      worktree: root,
      git,
    });
    expect(sample[0]).toMatchObject({
      realpath: root,
      uid: expected.uid,
      common_dir: expected.common_dir,
      sha: expected.sha,
      dirty: false,
      acl_safe: true,
      project_private: true,
    });
    expect(sample[0]?.free_bytes).toBeGreaterThan(0);
    expect(sample[0]?.assignment).toBeNull();
    const inode = await stat(root);
    const bound = sampleWorkerPaths(native, {
      paths: [expected],
      worktree: root,
      git,
      binding: {
        assignment: "A-1",
        workspace: root,
        directories: {
          [root]: {
            kind: "worktree",
            device: String(inode.dev),
            inode: String(inode.ino),
          },
        },
      },
    });
    expect(bound[0]).toMatchObject({
      assignment: "A-1",
      mount: "/",
      common_dir: expected.common_dir,
      sha: expected.sha,
      dirty: false,
    });
    // A missing or symlinked mount is unknown, never a directory to create.
    await expect(async () =>
      sampleWorkerPaths(native, {
        paths: [{ ...expected, mount: join(root, "absent") }],
        worktree: root,
        git,
      }),
    ).rejects.toThrow("Worker observation unavailable");
    await symlink(root, join(root, "alias"));
    expect(() =>
      sampleWorkerPaths(native, {
        paths: [{ ...expected, path: join(root, "alias") }],
        worktree: root,
        git,
      }),
    ).toThrow("Worker observation unavailable");
    const signal = join(root, "filter-ran");
    command("config", "filter.fixture.clean", `touch '${signal}'`);
    await writeFile(join(root, ".gitattributes"), "file filter=fixture\n");
    expect(() =>
      sampleWorkerPaths(native, { paths: [expected], worktree: root, git }),
    ).toThrow("Worker observation unavailable");
    await expect(readFile(signal)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("small artifacts require finished writes, copy/hash/readback, and refuse changed destinations or links", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "worker-artifacts-")),
  );
  const temporary = join(root, "temporary"),
    evidence = join(root, "evidence"),
    source = join(temporary, "artifact");
  try {
    await mkdir(temporary, { mode: 0o700 });
    await mkdir(evidence, { mode: 0o700 });
    const data = Buffer.from("closed artifact");
    await writeFile(source, data);
    const input = {
      source,
      temporary_root: temporary,
      evidence_root: evidence,
      writing_complete: true,
    };
    expect(() =>
      stageWorkerArtifact(native, { ...input, writing_complete: false }),
    ).toThrow("Worker observation unavailable");
    const result = stageWorkerArtifact(native, input);
    expect(result).toEqual({
      sha256: createHash("sha256").update(data).digest("hex"),
      size: data.length,
      evidence_name: createHash("sha256").update(data).digest("hex"),
    });
    expect(await readFile(join(evidence, result.evidence_name))).toEqual(data);
    expect(stageWorkerArtifact(native, input)).toEqual(result);
    await writeFile(join(evidence, result.evidence_name), "tampered");
    expect(() => stageWorkerArtifact(native, input)).toThrow(
      "Worker observation unavailable",
    );
    await symlink(source, join(temporary, "link"));
    expect(() =>
      stageWorkerArtifact(native, {
        ...input,
        source: join(temporary, "link"),
      }),
    ).toThrow("Worker observation unavailable");
    expect(() =>
      stageWorkerArtifact(native, {
        ...input,
        temporary_root: join(dirname(root), "different"),
      }),
    ).toThrow("Worker observation unavailable");
    await writeFile(source, Buffer.alloc(10 * 1024 * 1024));
    expect(stageWorkerArtifact(native, input).size).toBe(10 * 1024 * 1024);
    await writeFile(source, Buffer.alloc(10 * 1024 * 1024 + 1));
    expect(() => stageWorkerArtifact(native, input)).toThrow(
      "Worker observation unavailable",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reconnect resumes a recorded offset only for the exact process incarnation", () => {
  const process = {
    machine: "local",
    boot: "boot",
    uid: 501,
    pid: 42,
    start: "100:1",
    process_group: 42,
    terminal: "generation",
  };
  const point = {
    assignment_id: "A-1",
    run_id: "R-1",
    phase: "running" as const,
    sha: "a".repeat(40),
    target_config_digest: "b".repeat(64),
    process,
    log_offset: 100,
    artifacts: [],
  };
  expect(resumeWorkerLog(point, process)).toBe(100);
  expect(resumeWorkerLog(point, null)).toBeNull();
  expect(resumeWorkerLog(point, { ...process, start: "101:1" })).toBeNull();
  expect(resumeWorkerLog(point, { ...process, boot: "new-boot" })).toBeNull();
});

test.skipIf(process.platform !== "linux").each([false, true])(
  "deploy report keeps unverified capabilities and missing protected locks closed without raw paths (native addon unavailable=%s)",
  async (nativeUnavailable) => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "worker-report-")),
    );
    try {
      const bin = join(root, "bin");
      await mkdir(bin, { mode: 0o700 });
      for (const [name, version] of Object.entries({
        hc: "0.1.18",
        pnpm: "11.7.0",
        harness: "1.2.3",
      }))
        await writeFile(
          join(bin, name),
          `#!/usr/bin/env node\nconsole.log(${JSON.stringify(version)});\n`,
          { mode: 0o700 },
        );
      const loader = join(bin, "unavailable-native.mjs");
      if (nativeUnavailable)
        await writeFile(
          loader,
          `import { registerHooks } from "node:module";
registerHooks({resolve(specifier, context, next) {
  if (specifier.endsWith(".node")) throw new Error("synthetic native addon load failure");
  return next(specifier, context);
}});
`,
        );
      const command = (...args: string[]) =>
        execFileSync(git, ["-C", root, ...args], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      command("init");
      command("add", "bin");
      command(
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "fixture",
      );
      const path = {
        kind: "worktree" as const,
        path: root,
        realpath: root,
        mount: "/",
        volume: "pending",
        uid: process.getuid?.() ?? -1,
        common_dir: join(root, ".git"),
        assignment: "A-1",
        sha: command("rev-parse", "HEAD"),
        dirty: false,
      };
      const observation = sampleWorkerPaths(native, {
        paths: [path],
        worktree: root,
        git,
      })[0];
      if (!observation) throw new Error("Missing fixture sample");
      path.volume = observation.volume;
      const paths = {
        node: process.execPath,
        python: native.python,
        git,
        hc: join(bin, "hc"),
        pnpm: join(bin, "pnpm"),
        harness: join(bin, "harness"),
      };
      const tools = Object.fromEntries(
        await Promise.all(
          Object.entries(paths).map(async ([id, path]) => [
            id,
            { path, resolved_path: await realpath(path) },
          ]),
        ),
      );
      const request = {
        native,
        environment: {
          path: [
            dirname(process.execPath),
            dirname(native.python),
            bin,
            "/usr/bin",
            "/bin",
          ].join(":"),
          tools,
        },
        config: {
          requirements: {
            uid: path.uid,
            os: "linux",
            arch: process.arch,
            combination: "a".repeat(64),
            harness: "harness",
            tools: { harness: { version: "1.2.3", arch: process.arch } },
            desktop: false,
          },
          paths: [path],
          minimum_free_bytes: { root: 1, work: 1 },
          credentials: [],
        },
        workspace: { worktree: root, git },
        verifications: {} as Record<string, unknown>,
      };
      const report = () => {
        let output: string;
        try {
          output = execFileSync(
            process.execPath,
            [
              ...(nativeUnavailable ? ["--import", loader] : []),
              fileURLToPath(
                new URL(
                  "../../../deploy/worker-preflight.mjs",
                  import.meta.url,
                ),
              ),
            ],
            {
              input: JSON.stringify(request),
              encoding: "utf8",
              stdio: ["pipe", "pipe", "ignore"],
              timeout: 10000,
            },
          );
        } catch (error) {
          output = String((error as { stdout: string }).stdout);
        }
        expect(output).not.toContain(root);
        return JSON.parse(output);
      };
      const first = report();
      expect(first.ready).toBe(false);
      expect(first.blockers).toContain("capability:node");
      expect(first.manifest.capabilities.node.last_verified).toBeNull();
      for (const id of Object.keys(tools))
        request.verifications[id] = {
          at: first.manifest.sampled_at,
          uid: path.uid,
          combination: first.combination,
          evidence: "synthetic-fixture",
        };
      const second = report();
      expect(second.blockers).toEqual(["path:0"]);
      expect(second.ready).toBe(false); // No administrator-protected inode was provisioned by this test.
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
