import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  Card,
  Delivery,
  MergePlan,
  ProjectId,
  WorkItem,
} from "@cardigan/domain";
import { latestMergeCheck } from "@cardigan/domain";
import {
  CentralRepositoryService,
  type RepositoryLock,
} from "@cardigan/git-service";
import { CentralGitTransport } from "@cardigan/git-transport";
import {
  type CheckoutInput,
  type CheckoutResult,
  type ExecutionOwner,
  executionOwner,
  hostRepositoryLock,
  loadMergeGateConfig,
} from "@cardigan/host";
import { loadCommandState } from "@cardigan/mcp-server";
import { Store } from "@cardigan/store";
import type { MergeGit } from "./git.js";
import { type MergeCheckGit, MergeChecks } from "./merge-checks.js";

const PROJECT = "measurement-offline" as ProjectId;
const COMMAND = "offline:ipc-probe-v1";
const exec = promisify(execFile);
type Candidate = {
  readonly plan: MergePlan;
  readonly candidate_sha: string;
  readonly tree_sha: string;
  readonly previous_sha: string;
};
export interface MeasurementManifest {
  readonly project: string;
  readonly target: string;
  readonly command: string;
  readonly base: string;
  readonly candidates: readonly Candidate[];
}
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fullSha = (value: string) =>
  /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value);

/** Compare with the trusted, in-process allowlist, never with a user-supplied digest. */
export function validateMeasurementManifest(
  value: MeasurementManifest,
  approved: MeasurementManifest,
) {
  if (
    digest(value) !== digest(approved) ||
    value.project !== PROJECT ||
    value.target !== "offline-probe" ||
    value.command !== COMMAND ||
    !fullSha(value.base) ||
    !value.candidates.length ||
    value.candidates.some(
      (c) =>
        ![c.candidate_sha, c.tree_sha, c.previous_sha].every(fullSha) ||
        c.previous_sha !== value.base ||
        c.plan.base_branch !== "main",
    )
  )
    throw new Error(
      "Measurement manifest is not the fixed approved object list",
    );
}

/** No production publishing object is captured by these functions. */
export function refuseMeasurementPublication(
  report: (message: string) => void,
): never {
  report("Unexpected measurement publication attempt refused");
  throw new Error("Measurement publication is disabled");
}

/** The signal handlers stay attached until idle/cleanup has finished. */
export function wireMeasurementSignals(
  stop: () => void,
  source: Pick<NodeJS.Process, "on" | "removeListener"> = process,
) {
  source.on("SIGINT", stop);
  source.on("SIGTERM", stop);
  return () => {
    source.removeListener("SIGINT", stop);
    source.removeListener("SIGTERM", stop);
  };
}

/**
 * A lightweight executor: no candidate command, checkout scripts, SSH or shell.
 * Its child waits on IPC and exits on the fixed finish/stop message. Unknown
 * identity/exit deliberately leaves the promise pending, retaining capacity.
 */
