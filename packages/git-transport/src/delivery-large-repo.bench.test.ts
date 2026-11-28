/**
 * C-847: reproducible timing of delivery verification (`prepareVerify`) on a
 * synthetic large repository. Skipped unless `CARDIGAN_LARGE_REPO_BENCH`
 * names an empty or previously prepared work directory, e.g.
 *
 *   CARDIGAN_LARGE_REPO_BENCH=$TMPDIR/large-repo \
 *     pnpm vitest run packages/git-transport/src/delivery-large-repo.bench.test.ts
 *
 * The repository is generated (no production data): incompressible binary
 * assets plus thousands of small text files and commits, a central bare
 * clone with thousands of host refs, and an Agent branch whose delivery
 * merges a far newer baseline (the shape of a late completion request).
 * Generation is reused across runs; the report lands in the work directory.
 */
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import type { Assignment, Delivery } from "@cardigan/domain";
import {
  CentralRepositoryService,
  GitDeliveryVerifier,
} from "@cardigan/git-service";
import { expect, test } from "vitest";
import { CentralGitTransport } from "./central.js";
import { LocalGitTransport } from "./index.js";

const root = process.env.CARDIGAN_LARGE_REPO_BENCH;
const run = promisify(execFile);
/** Setup Git with an identity and a budget for large checkouts. */
const git = async (cwd: string, ...args: string[]) =>
  (
    await run(
      "git",
      [
        "-C",
        cwd,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        ...args,
      ],
      { timeout: 600_000, maxBuffer: 64 << 20 },
    )
  ).stdout.trim();
const setting = (name: string, fallback: number) =>
  Number(process.env[`CARDIGAN_LARGE_REPO_${name}`] ?? fallback);
const COMMITS = setting("COMMITS", 8000);
const TEXT_FILES = setting("TEXT_FILES", 3000);
const BLOBS = setting("BLOBS", 1100);
const BLOB_KB = setting("BLOB_KB", 860);
const AHEAD = setting("AHEAD", 600);
const HOST_REFS = setting("HOST_REFS", 3000);
const RUNS = setting("RUNS", 3);
/** Split the central pack into packs of this many MiB (0 keeps one pack). */
const PACK_MB = setting("PACK_MB", 0);
const UNFILTERED = process.env.CARDIGAN_LARGE_REPO_UNFILTERED === "1";

const textBody = (path: string, revision: number) =>
  `# ${path} revision ${revision}\n${"var value = 1\n".repeat(40)}`;

/** Stream a fast-import history: one large pack, like a mirrored clone. */
async function generateSource(source: string) {
  await git(join(source, ".."), "init", "--bare", "-b", "main", source);
  const child = spawn("git", ["-C", source, "fast-import", "--quiet"], {
    stdio: ["pipe", "inherit", "inherit"],
  });
  const done = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`fast-import ${code}`)),
    );
  });
  const write = async (chunk: string | Buffer) => {
    if (!child.stdin.write(chunk))
      await new Promise((resolve) => child.stdin.once("drain", resolve));
  };
  const file = async (path: string, body: string | Buffer) => {
    const data = typeof body === "string" ? Buffer.from(body) : body;
    await write(`M 100644 inline ${path}\ndata ${data.length}\n`);
    await write(data);
    await write("\n");
  };
  const blobEvery = Math.max(1, Math.floor(COMMITS / BLOBS));
  let blob = 0;
  for (let i = 1; i <= COMMITS; i++) {
    const message = `commit ${i}`;
    await write(
      `commit refs/heads/main\nmark :${i}\ncommitter Fixture <fixture@example.invalid> ${1_700_000_000 + i * 60} +0000\ndata ${message.length}\n${message}\n`,
    );
    if (i > 1) await write(`from :${i - 1}\n`);
    if (i === 1) {
      await file("AGENTS.md", "# Agents\n\nBe careful.\n");
      for (let t = 0; t < TEXT_FILES; t++)
        await file(`src/f${t}.gd`, textBody(`src/f${t}.gd`, 0));
    } else {
      for (const step of [7, 13, 31])
        await file(
          `src/f${(i * step) % TEXT_FILES}.gd`,
          textBody(`src/f${(i * step) % TEXT_FILES}.gd`, i),
        );
    }
    if (i % blobEvery === 0 && blob < BLOBS) {
      // Every fourth asset revises an older one, like reimported art.
      const path =
        blob % 4 === 3 ? `assets/a${blob - 3}.png` : `assets/a${blob}.png`;
      await file(path, randomBytes(BLOB_KB * 1024));
      blob++;
    }
  }
  child.stdin.end();
  await done;
}

