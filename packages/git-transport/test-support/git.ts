import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CentralRepositoryService } from "@cardigan/git-service";
import { CentralGitTransport } from "../src/central.js";

const exec = promisify(execFile);
export const git = async (cwd: string, ...args: string[]) =>
  (
    await exec(
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
      { timeout: 10000 },
    )
  ).stdout.trim();
export async function commit(cwd: string, text: string) {
  await writeFile(join(cwd, "file"), text);
  await git(cwd, "add", "file");
  await git(cwd, "commit", "-m", text);
  return git(cwd, "rev-parse", "HEAD");
}
export async function centralFixture() {
  const root = await mkdtemp(join(tmpdir(), "cg-central-")),
    source = join(root, "source"),
    dataDir = join(root, "data");
  await git(root, "init", "-b", "main", source);
  const initial = await commit(source, "initial");
  const calls: { cwd: string; args: readonly string[] }[] = [];
  const transport = new CentralGitTransport({
    dataDir,
    onCommand: (cwd, args) => calls.push({ cwd, args }),
  });
  const central = new CentralRepositoryService(transport, { dataDir });
  const project = {
    project_id: "project",
    source_repo: source,
    base_branch: "main",
  };
  return {
    root,
    source,
    dataDir,
    initial,
    calls,
    transport,
    central,
    project,
    close: () => rm(root, { recursive: true, force: true }),
  };
}
