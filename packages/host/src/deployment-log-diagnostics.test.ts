import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { DeploymentController } from "./deployment.js";
import { readDeploymentDiagnostics } from "./deployment-diagnostics.js";
import { NodeDeploymentDriver } from "./deployment-node.js";

const stages = ["clone", "checkout", "install", "build"] as const;
const cases = [
  { stage: "clone", exit: 1, tail: "checkout: exit 1" },
  { stage: "checkout", exit: 1, tail: "checkout: exit 1" },
  { stage: "install", exit: 1, tail: "TypeScript TS6305\ninstall: exit 1" },
  { stage: "build", exit: 1, tail: "TypeScript TS6305\nbuild: exit 1" },
  {
    stage: "install",
    exit: null,
    tail: "TypeScript TS6305\ninstall: exit unknown",
  },
  {
    stage: "build",
    exit: null,
    tail: "TypeScript TS6305\nbuild: exit unknown",
  },
  { stage: "clone", exit: "spawn", tail: "checkout: spawn_failed" },
  { stage: "install", exit: "spawn", tail: "install: spawn_failed" },
  { stage: "success", exit: 0, tail: "install: exit 0\nbuild: exit 0" },
] as const;

test.each(cases)(
  "$stage / $exit keeps command output out of persisted deployment diagnostics",
  async ({ stage, exit, tail }) => {
    const root = await mkdtemp(join(tmpdir(), "cg-deployment-log-"));
    const store = Store.open({ dataDir: root, dbPath: ":memory:" });
    const bin = join(root, "bin");
    const callsFile = join(root, "calls");
    const from = "a".repeat(40);
    const to = "b".repeat(40);
    try {
      store.createProject({ id: "cardigan" });
      await mkdir(bin);
      await mkdir(join(root, "self-deploy"));
      await writeFile(callsFile, "");
      await symlink(process.execPath, join(bin, "node"));
      // These executables only emit synthetic output and create fixture folders.
      // No Git, package manager, server or deployment supervisor is launched.
      const script = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const stage = path.basename(process.argv[1]) === 'git'
  ? (args.includes('clone') ? 'clone' : 'checkout') : args[0];
fs.appendFileSync(${JSON.stringify(callsFile)}, stage + '\\n');
if ('BUILD_TOKEN' in process.env) fs.appendFileSync(${JSON.stringify(callsFile)}, 'unexpected-credential\\n');
if (stage === 'clone') fs.mkdirSync(args.at(-1), { recursive: true });
fs.writeSync(1, 'TOKEN=sk-test-synthetic-token\\nAuthorization: Bearer synthetic-bearer\\n');
fs.writeSync(2, 'Authorization: Basic c3ludGhldGljOm9ubHk=\\nhttps://synthetic-user:synthetic-password@example.invalid/\\nPRIVATE_SETTING=synthetic-environment-value\\n/synthetic/path.ts: error TS6305: synthetic-message');
if (stage === ${JSON.stringify(stage)}) {
  if (${exit === null}) process.kill(process.pid, 'SIGTERM');
  else process.exit(${typeof exit === "number" ? exit : 0});
}
`;
      for (const file of ["git", "pnpm"]) {
        if (exit === "spawn" && file === (stage === "clone" ? "git" : "pnpm"))
          continue;
        await writeFile(join(bin, file), script, { mode: 0o700 });
      }
      const driver = new NodeDeploymentDriver({
        store,
        dataDir: root,
        config: {
          enabled: true,
          initial_release: root,
          initial_sha: from,
          build_timeout_ms: 5000,
          ready_timeout_ms: 1000,
          stop_timeout_ms: 1000,
          poll_interval_ms: 1000,
        },
        env: { PATH: bin, BUILD_TOKEN: "synthetic-parent-token" },
      });
      // Exercise the real build, audit and read paths without touching a server.
      vi.spyOn(driver, "checkServer").mockResolvedValue();
      vi.spyOn(driver, "acquire").mockResolvedValue(async () => {});
      vi.spyOn(driver, "current").mockResolvedValue({
        sha: from,
        release: root,
      });
      vi.spyOn(driver, "main").mockResolvedValue(to);
      vi.spyOn(driver, "isFastForward").mockResolvedValue(true);
      vi.spyOn(driver, "passedMergeGate").mockResolvedValue(true);
      vi.spyOn(driver, "migrationsChanged").mockResolvedValue(false);
      const stop = vi.spyOn(driver, "stop").mockResolvedValue();
      vi.spyOn(driver, "start").mockResolvedValue();
      vi.spyOn(driver, "ready").mockResolvedValue(true);
      vi.spyOn(driver, "promote").mockResolvedValue();
      vi.spyOn(driver, "refreshRoles").mockResolvedValue();
      await new DeploymentController(driver).tick();
      const diagnostics = await readDeploymentDiagnostics(store, "cardigan");
      const records = diagnostics?.records ?? [];
      const latest = records[0];
      expect(latest).toMatchObject({
        status: stage === "success" ? "deployed" : "failed",
        build: stage === "success" ? "passed" : "failed",
        summary:
          stage === "success"
            ? "中心 main 已部署，ready 和两个端口核对通过"
            : "build_failed",
      });
      expect(latest?.log_tail).toBe(tail);
      expect(stop).toHaveBeenCalledTimes(stage === "success" ? 1 : 0);
      const completedStages =
        stage === "success"
          ? stages.length
          : stages.indexOf(stage) + (exit === "spawn" ? 0 : 1);
      expect(
        (await readFile(callsFile, "utf8")).trim().split("\n").filter(Boolean),
      ).toEqual(stages.slice(0, completedStages));
      const events = store.uow.read((tx) =>
        tx.events.listAfter("cardigan", undefined, 0),
      );
      expect(
        events.filter((e) => e.type === "host_deployment_recorded"),
      ).toHaveLength(stage === "success" ? 3 : 2);
      const actions = store.uow.read((tx) => tx.human_actions.list("cardigan"));
      for (const value of [events, diagnostics, actions]) {
        const serialized = JSON.stringify(value);
        expect(serialized).not.toMatch(
          /synthetic|c3ludGhldGljOm9ubHk=|Authorization|PRIVATE_SETTING|TOKEN=/,
        );
        expect(serialized).not.toContain(root);
      }
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