interface Timing {
  ms: number;
  calls: number;
}
/** Time each port method (outermost call only) and count Git processes. */
function instrument(transport: CentralGitTransport) {
  const methods = new Map<string, Timing>();
  const processes = new Map<string, number>();
  let depth = 0;
  const proxy = new Proxy(transport, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function" || typeof property !== "string")
        return value;
      return async (...args: unknown[]) => {
        const outer = depth === 0;
        depth++;
        const started = performance.now();
        try {
          // Emulates the code before C-847: every changed path's content.
          if (UNFILTERED && property === "fileDiffs")
            return await value.apply(target, args.slice(0, 3));
          return await value.apply(target, args);
        } finally {
          depth--;
          if (outer) {
            const entry = methods.get(property) ?? { ms: 0, calls: 0 };
            entry.ms += performance.now() - started;
            entry.calls++;
            methods.set(property, entry);
          }
        }
      };
    },
  });
  return {
    proxy,
    onCommand: (_cwd: string, args: readonly string[]) => {
      const index = args.indexOf("-C");
      const sub = args[index + 2] ?? "?";
      processes.set(sub, (processes.get(sub) ?? 0) + 1);
    },
    reset() {
      methods.clear();
      processes.clear();
    },
    report: () => ({
      methods: Object.fromEntries(
        [...methods].sort((a, b) => b[1].ms - a[1].ms),
      ),
      git_processes: Object.fromEntries(
        [...processes].sort((a, b) => b[1] - a[1]),
      ),
    }),
  };
}

