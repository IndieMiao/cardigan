import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { completeHumanAction, recheckMerge } from "@cardigan/domain";
import { CentralRepositoryService } from "@cardigan/git-service";
import { CentralGitTransport } from "@cardigan/git-transport";
import { loadMergeGateConfig, parseMergePushConfig } from "@cardigan/host";
import { loadCommandState } from "@cardigan/mcp-server";
import { Store } from "@cardigan/store";
import { afterEach, expect, test, vi } from "vitest";
import { startControlPlane } from "./assembly.js";
import { ServerGit } from "./git.js";
import {
  acceptThroughMergeGate,
  m4Fixture,
  m4Scenario,
  mergeConfirmation,
} from "./m4-fixtures.js";
import { MergeExecutor } from "./merge-loop.js";
import { MergePushExecutor, startMergePushLoop } from "./merge-push-loop.js";
import { needsYou } from "./web/read.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
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
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
const disposers: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dispose of disposers.splice(0).reverse()) dispose();
});
async function fixture(run = "true") {
  const root = mkdtempSync(join(tmpdir(), "cg-push-loop-")),
    f = m4Fixture(),
    source = join(root, "source"),
    remote = join(root, "remote.git"),
    work = join(root, "work");
  let store = f.store,
    originalClosed = false,
    time = Date.parse(f.clock.now());
  disposers.push(() => {
    if (originalClosed) {
      store.close();
      rmSync(f.dataDir, { recursive: true, force: true });
    } else f.close();
    rmSync(root, { recursive: true, force: true });
  });
  git(root, "init", "-b", "main", source);
  writeFileSync(join(source, "base"), "base");
  git(source, "add", ".");
  git(source, "commit", "-m", "base");
  git(root, "init", "--bare", remote);
  git(root, "clone", source, work);
  f.store.setProjectRepo({
    project_id: f.project_id,
    repo_path: source,
    base_branch: "main",
  });
  writeFileSync(
    join(root, "merge-gate.yaml"),
    JSON.stringify({
      projects: {
        [f.project_id]: {
          checks: [{ name: "test", run }],
          push: { remote: pathToFileURL(remote).href },
        },
      },
    }),
    { mode: 0o600 },
  );
  const configuration = await loadMergeGateConfig({
    configDir: root,
    dataDir: f.dataDir,
    projectIds: [f.project_id],
  });
  const configured = configuration.forProject(f.project_id);
  if (configured.status !== "enabled" || !configured.push)
    throw new Error("Missing fixture config");
  const binding = new ServerGit({
    store: {
      getProject: (id) => store.getProject(id),
      listProjects: () => store.listProjects(),
    },
    dataDir: f.dataDir,
  });
  const project = binding.projectOf(f.project_id);
  if (!project) throw new Error("Missing project");
  const central = new CentralRepositoryService(
    new CentralGitTransport({ dataDir: f.dataDir }),
    { dataDir: f.dataDir },
  );
  const center = await central.ensureCentral(project),
    base = git(center, "rev-parse", "main");
  const clock = { now: () => new Date(time).toISOString() },
    errors: unknown[] = [];
  const options = () => ({
    store,
    git: binding,
    configuration,
    clock,
    onError: (error: unknown) => errors.push(error),
  });
  const merge = () =>
    new MergeExecutor({
      ...options(),
      gate: { configuration, execution: { mode: "local", dataDir: f.dataDir } },
    });
  const events = (type: string) =>
    store.uow.read((tx) =>
      loadCommandState(tx, f.project_id).events.filter((e) => e.type === type),
    );
  async function card(policy: "auto" | "confirm" = "auto", from = center) {
    const scenario = m4Scenario(f, policy);
    git(work, "fetch", from, "main");
    git(work, "checkout", "-B", `agent/${scenario.card.id}`, "FETCH_HEAD");
    writeFileSync(join(work, scenario.card.id), "feature");
    git(work, "add", ".");
    git(work, "commit", "-m", scenario.card.id);
    const sha = git(work, "rev-parse", "HEAD");
    const delivered = await acceptThroughMergeGate(f, scenario, sha);
    await central.git.fetchRefs(center, work, [
      `+${sha}:refs/cardigan/incoming/test`,
    ]);
    await central.pinDelivery(project, delivered.product.id, sha);
    return scenario;
  }
  return {
    f,
    root,
    remote,
    center,
    work,
    base,
    binding,
    configured: { ...configured, push: configured.push },
    errors,
    options,
    merge,
    events,
    card,
    push: () => new MergePushExecutor(options()),
    advance: (minutes: number) => {
      time += minutes * 60_000;
    },
    reopen: () => {
      store.close();
      originalClosed = true;
      store = Store.open({ dataDir: f.dataDir, clock });
    },
  };
}

