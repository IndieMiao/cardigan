import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { releaseSha } from "./tick-profile.js";

export interface BuildInfo {
  readonly sha: string | null;
  readonly built_at: string | null;
  readonly development: boolean;
}

/** Resolve once at startup, from this code checkout rather than process.cwd(). */
export function readBuildInfo(
  root = join(dirname(fileURLToPath(import.meta.url)), "../../.."),
): BuildInfo {
  let sha = releaseSha(root);
  if (sha === "unknown") {
    try {
      // Git handles worktree pointers and packed refs in development checkouts.
      sha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1000,
        maxBuffer: 1024,
      }).trim();
    } catch {
      // Git is optional; never forward command output or local paths.
    }
  }
  const validSha = /^[0-9a-f]{40}$/u.test(sha) ? sha : null;
  const release = /^release-([0-9a-f]{40})-[0-9a-f-]+$/u.exec(basename(root));
  let builtAt: string | null = null;
  try {
    const entry = statSync(join(root, "apps/web/dist/index.html"));
    if (entry.isFile()) builtAt = entry.mtime.toISOString();
  } catch {
    // Source-only development has no build timestamp.
  }
  return {
    sha: validSha,
    built_at: builtAt,
    development: validSha === null || release?.[1] !== validSha,
  };
}
