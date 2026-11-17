import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { readBuildInfo } from "./build-info.js";

const roots: string[] = [];
const sha = "a".repeat(40);
const builtAt = "2026-11-16T22:56:00.000Z";
const temporary = () => {
  const root = mkdtempSync(join(tmpdir(), "cardigan-build-info-"));
  roots.push(root);
  return root;
};
const write = (root: string, path: string, content: string) => {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
};
const git = (root: string, ...args: string[]) =>
  execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test("a release reports only its verified HEAD and actual build time", () => {
  const root = join(
    temporary(),
    `release-${sha}-12345678-1234-1234-1234-123456789abc`,
  );
  write(root, ".git/HEAD", `${sha}\n`);
  const entry = write(root, "apps/web/dist/index.html", "<html></html>");
  utimesSync(entry, new Date(builtAt), new Date(builtAt));
  expect(readBuildInfo(root)).toEqual({
    sha,
    built_at: builtAt,
    development: false,
  });
  // A directory name alone cannot claim a running revision.
  write(root, ".git/HEAD", "b".repeat(40));
  expect(readBuildInfo(root).development).toBe(true);
});

test("development resolves ordinary branches, packed refs and linked worktrees", () => {
  const root = temporary();
  git(root, "init", "--initial-branch=main");
  git(
    root,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "test: initial",
  );
  const head = git(root, "rev-parse", "HEAD");
  const expected = { sha: head, built_at: null, development: true };
  expect(readBuildInfo(root)).toEqual(expected);
  git(root, "pack-refs", "--all");
  expect(readBuildInfo(root)).toEqual(expected);
  const worktree = join(temporary(), "linked");
  git(root, "worktree", "add", "--detach", worktree, head);
  expect(readBuildInfo(worktree)).toEqual(expected);
});

test("missing Git and malformed HEAD degrade without exposing local content", () => {
  const root = temporary();
  const expected = { sha: null, built_at: null, development: true };
  expect(readBuildInfo(root)).toEqual(expected);
  write(root, ".git/HEAD", "private-path-or-content");
  expect(readBuildInfo(root)).toEqual(expected);
});

test("a release without build output does not substitute startup or commit time", () => {
  const root = join(temporary(), `release-${sha}-1234`);
  write(root, ".git/HEAD", sha);
  expect(readBuildInfo(root)).toEqual({
    sha,
    built_at: null,
    development: false,
  });
});