test("real checks fail, recheck passes, confirmation merges and only the recorded result can reach a local remote", async () => {
  const c = await fixture("test -f allow"),
    scenario = await c.card("confirm");
  // The check intentionally fails; a record-less prepared candidate never pushes.
  await c.merge().tick();
  await c.push().tick();
  expect(c.events("merge_push_queued")).toHaveLength(0);
  expect(git(c.remote, "for-each-ref")).toBe("");
  // Recheck with a real command that succeeds; configuration remains host-owned.
  const config = c.configured;
  const configuration = {
    errors: [],
    forProject: () => ({ ...config, checks: [{ name: "test", run: "true" }] }),
  };
  c.f.apply((s, a, p) =>
    recheckMerge(
      { ...s, project_settings: { merge_gate_enabled: true } },
      a,
      { card_id: scenario.card.id },
      p,
    ),
  );
  const merger = new MergeExecutor({
    ...c.options(),
    gate: { configuration, execution: { mode: "local", dataDir: c.f.dataDir } },
  });
  await merger.tick();
  await c.push().tick();
  expect(c.events("merge_push_queued")).toHaveLength(0);
  const decision = mergeConfirmation(c.f, scenario.card.id);
  if (!decision) throw new Error("Missing confirmation");
  c.f.decide(decision, "merge");
  await merger.tick();
  expect(c.f.card().status).toBe("done");
  expect(c.events("merge_push_queued")).toHaveLength(1);
  const push = vi.spyOn(c.binding, "push");
  c.reopen();
  await c.push().tick();
  await c.push().tick();
  expect(push).toHaveBeenCalledTimes(1);
  expect(git(c.remote, "rev-parse", "main")).toBe(
    git(c.center, "rev-parse", "main"),
  );
  expect(c.events("merge_pushed")).toHaveLength(1);
  expect(c.errors).toEqual([]);
}, 30_000);

test("non-fast-forward blocks later pushes but not merges; a human repair releases one coalesced push", async () => {
  const c = await fixture();
  await c.card();
  await c.merge().tick();
  await c.push().tick();
  const outside = join(c.root, "outside");
  git(c.root, "clone", "-b", "main", c.remote, outside);
  writeFileSync(join(outside, "remote-only"), "remote");
  git(outside, "add", ".");
  git(outside, "commit", "-m", "remote change");
  git(outside, "push", "origin", "main");
  const remoteHead = git(c.remote, "rev-parse", "main"),
    push = vi.spyOn(c.binding, "push");
  await c.card();
  await c.merge().tick();
  await c.push().tick();
  expect(c.events("merge_push_failed")[0]?.payload).toMatchObject({
    reason: "rejected",
  });
  const action = c.f.state().human_actions.find((a) => a.status === "open");
  if (!action) throw new Error("Missing Needs You");
  expect(needsYou(c.f.state(), c.f.clock.now()).human_actions).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: action.id })]),
  );
  await c.card();
  await c.merge().tick();
  await c.push().tick();
  expect(push).toHaveBeenCalledTimes(1);
  expect(git(c.remote, "rev-parse", "main")).toBe(remoteHead);
  // A fresh delivery from the remote tip reconciles both histories in the center.
  await c.card("auto", c.remote);
  await c.merge().tick();
  c.f.apply((s, a, p) =>
    completeHumanAction(
      s,
      a,
      { human_action_id: action.id, text: "已合入远程分叉" },
      p,
    ),
  );
  await c.push().tick();
  await c.push().tick();
  expect(push).toHaveBeenCalledTimes(2);
  expect(push.mock.calls[1]?.[1].included).toHaveLength(3);
  expect(git(c.remote, "rev-parse", "main")).toBe(
    git(c.center, "rev-parse", "main"),
  );
  expect(c.f.state().cards.every((card) => card.status === "done")).toBe(true);
  expect(c.errors).toEqual([]);
}, 30_000);