export function offlineProbe(
  root: string,
  hold: boolean,
  report: (message: string) => void,
) {
  const owners: { attempt: string; owner: ExecutionOwner; exited: boolean }[] =
    [];
  const run = async (input: CheckoutInput): Promise<CheckoutResult> => {
    if (
      input.project !== PROJECT ||
      input.checks.length !== 1 ||
      input.checks[0]?.run !== COMMAND ||
      input.execution.mode !== "agent-ssh" ||
      input.execution.host !== "offline.invalid" ||
      input.execution.machine !== "offline-probe"
    )
      throw new Error("Offline probe target or command refused");
    const directory = await mkdtemp(join(root, "probe-"));
    await mkdir(join(directory, "runtime"));
    await mkdir(join(directory, "tmp"));
    return new Promise((resolve, reject) => {
      let owner: ExecutionOwner | undefined;
      let stopped = input.signal?.aborted ?? false;
      let spawnError = false;
      const child = spawn(
        process.execPath,
        [
          "-e",
          `
process.on('message', m => { if (m === 'finish' || m === 'stop') process.exit(0); });
process.on('disconnect', () => process.exit(1));
process.send('ready');`,
        ],
        {
          cwd: directory,
          // Keep the employee test limiter; never forward credentials to the probe.
          env: {
            PATH: process.env.PATH,
            NODE_OPTIONS: process.env.NODE_OPTIONS,
            XDG_RUNTIME_DIR: join(directory, "runtime"),
            TMPDIR: join(directory, "tmp"),
          },
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        },
      );
      const stop = () => {
        stopped = true;
        if (!owner) return; // Ready will observe the pending stop.
        try {
          if (executionOwner(owner.pid)?.start !== owner.start) {
            report("Probe identity unknown; occupancy and resources retained");
            return;
          }
          child.send("stop", () => {});
        } catch {
          report("Probe stop unknown; occupancy and resources retained");
        }
      };
      input.signal?.addEventListener("abort", stop, { once: true });
      child.once("error", () => {
        spawnError = true;
      });
      child.once("message", () => {
        try {
          owner =
            child.pid === undefined ? undefined : executionOwner(child.pid);
        } catch {
          /* Unknown stays pending until a verified close. */
        }
        if (!owner) {
          report("Probe identity unknown; occupancy and resources retained");
          return;
        }
        owners.push({ attempt: input.attempt ?? "", owner, exited: false });
        input.onReady?.(owner);
        report("Offline probe ready");
        if (stopped) stop();
        else if (!hold) child.send("finish", () => {});
      });
      child.once("close", async (code) => {
        try {
          if (owner && executionOwner(owner.pid)?.start === owner.start)
            throw new Error("Still alive");
          if (!owner && !spawnError) throw new Error("Unknown identity");
        } catch {
          report("Probe exit unknown; occupancy and resources retained");
          return;
        }
        input.signal?.removeEventListener("abort", stop);
        const entry = owners.find((o) => o.owner === owner);
        if (entry) entry.exited = true;
        try {
          await rm(directory, { recursive: true });
          resolve({
            status: stopped ? "interrupted" : code === 0 ? "passed" : "failed",
            checks: [
              {
                name: "probe",
                status: stopped
                  ? "interrupted"
                  : code === 0
                    ? "passed"
                    : "failed",
                exit_code: code,
              },
            ],
            cleanup_errors: [],
          });
        } catch {
          reject(new Error("Offline probe cleanup failed"));
        }
      });
    });
  };
  return { run, owners };
}

/**
 * Only an offline factory is exposed. No caller path, command, credentials,
 * real target or evidence-shaped boolean can enable production execution.
 */
