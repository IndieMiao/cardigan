import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { AGENT_TOOLS, agentToolsRelease } from "./agent-tools.js";

// C-595 / Q-1177: run the fixed manual install steps exactly as written in
// deploy/README.md against isolated directories. Only the operator inputs are
// filled in, scp becomes a local copy and sudo / root ownership are simulated.
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const roots: string[] = [];
const temp = () => {
  const root = mkdtempSync(join(tmpdir(), "agent-tools-manual-"));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function readmeSteps() {
  const readme = readFileSync(join(repo, "deploy", "README.md"), "utf8");
  const section = readme.slice(
    readme.indexOf("## Agent 附件助手（C-595）"),
    readme.indexOf("## 安装 cardigan 命令"),
  );
  const blocks = [...section.matchAll(/```sh\n([\s\S]*?)```/gu)].map(
    (m) => m[1] as string,
  );
  expect(blocks).toHaveLength(3);
  return blocks as [string, string, string];
}

function fixture() {
  const root = temp();
  const bin = join(root, "bin");
  mkdirSync(bin);
  // Pass-through stand-in for sudo; the steps never need a password here.
  writeFileSync(join(bin, "sudo"), '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
  const tmp = join(root, "tmp");
  const home = join(root, "home");
  mkdirSync(tmp);
  mkdirSync(home);
  // A worker that predates the tools: no deploy tree, no previous tools.
  const tools = join(root, "work", "libexec", "agent-tools");
  mkdirSync(join(root, "work", "libexec"), { recursive: true });
  return { root, bin, tmp, home, tools };
}

function run(script: string, f: ReturnType<typeof fixture>) {
  return execFileSync("/bin/sh", ["-c", script], {
    cwd: f.home,
    env: {
      PATH: `${f.bin}:/usr/bin:/bin`,
      HOME: f.home,
      TMPDIR: f.tmp,
    },
    stdio: ["ignore", "pipe", "pipe"],
  }).toString();
}

function steps(f: ReturnType<typeof fixture>) {
  const release = agentToolsRelease();
  if (!release) throw new Error("release checkout unavailable");
  const [prepare, copy, install] = readmeSteps();
  const filled = prepare
    .replace(
      "<download-attachment.mjs 的期望 SHA-256>",
      release.digests["download-attachment.mjs"],
    )
    .replace(
      "<upload-evidence.mjs 的期望 SHA-256>",
      release.digests["upload-evidence.mjs"],
    )
    .replace("<工作根>/libexec/agent-tools", f.tools)
    .replace("<项目组>", String(process.getgid?.() ?? 0));
  expect(filled).not.toMatch(/<[^>]+>/u);
  const vars = filled
    .split("\n")
    .filter((line) => /^[A-Z_]+=/u.test(line))
    .join("\n");
  return {
    release,
    prepare: () => run(filled, f).trim().split("\n").at(-1) as string,
    copy: (stage: string) =>
      run(
        copy
          .replace(/^scp /mu, "cp ")
          .replaceAll("<发行目录>", repo.replace(/\/$/u, ""))
          .replace("<管理员>@<目标机>:<暂存目录>", stage),
        f,
      ),
    install: (stage: string) =>
      run(`${vars}\nstage=${stage}\n${install.replaceAll("-o root ", "")}`, f),
  };
}

test("README steps install from the controller release on a worker with no prior material, sparing same-named files", () => {
  const f = fixture();
  const operator = Buffer.from("operator-owned fixture file\n");
  for (const name of AGENT_TOOLS) writeFileSync(join(f.home, name), operator);
  const s = steps(f);
  const stage = s.prepare();
  expect(stage.startsWith(f.tmp)).toBe(true);
  s.copy(stage);
  // Copying never touched the operator's own files.
  for (const name of AGENT_TOOLS)
    expect(readFileSync(join(f.home, name))).toEqual(operator);
  s.install(stage);
  for (const name of AGENT_TOOLS) {
    expect(readFileSync(join(f.tools, name))).toEqual(s.release.files[name]);
    expect(statSync(join(f.tools, name)).mode & 0o7777).toBe(0o750);
    expect(readFileSync(join(f.home, name))).toEqual(operator);
  }
  expect(statSync(f.tools).mode & 0o7777).toBe(0o750);
  // Only this attempt's staging directory is removed.
  expect(existsSync(stage)).toBe(false);
  expect(existsSync(f.home)).toBe(true);
});

test("README steps stop on a digest mismatch, keep the evidence and succeed on a fresh retry", () => {
  const f = fixture();
  const s = steps(f);
  const failed = s.prepare();
  s.copy(failed);
  writeFileSync(join(failed, AGENT_TOOLS[1]), "tampered\n");
  expect(() => s.install(failed)).toThrow();
  expect(existsSync(f.tools)).toBe(false);
  expect(readFileSync(join(failed, AGENT_TOOLS[1]), "utf8")).toBe("tampered\n");
  // A retry restarts from step 1 with its own new staging directory.
  const retry = s.prepare();
  expect(retry).not.toBe(failed);
  s.copy(retry);
  s.install(retry);
  for (const name of AGENT_TOOLS)
    expect(readFileSync(join(f.tools, name))).toEqual(s.release.files[name]);
  expect(existsSync(retry)).toBe(false);
  expect(existsSync(failed)).toBe(true);
});

test("README steps refuse a linked tools directory", () => {
  const f = fixture();
  const elsewhere = temp();
  execFileSync("/bin/ln", ["-s", elsewhere, f.tools]);
  const s = steps(f);
  const stage = s.prepare();
  s.copy(stage);
  expect(() => s.install(stage)).toThrow();
  for (const name of AGENT_TOOLS)
    expect(existsSync(join(elsewhere, name))).toBe(false);
});