test("a network failure persists backoff across Store reopen and never skips the first queued SHA", async () => {
  const c = await fixture();
  await c.card();
  await c.merge().tick();
  const first = git(c.center, "rev-parse", "main");
  await c.card();
  await c.merge().tick();
  const push = vi
    .spyOn(c.binding, "push")
    .mockResolvedValueOnce({ status: "failed", reason: "network" });
  await c.push().tick();
  c.reopen();
  await c.push().tick();
  expect(push).toHaveBeenCalledTimes(1);
  c.advance(1);
  await c.push().tick();
  expect(git(c.remote, "rev-parse", "main")).toBe(first);
  await c.push().tick();
  expect(git(c.remote, "rev-parse", "main")).toBe(
    git(c.center, "rev-parse", "main"),
  );
  expect(c.events("merge_pushed")).toHaveLength(2);
  expect(c.errors).toEqual([]);
}, 30_000);

test("stopping after remote success but before recording preserves the attempt for an idempotent restart", async () => {
  const c = await fixture();
  await c.card();
  await c.merge().tick();
  const real = c.binding.push.bind(c.binding),
    entered = Promise.withResolvers<void>();
  const push = vi
    .spyOn(c.binding, "push")
    .mockImplementationOnce(async (project, input, config, signal) => {
      const outcome = await real(project, input, config, signal);
      entered.resolve();
      await new Promise<void>((resolve) =>
        signal?.addEventListener("abort", () => resolve(), { once: true }),
      );
      return outcome;
    });
  const loop = startMergePushLoop({ ...c.options(), intervalMs: 60_000 });
  try {
    await entered.promise;
  } finally {
    await loop.loop.stop();
  }
  expect(c.events("merge_push_started")).toHaveLength(1);
  expect(c.events("merge_pushed")).toHaveLength(0);
  c.reopen();
  await c.push().tick();
  expect(push).toHaveBeenCalledTimes(2);
  expect(c.events("merge_push_started")).toHaveLength(1);
  expect(c.events("merge_pushed")).toHaveLength(1);
  expect(c.errors).toEqual([]);
}, 30_000);

test("unclassified exceptions are sanitized into a paused Needs You item", async () => {
  const c = await fixture();
  await c.card();
  await c.merge().tick();
  const push = vi
    .spyOn(c.binding, "push")
    .mockRejectedValue(new Error("sensitive fixture diagnostic"));
  await c.push().tick();
  await c.push().tick();
  expect(push).toHaveBeenCalledTimes(1);
  expect(c.events("merge_push_failed")[0]?.payload).toMatchObject({
    reason: "other",
  });
  expect(JSON.stringify(c.f.state())).not.toContain(
    "sensitive fixture diagnostic",
  );
  expect(
    c.f.state().human_actions.filter((a) => a.status === "open"),
  ).toHaveLength(1);
}, 30_000);

test("credential permission changes pause pushing as auth without reading the credential or reaching the remote", async () => {
  const c = await fixture();
  await c.card();
  await c.merge().tick();
  const keyFile = join(c.f.dataDir, "dummy-key"),
    knownHostsFile = join(c.f.dataDir, "dummy-known");
  writeFileSync(keyFile, "synthetic-secret-must-not-appear", { mode: 0o644 });
  writeFileSync(knownHostsFile, "fixture", { mode: 0o600 });
  const configuration = {
    errors: [],
    forProject: () => ({
      ...c.configured,
      push: { ...c.configured.push, keyFile, knownHostsFile },
    }),
  };
  const loop = new MergePushExecutor({ ...c.options(), configuration });
  await loop.tick();
  await loop.tick();
  expect(c.events("merge_push_failed")).toHaveLength(1);
  expect(c.events("merge_push_failed")[0]?.payload).toMatchObject({
    reason: "auth",
  });
  expect(git(c.remote, "for-each-ref")).toBe("");
  expect(JSON.stringify(c.f.state())).not.toContain(
    "synthetic-secret-must-not-appear",
  );
}, 30_000);

