import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gitEnvironment, gitSafetyArguments } from "@cardigan/git-transport";

export interface CheckCandidate {
  sha: string;
  tree: string;
  base: string;
}
export interface CheckApproval {
  version: 1;
  project_id: string;
  target: string;
  software_sha: string;
  artifact_sha256: string;
  candidates: CheckCandidate[];
}
export interface CheckArtifact {
  software_sha: string;
  artifact_sha256: string;
}
export const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fullSha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const segment = /^[a-zA-Z0-9_][a-zA-Z0-9._-]*$/u;

/** Only the fixed host-private file is an approval source. Requests contain no object/path/command. */
export async function readCheckApproval(
  dataDir: string,
): Promise<CheckApproval> {
  const parent = await lstat(dataDir);
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== process.getuid?.() ||
    parent.mode & 0o077
  )
    throw new Error("移交配置目录不安全");
  const file = await open(
    join(dataDir, "check-handoff.json"),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== parent.uid ||
      stat.mode & 0o077 ||
      stat.size > 1048576
    )
      throw new Error("移交配置属性不安全");
    const value: CheckApproval = JSON.parse(await file.readFile("utf8"));
    if (
      !value ||
      Object.keys(value).sort().join() !==
        "artifact_sha256,candidates,project_id,software_sha,target,version" ||
      value.version !== 1 ||
      !segment.test(value.project_id) ||
      !segment.test(value.target) ||
      !fullSha.test(value.software_sha) ||
      !/^[a-f0-9]{64}$/u.test(value.artifact_sha256) ||
      !Array.isArray(value.candidates) ||
      !value.candidates.length ||
      !value.candidates.every(
        (c) =>
          c &&
          Object.keys(c).sort().join() === "base,sha,tree" &&
          [c.sha, c.tree, c.base].every(
            (s) => typeof s === "string" && fullSha.test(s),
          ),
      )
    )
      throw new Error("移交配置不符合固定对象合同");
    return value;
  } finally {
    await file.close();
  }
}

/** Digest the built executable and every workspace dependency, including store migrations. */
export async function checkArtifact(): Promise<CheckArtifact> {
  const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(join(root, directory), {
      withFileTypes: true,
    })) {
      const name = `${directory}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error("制品含链接");
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile() && /\.(?:js|json|sql)$/u.test(entry.name))
        files.push(name);
    }
  }
  for (const directory of [
    "apps/server",
    ...[
      "domain",
      "store",
      "git-service",
      "git-transport",
      "host",
      "router",
      "mcp-server",
      "runtime-herdr",
      "roles",
    ].map((p) => `packages/${p}`),
  ]) {
    await walk(`${directory}/dist`);
    files.push(`${directory}/package.json`);
  }
  await walk("packages/store/migrations");
  files.push("pnpm-lock.yaml");
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    hash.update(file);
    hash.update("\0");
    hash.update(await readFile(join(root, file)));
    hash.update("\0");
  }
  const { stdout } = await promisify(execFile)(
    "git",
    [...gitSafetyArguments, "-c", `safe.directory=${root}`, "-C", root, "rev-parse", "HEAD"],
    { env: gitEnvironment() },
  );
  const software_sha = stdout.trim();
  if (!fullSha.test(software_sha)) throw new Error("制品缺少完整软件提交");
  return { software_sha, artifact_sha256: hash.digest("hex") };
}