test.skipIf(!root)(
  "C-847: delivery verification timing on a synthetic large repository",
  { timeout: 3_600_000 },
  async () => {
    const work = root as string;
    await mkdir(work, { recursive: true, mode: 0o700 });
    await chmod(work, 0o700);
    const source = join(work, "source.git"),
      dataDir = join(work, "data"),
      ready = join(work, "ready.json");
    let meta: {
      base: string;
      own: string;
      sha: string;
      branch: string;
      worktree: string;
    };
    let counter: ReturnType<typeof instrument> | undefined;
    const transport = new CentralGitTransport({
      dataDir,
      onCommand: (cwd, args) => counter?.onCommand(cwd, args),
    });
    counter = instrument(transport);
    const central = new CentralRepositoryService(counter.proxy, { dataDir });
    const project = {
      project_id: "bench",
      source_repo: source,
      base_branch: "main",
    };
    const setup: Record<string, number> = {};
    if (!existsSync(ready)) {
      let started = performance.now();
      await generateSource(source);
      setup.generate_ms = performance.now() - started;
      started = performance.now();
      const repository = await central.ensureCentral(project);
      setup.central_clone_ms = performance.now() - started;
      const main = await git(repository, "rev-parse", "main");
      const base = await git(repository, "rev-parse", `main~${AHEAD}`);
      // Host refs accumulated by earlier cards (candidates, prechecks, incoming).
      const history = (
        await git(repository, "rev-list", "--max-count", `${HOST_REFS}`, main)
      ).split("\n");
      const updates = history
        .map(
          (sha, i) =>
            `create refs/cardigan/${["candidates", "prechecks", "incoming"][i % 3]}/A-${i}/${sha} ${sha}\n`,
        )
        .join("");
      const updater = spawn("git", ["-C", repository, "update-ref", "--stdin"]);
      updater.stdin.end(updates);
      await new Promise((resolve) => updater.on("exit", resolve));
      const agentBase = join(dataDir, "agent", "repos", project.project_id);
      const worktree = join(dataDir, "agent", "worktrees", "bench", "A-1");
      const branch = "agent/C-1/W-1";
      const local = new LocalGitTransport();
      started = performance.now();
      await local.ensureClone(repository, agentBase);
      await local.addWorktree(agentBase, worktree, base, branch);
      setup.agent_clone_ms = performance.now() - started;
      // The author's own work: a role-rule edit, code and an asset.
      await writeFile(
        join(worktree, "AGENTS.md"),
        "# Agents\n\nBe careful and kind.\n",
      );
      await writeFile(join(worktree, "src", "own.gd"), "var own = 1\n");
      await writeFile(
        join(worktree, "assets", "own.png"),
        randomBytes(BLOB_KB * 1024),
      );
      await git(worktree, "add", "-A");
      await git(worktree, "commit", "-m", "own work");
      const own = await git(worktree, "rev-parse", "HEAD");
      // Later the author merges the far newer baseline before completing.
      await git(worktree, "merge", "--no-edit", main);
      const sha = await git(worktree, "rev-parse", "HEAD");
      meta = { base, own, sha, branch, worktree };
      await writeFile(ready, JSON.stringify({ meta, setup }, null, 2));
    } else {
      const saved = JSON.parse(
        await import("node:fs/promises").then((fs) =>
          fs.readFile(ready, "utf8"),
        ),
      ) as { meta: typeof meta };
      meta = saved.meta;
    }
    const repository = central.repositoryPath(project);
    if (PACK_MB > 0) {
      // Many packs and no commit-graph, like a long-lived center.
      await git(
        repository,
        "repack",
        "-a",
        "-d",
        `--max-pack-size=${PACK_MB}m`,
      );
      await rm(join(repository, "objects", "info", "commit-graph"), {
        force: true,
      });
      await rm(join(repository, "objects", "info", "commit-graphs"), {
        recursive: true,
        force: true,
      });
    }
    const size = await git(repository, "count-objects", "-vH");
    const commits = await git(repository, "rev-list", "--count", "main");
    const changed = (
      await git(repository, "diff-tree", "-r", "--name-only", meta.base, "main")
    )
      .split("\n")
      .filter(Boolean).length;
    const assignment: Assignment = {
      id: "A-1" as never,
      scope: "work_item",
      work_item_id: "W-1" as never,
      role_id: "coder",
      role_version: 1,
      status: "active",
      runtime_state: "not_provisioned",
      machine_id: "local",
      runtime_ref: null,
      mcp_token_id: "reserved",
      created_at: "2030-01-01T00:00:00.000Z",
      branch: meta.branch,
      worktree_path: meta.worktree,
      base_sha: meta.base,
    };
    const previous = {
      id: "D-1",
      status: "delivered",
      subject: { kind: "git_head", value: meta.own },
    } as unknown as Delivery;
    const verifier = new GitDeliveryVerifier(central, project);
    const cases: Record<string, unknown>[] = [];
    for (const [label, before] of [
      ["card_completion (no previous delivery)", undefined],
      ["product delivery (previous delivery before the merge)", previous],
    ] as const)
      for (let attempt = 0; attempt < RUNS; attempt++) {
        counter.reset();
        const started = performance.now();
        const verified = await verifier.verify(
          { kind: "git_head", value: meta.sha },
          assignment,
          before,
        );
        const total = performance.now() - started;
        expect(verified.ok, JSON.stringify(verified)).toBe(true);
        const report = counter.report();
        cases.push({
          label,
          attempt,
          total_ms: total,
          fetch_tip_ms: report.methods.fetchBranchTip?.ms ?? 0,
          file_diffs_ms: report.methods.fileDiffs?.ms ?? 0,
          ...report,
        });
      }
    const report = {
      repository: {
        commits: Number(commits),
        files_changed_since_assignment_base: changed,
        host_refs: HOST_REFS,
        pack_mb: PACK_MB,
        unfiltered_emulation: UNFILTERED,
        count_objects: size,
      },
      git: await git(work, "--version"),
      cases,
    };
    const label = process.env.CARDIGAN_LARGE_REPO_LABEL ?? "report";
    await writeFile(
      join(work, `${label}.json`),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    console.log(JSON.stringify(report, null, 2));
  },
);