test("the assembled control plane owns and drains its push loop", async () => {
  const c = await fixture(),
    configuration = {
      errors: [],
      forProject: () => ({ status: "disabled" as const }),
    };
  const plane = startControlPlane({
    store: c.f.store,
    git: c.binding,
    mergeGate: {
      configuration,
      execution: { mode: "local", dataDir: c.f.dataDir },
    },
    runtime: {
      status: async () => ({ ok: true, value: { process: "gone" } }),
      wake: async () => ({ ok: true, value: { sent: true } }),
      provision: async () => {
        throw new Error("unused");
      },
      release: async () => ({ ok: true, value: undefined }),
      interrupt: async () => ({ ok: true, value: undefined }),
      resume_or_replace: async () => {
        throw new Error("unused");
      },
      human_entry: async () => ({ ok: true, value: "" }),
      async *events() {
        yield* [] as never[];
      },
    },
    snapshot: async () => ({ model: "fixture", agent_cli_version: "fixture" }),
    startRun: async () => {},
    onError: (error) => c.errors.push(error),
  });
  try {
    expect(plane.push).toBeDefined();
  } finally {
    await plane.stop();
  }
  await plane.done;
  await plane.stop();
  expect(c.errors).toEqual([]);
}, 30_000);

test("one paused project cannot block another project's push queue", async () => {
  const c = await fixture();
  await c.card();
  await c.merge().tick();
  const send = vi
    .spyOn(c.binding, "push")
    .mockResolvedValueOnce({ status: "failed", reason: "auth" });
  await c.push().tick();
  const other = m4Fixture({ project_id: "other", dataDir: c.f.dataDir });
  disposers.push(() => other.close());
  const source = c.binding.projectOf(c.f.project_id)?.source_repo;
  if (!source) throw new Error("Missing source");
  other.store.setProjectRepo({
    project_id: other.project_id,
    repo_path: source,
    base_branch: "main",
  });
  const remote = join(c.root, "other.git");
  git(c.root, "init", "--bare", remote);
  const push = await parseMergePushConfig(
    { remote: pathToFileURL(remote).href },
    c.f.dataDir,
  );
  const configuration = {
    errors: [],
    forProject: (id: string) =>
      id === other.project_id ? { ...c.configured, push } : c.configured,
  };
  const scenario = m4Scenario(other, "auto"),
    sha = git(c.work, "rev-parse", "HEAD");
  const { product } = await acceptThroughMergeGate(other, scenario, sha);
  const project = c.binding.projectOf(other.project_id);
  if (!project) throw new Error("Missing project");
  const central = new CentralRepositoryService(
    new CentralGitTransport({ dataDir: c.f.dataDir }),
    { dataDir: c.f.dataDir },
  );
  const center = await central.ensureCentral(project);
  await central.git.fetchRefs(center, c.work, [
    `+${sha}:refs/cardigan/incoming/test`,
  ]);
  await central.pinDelivery(project, product.id, sha);
  await new MergeExecutor({
    ...c.options(),
    gate: { configuration, execution: { mode: "local", dataDir: c.f.dataDir } },
  }).tick();
  await new MergePushExecutor({ ...c.options(), configuration }).tick();
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[1]?.[0].project_id).toBe(other.project_id);
  expect(git(remote, "rev-parse", "main")).toBe(
    git(center, "rev-parse", "main"),
  );
  expect(c.events("merge_push_failed")).toHaveLength(1);
  expect(c.errors).toEqual([]);
}, 30_000);
