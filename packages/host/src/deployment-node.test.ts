import { type ChildProcess, execFile, spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { gitSafetyArguments } from "@cardigan/git-transport";
import { defaultRoleDefinition } from "@cardigan/roles";
import { Store } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { DeploymentController } from "./deployment.js";
import { readDeploymentDiagnostics } from "./deployment-diagnostics.js";
import { NodeDeploymentDriver } from "./deployment-node.js";
import { deploymentRolePolicyHash } from "./deployment-roles.js";
import { acquireMergeCheckCapacity } from "./merge-check-capacity.js";
import { executionOwner } from "./process-identity.js";

const exec = promisify(execFile);
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

test.runIf(process.platform === "linux")(
  "real child identity, ready ports, supervisor exclusivity and consistent SQLite backup",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cg-deployment-node-"));
    const release = join(root, "release");
    const dataDir = join(root, "data");
    await mkdir(join(release, "apps/server/dist"), { recursive: true });
    await mkdir(join(dataDir, "central"), { recursive: true });
    await chmod(release, 0o755);
    await chmod(dataDir, 0o700);
    const store = Store.open({ dataDir });
    store.createProject({ id: "cardigan" });
    const git = (args: string[], cwd = release) =>
      exec(
        "git",
        [
          ...gitSafetyArguments,
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.invalid",
          ...args,
        ],
        {
          cwd,
          env: {
            PATH: process.env.PATH,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
          },
        },
      );
    let driver: NodeDeploymentDriver | undefined;
    let unlock: (() => Promise<void>) | undefined;
    try {
      await writeFile(
        join(release, "apps/server/dist/bin.js"),
        `
      if (process.env.SYNTHETIC_STARTUP_FAILURE) {
        require('node:fs').writeSync(2, 'TOKEN=sk-synthetic-secret\\nAuthorization: Bearer synthetic-bearer\\nhttps://synthetic:credential@example.invalid/\\nPRIVATE_SETTING=synthetic-value\\nerror TS6305: synthetic-message\\n');
        process.exit(7);
      }
      const net = require('node:net');
      const ports = [process.env.CARDIGAN_MCP_PORT, process.env.CARDIGAN_WEB_PORT].map(Number);
      let ready = 0;
      const servers = ports.map(port => net.createServer().listen(port, '127.0.0.1', () => {
        if (++ready === 2) {
          process.stdout.write(JSON.stringify({ready:true,deployment_fence:process.env.OMIT_DEPLOYMENT_FENCE ? 0 : 1,
            url:'http://127.0.0.1:'+ports[0], web_url:'http://127.0.0.1:'+ports[1]}) + '\\n' + 'x'.repeat(512 * 1024) + '\\nstdout-private-secret\\n');
          process.stderr.write('stderr-private-secret\\n');
        }
      }));
      process.on('SIGTERM', () => servers.forEach(server => server.close()));
    `,
      );
      await git(["init", "-b", "main"]);
      await git(["add", "."]);
      await git(["commit", "-m", "test: initial server"]);
      const sha = (await git(["rev-parse", "HEAD"])).stdout.trim();
      await git([
        "clone",
        "--bare",
        release,
        join(dataDir, "central/cardigan.git"),
      ]);
      const bin = join(root, "bin");
      await mkdir(bin);
      await writeFile(join(bin, "hc"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      await writeFile(
        join(bin, "pnpm"),
        '#!/bin/sh\nif [ "$1" = install ]; then exit 0; fi\necho "TOKEN=private-build-secret error TS6305: private-build-secret"\nexit 1\n',
        { mode: 0o700 },
      );
      const options = {
        store,
        dataDir,
        config: {
          enabled: true,
          initial_release: release,
          initial_sha: sha,
          // Includes scheduling a real Node process on a shared CI runner.
          ready_timeout_ms: 10000,
          stop_timeout_ms: 3000,
          build_timeout_ms: 5000,
          poll_interval_ms: 1000,
          server_log_max_bytes: 512 * 1024,
          server_log_max_files: 3,
        },
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          BUILD_TOKEN: "parent-build-secret",
          CARDIGAN_HC_SESSION: "synthetic-session",
          CARDIGAN_MCP_PORT: String(await freePort()),
          CARDIGAN_WEB_PORT: String(await freePort()),
        },
      };
      driver = new NodeDeploymentDriver(options);
      unlock = await driver.initialize();
      const state = JSON.parse(
        await readFile(join(dataDir, "self-deploy/state.json"), "utf8"),
      );
      expect(executionOwner(state.process.pid)?.start).toBe(
        state.process.start,
      );
      expect(await driver.ready()).toBe(true);
      const logs = join(dataDir, "self-deploy/logs");
      await vi.waitFor(async () => {
        const contents = (
          await Promise.all(
            (
              await readdir(logs)
            ).map((name) => readFile(join(logs, name), "utf8")),
          )
        ).join("");
        expect(contents).toContain("stdout-private-secret");
        expect(contents).toContain("stderr-private-secret");
      });
      for (const name of await readdir(logs)) {
        const stat = await lstat(join(logs, name));
        expect(stat.mode & 0o777).toBe(0o600);
        expect(stat.size).toBeLessThanOrEqual(
          options.config.server_log_max_bytes,
        );
      }
      const diagnostics = await readDeploymentDiagnostics(store, "cardigan");
      expect(diagnostics).toMatchObject({
        deployed_sha: sha,
        main_sha: sha,
        commits_behind: 0,
        fast_forward: true,
      });
      expect(JSON.stringify(diagnostics)).not.toContain(root);
      expect(JSON.stringify(diagnostics)).not.toMatch(
        /private-secret|server-.*\.log/,
      );
      const audit = () =>
        store.uow.read((tx) =>
          tx.events
            .listAfter("cardigan", undefined, 0)
            .filter((e) => e.type === "host_server_log_recorded"),
        );
      expect(JSON.stringify(audit())).not.toMatch(/private-secret|self-deploy/);
      expect(
        audit().some(
          (e) => (e.payload as { status: string }).status === "opened",
        ),
      ).toBe(true);
      expect(await readDeploymentDiagnostics(store, "other")).toBeUndefined();
      await expect(
        new NodeDeploymentDriver(options).initialize(),
      ).rejects.toThrow();
      expect(executionOwner(state.process.pid)?.start).toBe(
        state.process.start,
      );
      await unlock();
      unlock = undefined;
      const check = acquireMergeCheckCapacity(
        store,
        "cardigan",
        "startup-check",
      );
      await expect(
        new NodeDeploymentDriver(options).initialize(),
      ).rejects.toThrow("Merge checks are active");
      expect(executionOwner(state.process.pid)?.start).toBe(
        state.process.start,
      );
      check();
      unlock = await new NodeDeploymentDriver(options).initialize();
      const adopted = JSON.parse(
        await readFile(join(dataDir, "self-deploy/state.json"), "utf8"),
      );
      expect(adopted.process).toEqual(state.process);
      // The real post-deployment subprocess must receive the old default's hash,
      // never a hash calculated from the project's hand-edited role.
      const nextRelease = join(root, "next-release");
      const oldPolicy = {
        ...defaultRoleDefinition("host_ops", {
          harness: "codex",
          launch_profile_ref: "fixture",
        }),
        instructions: "Previous default policy",
      };
      const newPolicy = { ...oldPolicy, instructions: "New default policy" };
      for (const [folder, policy] of [
        [release, oldPolicy],
        [nextRelease, newPolicy],
      ] as const) {
        await mkdir(join(folder, "packages/roles/dist"), { recursive: true });
        await writeFile(
          join(folder, "packages/roles/dist/index.js"),
          `exports.DEFAULT_ROLE_KINDS = { host_ops: 'standing' };
           exports.defaultRoleDefinition = () => (${JSON.stringify(policy)});`,
        );
      }
      await mkdir(join(nextRelease, "apps/cli/dist"), { recursive: true });
      await writeFile(
        join(nextRelease, "apps/cli/dist/bin.js"),
        `
        require('node:fs').writeFileSync(require('node:path').join(process.env.CARDIGAN_DATA_DIR, 'role-sync.json'),
          JSON.stringify({ changed: JSON.parse(process.env.CARDIGAN_DEPLOYMENT_CHANGED_ROLES),
            previous: JSON.parse(process.env.CARDIGAN_DEPLOYMENT_PREVIOUS_ROLES) }));`,
      );
      await driver.promote({ sha: "b".repeat(40), release: nextRelease });
      await driver.refreshRoles();
      expect(
        JSON.parse(await readFile(join(dataDir, "role-sync.json"), "utf8")),
      ).toEqual({
        changed: ["host_ops"],
        previous: { host_ops: deploymentRolePolicyHash(oldPolicy) },
      });
      await driver.promote({ sha, release });
      const failedBuild = await driver.build(sha);
      expect(failedBuild).toEqual({
        log_tail: "TypeScript TS6305\nbuild: exit 1",
      });
      expect(executionOwner(state.process.pid)?.start).toBe(
        state.process.start,
      );
      await driver.stop();
      expect(executionOwner(state.process.pid)).toBeUndefined();
      const backupName = await driver.backup();
      const backup = (await readdir(join(dataDir, "self-deploy"))).find(
        (name) => name.endsWith(".bak"),
      );
      expect(backup).toBeDefined();
      expect(backupName).toBe(backup);
      const db = new DatabaseSync(
        join(dataDir, "self-deploy", backup ?? "missing"),
        { readOnly: true },
      );
      try {
        expect(db.prepare("SELECT id FROM projects").all()).toEqual([
          { id: "cardigan" },
        ]);
      } finally {
        db.close();
      }
      await unlock();
      unlock = undefined;

      // Even an unsafe log directory cannot prevent readiness, stop or restart.
      await chmod(logs, 0o770);
      driver = new NodeDeploymentDriver(options);
      unlock = await driver.initialize();
      expect(await driver.ready()).toBe(true);
      await vi.waitFor(() =>
        expect(
          audit().filter(
            (e) => (e.payload as { status: string }).status === "failed",
          ),
        ).toHaveLength(1),
      );
      await driver.stop();
      await unlock();
      unlock = undefined;
      await chmod(logs, 0o700);

      // A deliberately tiny logging budget overflows on the ready burst;
      // both pipes must still drain and the service must remain healthy.
      driver = new NodeDeploymentDriver({
        ...options,
        config: {
          ...options.config,
          server_log_max_bytes: 16,
          server_log_max_files: 1,
        },
      });
      unlock = await driver.initialize();
      expect(await driver.ready()).toBe(true);
      await vi.waitFor(() =>
        expect(
          audit().filter(
            (e) => (e.payload as { status: string }).status === "failed",
          ),
        ).toHaveLength(2),
      );
      expect(
        audit().some(
          (e) => (e.payload as { reason?: string }).reason === "capacity",
        ),
      ).toBe(true);
      await driver.stop();
      await unlock();
      unlock = undefined;

      const unsupported = new NodeDeploymentDriver({
        ...options,
        config: { ...options.config, ready_timeout_ms: 100 },
        env: { ...options.env, OMIT_DEPLOYMENT_FENCE: "1" },
      });
      await expect(unsupported.initialize()).rejects.toThrow(
        "Initial server did not become ready",
      );
      expect(
        (await readDeploymentDiagnostics(store, "cardigan"))?.records[0],
      ).toMatchObject({
        status: "failed",
        failure_stage: "ready",
        log_tail: "ready: not_exited",
        backup_file: backupName,
      });
      expect(
        JSON.parse(
          await readFile(join(dataDir, "self-deploy/state.json"), "utf8"),
        ).process,
      ).toBeUndefined();

      const startupFailure = new NodeDeploymentDriver({
        ...options,
        env: { ...options.env, SYNTHETIC_STARTUP_FAILURE: "1" },
      });
      const ready = startupFailure.ready.bind(startupFailure);
      vi.spyOn(startupFailure, "ready").mockImplementation(async () => {
        const child = Reflect.get(startupFailure, "child") as ChildProcess;
        const closes = Reflect.get(startupFailure, "childCloses") as WeakMap<
          ChildProcess,
          Promise<void>
        >;
        const closed = closes.get(child);
        await closed;
        const exitCode = child.exitCode;
        expect(exitCode).toBe(7);
        // Model the observed kernel-exit / pending Node notification window
        // using this exact, already exited child. No live PID is signalled.
        let release!: () => void;
        closes.set(
          child,
          new Promise<void>((resolve) => {
            release = resolve;
          }),
        );
        child.exitCode = null;
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
          let finished = false;
          const waiting = ready().then((result) => {
            finished = true;
            return result;
          });
          await vi.advanceTimersByTimeAsync(
            options.config.ready_timeout_ms - 1,
          );
          expect(finished).toBe(false);
          child.exitCode = exitCode;
          release();
          expect(await waiting).toBe(false);
          expect(startupFailure.serverDiagnostics("ready")).toContain(
            "ready: exit 7",
          );

          // Pipes can remain open after exit: never extend the ready budget.
          child.exitCode = null;
          closes.set(child, new Promise<void>(() => {}));
          const bounded = ready();
          await vi.advanceTimersByTimeAsync(options.config.ready_timeout_ms);
          expect(await bounded).toBe(false);
          expect(startupFailure.serverDiagnostics("ready")).toContain(
            "ready: not_exited",
          );
        } finally {
          child.exitCode = exitCode;
          closes.set(child, closed ?? Promise.resolve());
          release();
          vi.useRealTimers();
        }
        return ready();
      });
      await expect(startupFailure.initialize()).rejects.toThrow(
        "ready: exit 7",
      );
      const failedDiagnostics = await readDeploymentDiagnostics(
        store,
        "cardigan",
      );
      expect(failedDiagnostics?.records[0]).toMatchObject({
        status: "failed",
        failure_stage: "ready",
        log_tail: "TypeScript TS6305\nready: exit 7",
      });
      expect(
        JSON.stringify([
          failedDiagnostics,
          store.uow.read((tx) => tx.human_actions.list("cardigan")),
        ]),
      ).not.toMatch(/synthetic|credential|Authorization|PRIVATE_SETTING/);

      // A nonexistent candidate cwd causes an actual spawn error; rollback must
      // retain the candidate diagnostic and the generated backup filename.
      driver = new NodeDeploymentDriver(options);
      unlock = await driver.initialize();
      vi.spyOn(driver, "main").mockResolvedValue("b".repeat(40));
      vi.spyOn(driver, "isFastForward").mockResolvedValue(true);
      vi.spyOn(driver, "passedMergeGate").mockResolvedValue(true);
      vi.spyOn(driver, "migrationsChanged").mockResolvedValue(true);
      vi.spyOn(driver, "refreshRoles").mockResolvedValue();
      vi.spyOn(driver, "build").mockResolvedValue({
        build: { sha: "b".repeat(40), release: join(root, "absent") },
        log_tail: "build: exit 0",
      });
      await new DeploymentController(driver).tick();
      const rolledBack = (await readDeploymentDiagnostics(store, "cardigan"))
        ?.records[0];
      expect(rolledBack).toMatchObject({
        status: "rolled_back",
        failure_stage: "start",
        log_tail: "start: spawn_failed",
        backup_file: expect.stringMatching(/^database-[a-f0-9-]+\.bak$/),
      });
      expect(
        store.uow.read((tx) => tx.human_actions.list("cardigan")).at(-1)
          ?.instructions,
      ).toContain(rolledBack?.backup_file);
      await driver.stop();
      await unlock();
      unlock = undefined;

      // A live unrelated PID, even with a valid start time, must never be signalled.
      const unrelated = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        { cwd: root, stdio: "ignore" },
      );
      await new Promise<void>((resolve) => unrelated.once("spawn", resolve));
      try {
        const owner = executionOwner(unrelated.pid ?? 0);
        await writeFile(
          join(dataDir, "self-deploy/state.json"),
          JSON.stringify({
            current: { sha, release },
            running: { sha, release },
            process: owner,
            ready: true,
          }),
          { mode: 0o600 },
        );
        await expect(
          new NodeDeploymentDriver(options).initialize(),
        ).rejects.toThrow("identity mismatch");
        expect(executionOwner(unrelated.pid ?? 0)).toEqual(owner);
      } finally {
        unrelated.kill("SIGTERM");
        await new Promise<void>((resolve) =>
          unrelated.once("exit", () => resolve()),
        );
      }
    } finally {
      await driver?.stop();
      await unlock?.();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  // Several independent starts plus Git, backup and confirmed process cleanup.
  60000,
);
