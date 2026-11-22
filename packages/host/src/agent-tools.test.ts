import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readMachineObservations, Store } from "@cardigan/store";
import { afterEach, expect, test } from "vitest";
import {
  AGENT_TOOLS,
  AGENT_TOOLS_CAPABILITY,
  agentToolsCapability,
  agentToolsDirectoryFor,
  agentToolsProblem,
  agentToolsRelease,
  installLocalAgentTools,
  RELEASE_UNAVAILABLE,
  readAgentToolsRelease,
  releaseAgentToolsDirectory,
  remoteAgentToolsDirectory,
} from "./agent-tools.js";
import { refreshMachineObservations } from "./machine-capabilities.js";

const roots: string[] = [];
const temp = () => {
  const root = mkdtempSync(join(tmpdir(), "agent-tools-"));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const deployTools = fileURLToPath(
  new URL("../../../deploy/agent-tools/", import.meta.url),
);
const gid = process.getgid?.() ?? 0;
const sshExecution = (agentRoot: string) =>
  ({
    mode: "agent-ssh",
    dataDir: agentRoot,
    agentRoot,
    gid,
    machine: "fixture",
    identityFile: "/fixture/key",
    knownHostsFile: "/fixture/known_hosts",
  }) as const;

const currentRelease = () => {
  const release = agentToolsRelease();
  if (!release) throw new Error("release checkout unavailable");
  return release;
};

test("the release digests are the committed deploy files", () => {
  const release = currentRelease();
  expect(release.source).toMatch(/^[0-9a-f]{40}$/u);
  for (const name of AGENT_TOOLS) {
    const bytes = readFileSync(join(deployTools, name));
    expect(release.files[name]).toEqual(bytes);
    expect(release.digests[name]).toBe(sha256(bytes));
  }
  expect(releaseAgentToolsDirectory()).toBe(deployTools);
});

test("local install leaves host-owned, read-only tools and a release record", async () => {
  const root = temp();
  const directory = await installLocalAgentTools(root, gid);
  expect(directory).toBe(join(root, "agent-tools"));
  expect(statSync(directory).mode & 0o7777).toBe(0o750);
  const release = currentRelease();
  for (const name of AGENT_TOOLS) {
    const info = statSync(join(directory, name));
    expect(info.mode & 0o7777).toBe(0o750);
    expect(info.gid).toBe(gid);
    expect(sha256(readFileSync(join(directory, name)))).toBe(
      release.digests[name],
    );
  }
  expect(
    JSON.parse(readFileSync(join(directory, "release.json"), "utf8")),
  ).toEqual({
    source_commit: release.source,
    sha256: release.digests,
  });
  // Current files are kept; tampered or loosened files are replaced atomically.
  const inode = lstatSync(join(directory, AGENT_TOOLS[0])).ino;
  writeFileSync(join(directory, AGENT_TOOLS[1]), "tampered");
  chmodSync(join(directory, AGENT_TOOLS[1]), 0o777);
  chmodSync(directory, 0o770);
  await installLocalAgentTools(root, gid);
  expect(lstatSync(join(directory, AGENT_TOOLS[0])).ino).toBe(inode);
  expect(readFileSync(join(directory, AGENT_TOOLS[1]))).toEqual(
    release.files[AGENT_TOOLS[1]],
  );
  expect(statSync(join(directory, AGENT_TOOLS[1])).mode & 0o7777).toBe(0o750);
  expect(statSync(directory).mode & 0o7777).toBe(0o750);
});

test("local install refuses a linked tools directory", async () => {
  const root = temp();
  symlinkSync(temp(), join(root, "agent-tools"));
  await expect(installLocalAgentTools(root, gid)).rejects.toThrow(
    "agent_tools_directory_unsafe",
  );
});

test("launch exposes the machine's fixed tool directory and never fails on a local refresh", async () => {
  const root = temp();
  expect(
    await agentToolsDirectoryFor({ mode: "local", dataDir: root }, false),
  ).toBe(deployTools);
  expect(await agentToolsDirectoryFor(sshExecution(root), true)).toBe(
    join(root, "libexec", "agent-tools"),
  );
  expect(await agentToolsDirectoryFor(sshExecution(root), false)).toBe(
    join(root, "agent-tools"),
  );
  expect(
    await agentToolsDirectoryFor(sshExecution(root), false, async () => {
      throw new Error("fixture");
    }),
  ).toBeUndefined();
});

function check(directory: string) {
  const command = agentToolsCapability(
    { mode: "local", dataDir: directory },
    "local",
  ).check as string[];
  expect(command[0]).toBe("node");
  return execFileSync(
    process.execPath,
    [...command.slice(1, 3), directory, ...command.slice(4)],
    {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    },
  ).toString();
}

test("the worker check verifies presence, execution and the release SHA-256", async () => {
  const root = temp();
  const directory = await installLocalAgentTools(root, gid);
  expect(check(directory)).toBe("agent-tools ok\n");
  expect(agentToolsProblem(check(directory))).toBeUndefined();

  writeFileSync(join(directory, "upload-evidence.mjs"), "changed");
  rmSync(join(directory, "download-attachment.mjs"));
  const stale = check(directory);
  expect(stale).toBe(
    "agent-tools missing:download-attachment.mjs,mismatch:upload-evidence.mjs\n",
  );
  expect(agentToolsProblem(stale)).toBe(
    "附件助手 download-attachment.mjs 缺失；附件助手 upload-evidence.mjs 与当前发布的 SHA-256 不一致",
  );
  await installLocalAgentTools(root, gid);
  chmodSync(join(directory, "download-attachment.mjs"), 0o640);
  expect(agentToolsProblem(check(directory))).toBe(
    "附件助手 download-attachment.mjs 无法执行",
  );
  expect(agentToolsProblem("Node 24.1")).toBe("附件助手检查未完成");
  expect(agentToolsProblem("agent-tools missing:../../etc")).toBe(
    "附件助手检查未完成",
  );
});

test("the check directory follows the machine's install location", () => {
  const root = temp();
  const directory = (machine: string) =>
    (agentToolsCapability(sshExecution(root), machine).check as string[])[3];
  expect(directory("local")).toBe(join(root, "agent-tools"));
  expect(directory("mac-mini")).toBe(remoteAgentToolsDirectory(root));
  expect(remoteAgentToolsDirectory(root)).toBe(
    join(root, "libexec", "agent-tools"),
  );
});

test("expected digests come from the release commit, not the checked working file", () => {
  const root = temp();
  mkdirSync(join(root, "deploy", "agent-tools"), { recursive: true });
  for (const name of AGENT_TOOLS)
    writeFileSync(
      join(root, "deploy", "agent-tools", name),
      readFileSync(join(deployTools, name)),
    );
  const git = (...args: string[]) =>
    execFileSync("/usr/bin/git", args, {
      cwd: root,
      env: {
        PATH: "/usr/bin:/bin",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    })
      .toString()
      .trim();
  git("init", "-q");
  git("add", "deploy");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "fixture",
  );
  const url = pathToFileURL(`${root}/`);
  expect(readAgentToolsRelease(url)).toMatchObject({
    source: git("rev-parse", "HEAD"),
    digests: currentRelease().digests,
  });
  const changed = join(root, "deploy", "agent-tools", AGENT_TOOLS[0]);
  writeFileSync(changed, `${readFileSync(changed, "utf8")}\n`);
  expect(readAgentToolsRelease(url)).toBeUndefined();
  git("checkout", "--", "deploy");
  rmSync(join(root, "deploy", "agent-tools", AGENT_TOOLS[1]));
  expect(readAgentToolsRelease(url)).toBeUndefined();
});

test("an unverifiable controller release is a tool failure, never an expectation", async () => {
  // Expected bytes are the committed blobs; a changed or missing working file is refused.
  const before = readAgentToolsRelease();
  expect(before?.digests).toEqual(currentRelease().digests);
  const capability = agentToolsCapability(
    { mode: "local", dataDir: temp() },
    "local",
    null,
  );
  expect(capability.acceptsOutput?.("agent-tools ok\n")).toBe(false);
  expect(capability.failureReason?.("agent-tools ok\n")).toBe(
    RELEASE_UNAVAILABLE,
  );
  expect(capability.parseVersion("agent-tools ok")).toBeNull();
  await expect(installLocalAgentTools(temp(), gid, null)).rejects.toThrow(
    "agent_tools_release_unavailable",
  );
});

test("machine check records current tools and a readable reason otherwise", async () => {
  const dataDir = temp();
  const store = Store.open({ dataDir });
  try {
    store.createProject({ id: "a" });
    const machine = store.uow.read((tx) => tx.machines.get("a", "local"));
    if (!machine) throw new Error("Missing machine");
    const observe = (output: string) =>
      refreshMachineObservations({
        store,
        project: "a",
        machine: "local",
        target: () => ({
          machine,
          execution: { mode: "local" as const, dataDir },
        }),
        check: async () => ({ blockers: [], launch_enabled: true }),
        probe: async (_execution, _os, command) =>
          Array.isArray(command) && command[1] === "-e"
            ? { ok: true, output }
            : { ok: false, output: "" },
      });
    const current = await observe("agent-tools ok\n");
    expect(current.health?.available).toBe(true);
    expect(
      current.capabilities.filter((c) => c.key === AGENT_TOOLS_CAPABILITY),
    ).toEqual([
      expect.objectContaining({
        key: AGENT_TOOLS_CAPABILITY,
        version: expect.stringMatching(/^[0-9a-f]{12}$/u),
      }),
    ]);
    const toolFailures = (observed: typeof current) =>
      (observed.health?.capability_failures ?? []).filter(
        (failure) => failure.key === AGENT_TOOLS_CAPABILITY,
      );
    expect(toolFailures(current)).toEqual([]);
    const stale = await observe(
      "agent-tools mismatch:download-attachment.mjs\n",
    );
    // Advisory: Runs that never read attachments are not blocked.
    expect(stale.health?.available).toBe(true);
    expect(stale.capabilities.map((c) => c.key)).not.toContain(
      AGENT_TOOLS_CAPABILITY,
    );
    expect(toolFailures(stale)).toEqual([
      {
        key: AGENT_TOOLS_CAPABILITY,
        search_locations: [],
        // Only one file is stale, yet both expected digests are named.
        reason: `附件助手 download-attachment.mjs 与当前发布的 SHA-256 不一致（当前发布期望 SHA-256：download-attachment.mjs ${currentRelease().digests["download-attachment.mjs"]}，upload-evidence.mjs ${currentRelease().digests["upload-evidence.mjs"]}）`,
      },
    ]);
    // C-595/Q-1177: only the reason and expected digest; no operator command,
    // neither in this result nor in the stored observation `machine show` reads.
    expect(JSON.stringify(stale)).not.toContain("sudo");
    expect(
      readMachineObservations(store, "a", "local").health?.capability_failures,
    ).toEqual(stale.health?.capability_failures);
  } finally {
    store.close();
  }
});