export async function createOfflineMeasurement(options: {
  slots: 1 | 2 | 3;
  hold?: boolean;
  /** Trusted test seam, never supplied by the executable's arguments. */
  run?: (input: CheckoutInput) => Promise<CheckoutResult>;
  /** Host-only injection: the original lock, never a manifest path. */
  repositoryLock?: RepositoryLock;
  onNotice?: (message: string) => void;
}) {
  if (![1, 2, 3].includes(options.slots))
    throw new Error("Invalid offline slots");
  const root = await mkdtemp(join(tmpdir(), "cardigan-measurement-"));
  let store: Store | undefined;
  try {
    const dataDir = join(root, "data"),
      source = join(root, "source");
    await mkdir(dataDir, { mode: 0o700 });
    await mkdir(source);
    const git = async (path: string, ...args: string[]) =>
      (
        await exec(
          "git",
          [
            "-C",
            path,
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "user.name=Offline Probe",
            "-c",
            "user.email=offline@example.invalid",
            ...args,
          ],
          {
            env: {
              PATH: process.env.PATH,
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL: "/dev/null",
            },
          },
        )
      ).stdout.trim();
    await git(source, "init", "-q", "-b", "main");
    await writeFile(join(source, "base.txt"), "offline fixture\n");
    await git(source, "add", "base.txt");
    await git(source, "commit", "-qm", "Offline baseline");
    const base = await git(source, "rev-parse", "HEAD");
    const project = {
      project_id: PROJECT,
      source_repo: source,
      base_branch: "main",
    };
    const transport = new CentralGitTransport({ dataDir });
    const central = new CentralRepositoryService(transport, { dataDir });
    const repository = await central.ensureCentral(project);
    // This trusted injection is also the seam for the original host's lock.
    // A future real assembly MUST inject that lock, not one rooted in its new Store.
    const lock: RepositoryLock =
      options.repositoryLock ?? hostRepositoryLock(dataDir);
    const locked = <T>(work: () => Promise<T>) =>
      lock({ project_id: PROJECT, repository }, work);
    const clock = { now: () => new Date().toISOString() };
    store = Store.open({ dataDir, clock });
    const isolatedStore = store;
    store.createProject({ id: PROJECT, name: "Offline measurement" });
    const candidates: Candidate[] = [];
    // Synthetic snapshots only, in a newly-created empty Store. No production
    // approvals are imported or generated; there are no confirmation Decisions.
    for (let i = 1; i <= options.slots + 1; i++) {
      await git(source, "checkout", "-q", "--detach", base);
      await writeFile(join(source, `candidate-${i}.txt`), `offline ${i}\n`);
      await git(source, "add", `candidate-${i}.txt`);
      await git(source, "commit", "-qm", `Offline candidate ${i}`);
      const sha = await git(source, "rev-parse", "HEAD");
      await git(
        repository,
        "fetch",
        "-q",
        source,
        `${sha}:refs/cardigan/deliveries/D-${i * 2 - 1}`,
      );
      const card: Card = {
        id: `C-${i}` as Card["id"],
        project_id: PROJECT,
        title: `Offline ${i}`,
        goal: "Offline assembly only",
        acceptance_criteria: [],
        out_of_scope: [],
        related_cards: [],
        source: { kind: "quote", text: "Synthetic offline fixture" },
        repo: "offline/fixture",
        base_branch: "main",
        priority: 1,
        status: "awaiting_merge",
        template: "dev",
        merge_policy: "confirm",
        sensitive: true,
        created_by: "system",
        created_at: clock.now(),
      };
      const work: WorkItem = {
        id: `W-${i}` as WorkItem["id"],
        card_id: card.id,
        title: "Offline candidate",
        role_id: "coder",
        required: true,
        depends_on: [],
        completion_criteria: [],
        kind: "produce",
        status: "accepted",
      };
      const delivery: Delivery = {
        id: `D-${i * 2 - 1}` as Delivery["id"],
        work_item_id: work.id,
        run_id: `R-${i}` as Delivery["run_id"],
        kind: "code",
        summary: "Synthetic offline snapshot",
        subject: { kind: "git_head", value: sha },
        evidence: [],
        attachments: [],
        known_gaps: [],
        requested_verifiers: [],
        status: "accepted",
      };
      const completion: Delivery = {
        ...delivery,
        id: `D-${i * 2}` as Delivery["id"],
        kind: "card_completion",
      };
      store.uow.run((tx) => {
        tx.cards.put(PROJECT, card);
        tx.work_items.put(PROJECT, work);
        tx.deliveries.put(PROJECT, delivery);
        tx.deliveries.put(PROJECT, completion);
        tx.events.append(PROJECT, {
          id: tx.ids.nextEventId(),
          card_id: card.id,
          seq: tx.ids.nextEventSequence(PROJECT, card.id),
          type: "review_submitted",
          actor: { kind: "system", project_id: PROJECT },
          payload: { delivery_id: completion.id },
          created_at: clock.now(),
        });
      });
      const plan: MergePlan = {
        card_id: card.id,
        title: card.title,
        base_branch: "main",
        completion_id: completion.id,
        deliveries: [{ delivery_id: delivery.id, work_item_id: work.id, sha }],
      };
      const prepared = await locked(() => central.prepareMerge(project, plan));
      if (prepared.status !== "candidate")
        throw new Error("Offline candidate preparation failed");
      candidates.push({
        plan,
        candidate_sha: prepared.candidate_sha,
        tree_sha: prepared.tree_sha,
        previous_sha: base,
      });
    }
    const manifest: MeasurementManifest = {
      project: PROJECT,
      target: "offline-probe",
      command: COMMAND,
      base,
      candidates,
    };
    const approved = structuredClone(manifest);
    const messages: string[] = [];
    const report = (message: string) => {
      messages.push(message);
      options.onNotice?.(message);
    };
    const refused = async (): Promise<never> =>
      refuseMeasurementPublication(report);
    const verify = async () => {
      validateMeasurementManifest(manifest, approved);
      if ((await transport.readRef(repository, "refs/heads/main")) !== base)
        throw new Error("Measurement baseline changed");
      for (const c of manifest.candidates) {
        if (
          (await transport.treeOfCommit(repository, c.candidate_sha)) !==
            c.tree_sha ||
          !(await transport.isAncestor(repository, base, c.candidate_sha)) ||
          (await transport.readRef(
            repository,
            `refs/cardigan/candidates/${c.plan.completion_id}`,
          )) !== c.candidate_sha ||
          (await transport.readRef(
            repository,
            `refs/cardigan/deliveries/${c.plan.deliveries[0]?.delivery_id}`,
          )) !== c.plan.deliveries[0]?.sha
        )
          throw new Error("Measurement Git object binding changed");
      }
    };
    const adapter: MergeGit & MergeCheckGit = {
      projectOf: (id) => (id === PROJECT ? project : undefined),
      sync: async () =>
        locked(async () => {
          await verify();
          return "up_to_date" as const;
        }),
      baseline: async () =>
        locked(async () => {
          await verify();
          return base;
        }),
      prepare: async (p, plan) =>
        locked(async () => {
          await verify();
          const c = manifest.candidates.find(
            (c) => JSON.stringify(c.plan) === JSON.stringify(plan),
          );
          if (p !== project || !c)
            throw new Error("Unapproved measurement plan");
          return {
            status: "candidate",
            candidate_sha: c.candidate_sha,
            tree_sha: c.tree_sha,
            previous_sha: c.previous_sha,
          };
        }),
      distribute: async () => locked(verify), // Offline: nothing crosses the process/machine boundary.
      publish: refused,
      merge: refused,
      changedPaths: async () => [],
      readWorkspace: async () => [],
    };
    // Exercise the existing config parser/resolver with synthetic material only.
    for (const file of ["identity", "known_hosts"])
      await writeFile(join(dataDir, file), "offline-not-a-key\n", {
        mode: 0o600,
      });
    await writeFile(
      join(dataDir, "merge-gate.yaml"),
      `executors:
  offline-probe:
    host: offline.invalid
    user: agent
    identity_file: identity
    known_hosts_file: known_hosts
    agent_root: /offline-probe
    max_concurrent: ${options.slots}
projects:
  ${PROJECT}:
    executor: offline-probe
    checks:
      - name: probe
        run: ${COMMAND}
`,
      { mode: 0o600 },
    );
    const configuration = await loadMergeGateConfig({
      projectIds: [PROJECT],
      dataDir,
      configDir: dataDir,
      env: {},
    });
    if (configuration.errors.length)
      throw new Error("Offline configuration invalid");
    const probe = offlineProbe(root, options.hold ?? false, report);
    const execute = options.run ?? probe.run;
    const controller = new MergeChecks({
      store,
      git: adapter,
      configuration,
      execution: { mode: "local", dataDir },
      clock,
      run: async (input) => {
        const result = await execute(input);
        if (result.manual_attention) {
          report(
            "Measurement exit unknown; occupancy, Store and resources retained",
          );
          return new Promise<CheckoutResult>(() => {});
        }
        return result;
      },
      requireConfirmedExit: true,
      sweep: async () => {},
      report,
      onError: () => report("Measurement controller error"),
    });
    let stopped = false,
      settled = false,
      closed = false,
      started = false;
    return {
      root,
      store: isolatedStore,
      project,
      manifest,
      adapter,
      lock,
      repository,
      controller,
      messages,
      owners: probe.owners,
      manifestSha256: digest(manifest),
      async start() {
        if (started) throw new Error("Measurement is one-shot");
        started = true;
        try {
          if (!stopped) await controller.tick([PROJECT]);
        } finally {
          await controller.idle();
          settled = true;
        }
      },
      stop() {
        stopped = true;
        controller.stop();
      },
      async close() {
        if (!settled)
          throw new Error(
            "Measurement exit unknown; Store and resources retained",
          );
        if (closed) return;
        await locked(verify);
        const state = isolatedStore.uow.read((tx) =>
          loadCommandState(tx, PROJECT),
        );
        if (
          state.decisions.length ||
          state.events.some((e) => e.type === "card_merged")
        )
          throw new Error("Measurement publication state changed");
        const result = {
          mode: "offline-only",
          manifest,
          manifest_sha256: digest(manifest),
          checks: candidates.map((c) =>
            latestMergeCheck(
              state.events,
              c.plan.card_id,
              c.plan.completion_id,
            ),
          ),
          owners: probe.owners,
          messages,
          baseline_unchanged: true,
          resources:
            "Real 1/2/3-slot CPU/memory/disk/duration measurements not run",
        };
        await writeFile(
          join(root, "report.json"),
          JSON.stringify(result, null, 2),
          { mode: 0o600 },
        );
        isolatedStore.close();
        closed = true;
        // Keep the standalone evidence and lock inode; remove only known exited probes above.
        return result;
      },
    };
  } catch (error) {
    store?.close();
    await rm(root, { recursive: true, force: true }); // No executor has been started by the factory.
    throw error;
  }
}

export async function measurementArtifactDigest() {
  const files = [
    "merge-measurement.js",
    "merge-measurement-main.js",
    "merge-checks.js",
  ];
  return Object.fromEntries(
    await Promise.all(
      files.map(async (file) => [
        file,
        createHash("sha256")
          .update(await readFile(new URL(file, import.meta.url)))
          .digest("hex"),
      ]),
    ),
  );
}
