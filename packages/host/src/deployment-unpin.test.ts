import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Card, DeploymentBuild, Event } from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { DeploymentController } from "./deployment.js";
import { changeDeployment } from "./deployment-control.js";
import { NodeDeploymentDriver } from "./deployment-node.js";

async function fixture(sideBranch = false) {
  const root = await mkdtemp(join(tmpdir(), "cg-deploy-unpin-"));
  const dataDir = join(root, "data");
  const source = join(root, "source");
  const repository = join(dataDir, "central/cardigan.git");
  const exec = promisify(execFile);
  const git = async (cwd: string, ...args: string[]) =>
    (
      await exec("git", [
        "-C",
        cwd,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        ...args,
      ])
    ).stdout.trim();
  const store = Store.open({ dataDir });
  const human = { kind: "human", project_id: "cardigan" } as const;
  store.createProject({ id: "cardigan" });
  await chmod(dataDir, 0o700);
  await mkdir(join(dataDir, "self-deploy"), { mode: 0o700 });
  await mkdir(source);
  await git(source, "init", "-b", "main");
  const commit = async (body: string) => {
    await writeFile(join(source, "file"), body);
    await git(source, "add", ".");
    await git(source, "commit", "-m", body);
    return git(source, "rev-parse", "HEAD");
  };
  const before = await commit("before"),
    a = await commit("A");
  if (sideBranch) await git(source, "switch", "-c", "feature");
  const b = await commit("B");
  let trunk = b;
  let c: string;
  if (sideBranch) {
    await git(source, "switch", "main");
    await writeFile(join(source, "trunk"), "main advances independently");
    await git(source, "add", ".");
    await git(source, "commit", "-m", "trunk");
    trunk = await git(source, "rev-parse", "HEAD");
    await git(source, "merge", "--no-ff", "feature", "-m", "C");
    c = await git(source, "rev-parse", "HEAD");
    expect(await git(source, "rev-parse", "HEAD^1")).toBe(trunk);
    expect(await git(source, "rev-parse", "HEAD^2")).toBe(b);
    expect(
      (await git(source, "rev-list", "--first-parent", "HEAD")).split("\n"),
    ).not.toContain(b);
  } else c = await commit("C");
  await mkdir(join(dataDir, "central"), { mode: 0o700 });
  await git(root, "clone", "--bare", source, repository);
  await chmod(repository, 0o700);
  const driver = new NodeDeploymentDriver({
    store,
    dataDir,
    env: {},
    config: {
      enabled: true,
      initial_release: source,
      initial_sha: c,
      ready_timeout_ms: 1000,
      stop_timeout_ms: 1000,
      poll_interval_ms: 1000,
      build_timeout_ms: 1000,
    },
  });
  const control = (request: Parameters<typeof changeDeployment>[3]) =>
    changeDeployment(store, dataDir, human, request);
  const append = (
    type: string,
    payload: Event["payload"],
    actor: Event["actor"] = human,
    card?: Card,
  ) =>
    store.uow.run((tx) => {
      if (card) tx.cards.put("cardigan", card);
      tx.events.append("cardigan", {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence("cardigan", card?.id),
        ...(card ? { card_id: card.id } : {}),
        type,
        payload,
        actor,
        created_at: new Date().toISOString(),
      });
    });
  let certification = 0;
  const certify = async (
    kind: "adopt" | "merge",
    from: string,
    to: string,
    proof: { tree?: string; actor?: Event["actor"]; checked?: boolean } = {},
  ) => {
    if (kind === "adopt")
      return control({
        action: "adopt",
        from,
        to,
        reason: "Reviewed interval",
      });
    const completion = `D-${++certification}`;
    const card: Card = {
      id: `C-${certification}`,
      project_id: "cardigan",
      title: "Merged fixture",
      goal: "Deployment evidence",
      acceptance_criteria: ["Passed"],
      source: { kind: "quote", text: "Test" },
      out_of_scope: [],
      related_cards: [],
      priority: 1,
      status: "done",
      template: "dev",
      merge_policy: "confirm",
      created_by: "human",
      created_at: new Date().toISOString(),
    };
    const tree =
      proof.tree ?? (await git(repository, "rev-parse", `${to}^{tree}`));
    const system = { kind: "system", project_id: "cardigan" } as const;
    if (proof.checked !== false)
      append(
        "merge_check_finished",
        { completion_id: completion, tree_sha: tree, status: "passed" },
        system,
        card,
      );
    append(
      "card_merged",
      {
        completion_id: completion,
        result: {
          kind: "merged",
          previous_sha: from,
          merge_sha: to,
          tree_sha: tree,
        },
      },
      proof.actor ?? system,
      card,
    );
  };
  let current: DeploymentBuild = { sha: c, release: source };
  vi.spyOn(driver, "checkServer").mockResolvedValue();
  vi.spyOn(driver, "current").mockImplementation(async () => current);
  const build = vi.spyOn(driver, "build").mockImplementation(async (sha) => ({
    build: { sha, release: source },
    log_tail: "",
  }));
  vi.spyOn(driver, "migrationsChanged").mockResolvedValue(false);
  vi.spyOn(driver, "stop").mockResolvedValue();
  vi.spyOn(driver, "start").mockResolvedValue();
  vi.spyOn(driver, "ready").mockResolvedValue(true);
  vi.spyOn(driver, "promote").mockImplementation(async (value) => {
    current = value;
  });
  vi.spyOn(driver, "refreshRoles").mockResolvedValue();
  return {
    a,
    b,
    c,
    trunk,
    before,
    driver,
    control,
    certify,
    append,
    build,
    controller: new DeploymentController(driver),
    async advance() {
      const sha = await commit("uncertified suffix");
      await git(repository, "fetch", source, "main:main");
      return sha;
    },
    async close() {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test.each([
  { kind: "adopt", sideBranch: false, prefix: undefined },
  { kind: "merge", sideBranch: false, prefix: undefined },
  { kind: "adopt", sideBranch: true, prefix: undefined },
  { kind: "merge", sideBranch: true, prefix: "merge" },
  { kind: "adopt", sideBranch: true, prefix: "adopt" },
  { kind: "adopt", sideBranch: true, prefix: "merge" },
  { kind: "merge", sideBranch: true, prefix: "adopt" },
] as const)(
  "unpin resumes inside a certified $kind interval (side branch=$sideBranch, prefix=$prefix) but still blocks an uncertified suffix",
  async ({ kind, sideBranch, prefix }) => {
    const f = await fixture(sideBranch);
    try {
      // System merges record main immediately before the merge, not the
      // common ancestor of main and the feature branch.
      if (prefix) {
        await f.certify(prefix, f.a, f.trunk);
        await f.certify(kind, f.trunk, f.c);
      } else await f.certify(kind, f.a, f.c);
      expect(await f.driver.passedMergeGate(f.a, f.c)).toBe(true);
      await f.control({
        action: "pin",
        sha: f.b,
        reason: "Use intermediate version",
      });
      await f.controller.tick();
      expect((await f.driver.current()).sha).toBe(f.b);
      await f.control({ action: "unpin", reason: "Resume certified main" });
      expect(await f.driver.target()).toEqual({ sha: f.c });
      expect(await f.driver.passedMergeGate(f.b, f.c)).toBe(true);
      await f.controller.tick();
      expect((await f.driver.current()).sha).toBe(f.c);
      expect(f.build).toHaveBeenCalledTimes(2);
      // A prior gap and a genuinely new suffix still need their own evidence.
      expect(await f.driver.passedMergeGate(f.before, f.c)).toBe(false);
      const d = await f.advance();
      expect(await f.driver.passedMergeGate(f.b, d)).toBe(false);
      await f.controller.tick();
      expect(f.build).toHaveBeenCalledTimes(2);
      expect((await f.driver.current()).sha).toBe(f.c);
      await f.certify("adopt", f.c, d);
      expect(await f.driver.passedMergeGate(f.b, d)).toBe(true);
      await f.controller.tick();
      expect((await f.driver.current()).sha).toBe(d);
    } finally {
      await f.close();
    }
  },
);

test.each(
  (["prefix", "tail"] as const).flatMap((segment) =>
    (["missing", "actor", "tree", "check"] as const).map((fault) => ({
      segment,
      fault,
    })),
  ),
)(
  "unpin waits for a $segment segment with $fault evidence",
  async ({ segment, fault }) => {
    const f = await fixture(true);
    try {
      const from = segment === "prefix" ? f.a : f.trunk;
      const to = segment === "prefix" ? f.trunk : f.c;
      if (segment === "prefix") await f.certify("merge", f.trunk, f.c);
      else await f.certify("merge", f.a, f.trunk);
      if (fault !== "missing")
        await f.certify("merge", from, to, {
          ...(fault === "actor"
            ? { actor: { kind: "human", project_id: "cardigan" } as const }
            : {}),
          ...(fault === "tree" ? { tree: "a".repeat(40) } : {}),
          checked: fault !== "check",
        });
      await f.control({ action: "pin", sha: f.b, reason: "Use side branch" });
      await f.controller.tick();
      expect((await f.driver.current()).sha).toBe(f.b);
      await f.control({ action: "unpin", reason: "Resume main" });
      expect(await f.driver.passedMergeGate(f.b, f.c)).toBe(false);
      await f.controller.tick();
      expect(f.build).toHaveBeenCalledTimes(1);
      expect((await f.driver.current()).sha).toBe(f.b);
      await f.certify("merge", from, to);
      expect(await f.driver.passedMergeGate(f.b, f.c)).toBe(true);
      await f.controller.tick();
      expect(f.build).toHaveBeenCalledTimes(2);
      expect((await f.driver.current()).sha).toBe(f.c);
    } finally {
      await f.close();
    }
  },
);

test("outer coverage cannot hide an invalid segment ancestry or an evidence cycle", async () => {
  const f = await fixture(true);
  try {
    await f.certify("merge", f.trunk, f.c);
    await f.certify("merge", f.b, f.trunk);
    expect(await f.driver.isFastForward(f.b, f.c)).toBe(true);
    expect(await f.driver.isFastForward(f.b, f.trunk)).toBe(false);
    expect(await f.driver.passedMergeGate(f.b, f.c)).toBe(false);
    await f.certify("merge", f.c, f.trunk);
    expect(await f.driver.passedMergeGate(f.b, f.c)).toBe(false);
    await f.certify("merge", f.a, f.trunk);
    expect(await f.driver.passedMergeGate(f.b, f.c)).toBe(true);
    expect(await f.driver.passedMergeGate(f.b, f.trunk)).toBe(false);
  } finally {
    await f.close();
  }
});

test("a pin alone, forged adoption, wrong tree or uncovered start never certifies the suffix", async () => {
  const f = await fixture();
  try {
    await f.control({
      action: "pin",
      sha: f.b,
      reason: "Pin without adoption",
    });
    await f.control({ action: "unpin", reason: "Return to main" });
    expect(await f.driver.passedMergeGate(f.b, f.c)).toBe(false);
    f.append(
      "host_deployment_controlled",
      {
        action: "adopt",
        from: f.a,
        to: f.c,
        tree: "a".repeat(40),
        reason: "Wrong actor",
      },
      { kind: "system", project_id: "cardigan" },
    );
    expect(await f.driver.passedMergeGate(f.b, f.c)).toBe(false);
    f.append("host_deployment_controlled", {
      action: "adopt",
      from: f.a,
      to: f.c,
      tree: "a".repeat(40),
      reason: "Wrong tree",
    });
    expect(await f.driver.passedMergeGate(f.b, f.c)).toBe(false);
    await f.certify("adopt", f.b, f.c);
    expect(await f.driver.passedMergeGate(f.a, f.c)).toBe(false);
    expect(await f.driver.passedMergeGate(f.b, f.c)).toBe(true);
  } finally {
    await f.close();
  }
});
