import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  autoRiskMergeReason,
  autoRiskPaths,
  prepareDelivery,
  setProjectPreferences,
  submitDelivery,
} from "@cardigan/domain";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import { afterEach, beforeEach, expect, test } from "vitest";
import { routeProjectEvents } from "./dispatch-inbox.js";
import { ServerGit } from "./git.js";
import { m4Fixture, m4Scenario } from "./m4-fixtures.js";

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
    { encoding: "utf8" },
  ).trim();
let f: ReturnType<typeof m4Fixture>;
beforeEach(() => {
  f = m4Fixture();
});
afterEach(() => f.close());

/** Real local Git and server verifier wiring; no HTTP, runtime, SSH or external remote. */
async function prepared(change: "add" | "delete" | "rename") {
  const source = join(f.dataDir, "source");
  git(f.dataDir, "init", "-q", "-b", "main", source);
  mkdirSync(join(source, ".github"), { recursive: true });
  writeFileSync(join(source, ".github", "ci.yml"), "fixture\n");
  git(source, "add", ".");
  git(source, "commit", "-qm", "initial");
  const base = git(source, "rev-parse", "HEAD");
  f.store.setProjectRepo({
    project_id: f.project_id,
    repo_path: source,
    base_branch: "main",
  });
  const scenario = m4Scenario(f, "confirm");
  const repository = join(f.dataDir, "agent", "repos", f.project_id);
  mkdirSync(join(repository, ".."), { recursive: true });
  git(f.dataDir, "clone", "-q", source, repository);
  const worktree = join(f.dataDir, "worktrees", scenario.coder.id);
  const branch = "agent/test/security";
  git(repository, "worktree", "add", "-q", "-b", branch, worktree, base);
  if (change === "add") {
    mkdirSync(join(worktree, "packages/store/migrations"), { recursive: true });
    writeFileSync(
      join(worktree, "packages/store/migrations/new.sql"),
      "-- fixture\n",
    );
  } else if (change === "delete") {
    rmSync(join(worktree, ".github/ci.yml"));
  } else git(worktree, "mv", ".github/ci.yml", "ordinary.yml");
  git(worktree, "add", "-A");
  git(worktree, "commit", "-qm", "delivery");
  const sha = git(worktree, "rev-parse", "HEAD");
  f.startRun(scenario.coder, { path: worktree, branch });
  // Replace the fixture's synthetic base with the observed local commit.
  f.store.uow.run((tx) => {
    const a = tx.assignments.get(f.project_id, scenario.coder.id);
    if (!a) throw new Error("missing fixture assignment");
    tx.assignments.put(f.project_id, { ...a, base_sha: base });
  });
  const params = {
    work_item_id: scenario.development.id,
    kind: "code" as const,
    summary: "Fixture delivery",
    subject: { kind: "git_head" as const, value: sha },
    requested_verifiers: [scenario.codeReview.id],
    // Extra author-supplied path claims must have no influence.
    changed_paths: ["ordinary.yml"],
  };
  const actor = f.actorFor(scenario.coder);
  const serverGit = new ServerGit({ store: f.store, dataDir: f.dataDir });
  const receipt = unwrap(
    await prepareDelivery(
      f.state(),
      actor,
      params,
      serverGit.verifierFor(f.project_id),
    ),
  );
  return { params, actor, receipt, scenario };
}

test.each(["add", "delete", "rename"] as const)(
  "D6: server's real Git evidence classifies %s in the delivery transaction",
  async (change) => {
    const { params, actor, receipt, scenario } = await prepared(change);
    const delivery = f.apply(
      (s, a, p) => submitDelivery(s, a, params, receipt, p),
      actor,
    );
    expect(f.card(scenario.card.id).risk_tags).toEqual(["security"]);
    const paths = autoRiskPaths(delivery);
    expect(paths).toContain(
      change === "add" ? "packages/store/migrations/new.sql" : ".github/ci.yml",
    );
    if (change === "rename") expect(paths).toContain("ordinary.yml");
    const audit = f
      .state()
      .events.find((e) => e.type === "auto_risk_tags_applied");
    expect(audit).toMatchObject({
      actor: { kind: "system" },
      payload: { delivery_id: delivery.id },
    });
    routeProjectEvents(f.store, f.project_id);
    const first = f.store.database
      .prepare(
        "SELECT COUNT(*) AS n FROM notifications WHERE project_id = ? AND event_id = ?",
      )
      .get(f.project_id, audit?.id);
    expect(first).toMatchObject({ n: 1 });
    routeProjectEvents(f.store, f.project_id);
    expect(
      f.store.database
        .prepare(
          "SELECT COUNT(*) AS n FROM notifications WHERE project_id = ? AND event_id = ?",
        )
        .get(f.project_id, audit?.id),
    ).toEqual(first);
  },
);

test("D6: transaction failure rolls back delivery, system tag and audit together", async () => {
  const { params, actor, receipt, scenario } = await prepared("rename");
  expect(() =>
    f.store.uow.run((tx) => {
      const effect = unwrap(
        submitDelivery(
          loadCommandState(tx, f.project_id),
          actor,
          params,
          receipt,
          { clock: f.clock, ids: tx.ids },
        ),
      );
      persistEffect(tx, f.project_id, effect);
      throw new Error("fixture persistence rollback");
    }),
  ).toThrow("fixture persistence rollback");
  expect(f.state().deliveries).toHaveLength(0);
  expect(f.card(scenario.card.id).risk_tags ?? []).toEqual([]);
  expect(
    f.state().events.some((e) => e.type === "auto_risk_tags_applied"),
  ).toBe(false);
  f.apply((s, a, p) => submitDelivery(s, a, params, receipt, p), actor);
  expect(f.card(scenario.card.id).risk_tags).toEqual(["security"]);
});

test("D6: settlement uses fresh human preferences after asynchronous verification", async () => {
  const { params, actor, receipt, scenario } = await prepared("add");
  f.apply((s, a, p) =>
    setProjectPreferences(s, a, { auto_security_paths: [".github/**"] }, p),
  );
  f.apply((s, a, p) => submitDelivery(s, a, params, receipt, p), actor);
  expect(f.card(scenario.card.id).risk_tags ?? []).toEqual([]);
});

test("D6: unavailable host path evidence stays unknown through server persistence", async () => {
  const { params, actor, receipt, scenario } = await prepared("add");
  // Model a host verifier without complete path capability, not an author claim.
  const unknown = { ...receipt, evidence: [] };
  f.apply((s, a, p) => submitDelivery(s, a, params, unknown, p), actor);
  expect(f.card(scenario.card.id).risk_tags ?? []).toEqual([]);
  const state = f.state();
  expect(
    autoRiskMergeReason(
      { ...state, cards: state.cards.map((c) => ({ ...c, flow_version: 4 })) },
      scenario.card.id,
    ),
  ).toContain("交人");
});
