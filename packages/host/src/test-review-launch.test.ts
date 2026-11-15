import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acknowledgeRun,
  queueRun,
  type Runtime,
  submitReview,
} from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import { parseLaunchConfig } from "@cardigan/roles";
import { Store, writeRole } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { actor, human } from "../../domain/src/commands/test-fixtures.js";
import { testReviewFixture } from "../../domain/src/commands/test-review/test-fixtures.js";
import { launchRun } from "./launch.js";
import { settleTestReviewLimits } from "./test-review-limits.js";

async function setup(limit: number) {
  const f = await testReviewFixture(limit);
  const product = (await f.deliver()).data;
  const run = f.commit(
    queueRun(
      f.state,
      human,
      { assignment_id: "A-2", model: "fixture", agent_cli_version: "1" },
      f.io,
    ),
  ).data;
  const root = await mkdtemp(join(tmpdir(), "cg-scoped-launch-"));
  const configDir = join(root, "config");
  await mkdir(configDir, { mode: 0o700 });
  let store = Store.open({ dataDir: root, clock: f.io.clock });
  store.createProject({ id: f.state.project_id });
  store.setTestReviewTrust(f.trust);
  store.uow.run((tx) => {
    for (const e of f.state.employees ?? []) tx.employees.put(e);
    for (const collection of [
      "cards",
      "work_items",
      "assignments",
      "runs",
      "deliveries",
      "reviews",
      "roles",
    ] as const)
      for (const entity of f.state[collection]) {
        if (
          collection === "roles" &&
          "role_id" in entity &&
          entity.role_id === "independent_reviewer"
        )
          continue;
        (tx[collection].put as (p: string, e: unknown) => void)(
          f.state.project_id,
          entity,
        );
      }
    writeRole(
      tx,
      f.state.project_id,
      {
        role_id: "independent_reviewer",
        version: 1,
        display_name: "Review",
        kind: "verify",
        harness: "codex",
        core_prompt: "Fixture",
        launch_profile_ref: "fixture",
        allowed_tools: ["submit_review", "get_updates", "finish_run"],
        capabilities: [],
        abilities: [],
        worktree: "none",
        required_machine_tags: [],
      },
      { mode: "add" },
    );
    for (const e of f.state.events) tx.events.append(f.state.project_id, e);
    for (const card of [undefined, ...f.state.cards.map((c) => c.id)]) {
      const max = Math.max(
        0,
        ...f.state.events.filter((e) => e.card_id === card).map((e) => e.seq),
      );
      for (let n = 0; n < max; n++)
        tx.ids.nextEventSequence(f.state.project_id, card);
    }
  });
  const state = () =>
    store.uow.read((tx) => loadCommandState(tx, f.state.project_id));
  return {
    f,
    product,
    run,
    root,
    configDir,
    get store() {
      return store;
    },
    state,
    restart() {
      store.close();
      store = Store.open({ dataDir: root, clock: f.io.clock });
    },
    close: async () => {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("new-session first.md cannot become a full-review Run when proof is revoked inside dispatch", async () => {
  const t = await setup(3);
  let provisioned = false,
    revoked = false;
  const trust = {
    ...t.f.trust,
    isCurrent: () => {
      if (provisioned && new Error().stack?.includes("dispatchRun")) {
        revoked = true;
        t.f.revoke();
      }
      return t.f.trust.isCurrent(
        t.product.test_review as NonNullable<typeof t.product.test_review>,
      );
    },
  };
  t.store.setTestReviewTrust(trust);
  const runtime = {
    provision: vi.fn(async () => {
      provisioned = true;
      return {
        ok: true,
        value: {
          machine_id: "local",
          runtime_machine: "local",
          terminal_ref: "scoped",
          agent_name: "review",
        },
      };
    }),
    release: vi.fn(async () => ({ ok: true, value: undefined })),
  } as unknown as Runtime;
  try {
    await expect(
      launchRun(
        {
          store: t.store,
          runtime,
          dataDir: t.root,
          configDir: t.configDir,
          clock: t.f.io.clock,
          mcpUrl: "http://localhost/mcp",
          launch: {
            config: parseLaunchConfig({
              profiles: { fixture: { harness: "codex", model: "fixture" } },
            }),
            secrets: {},
          },
        },
        {
          project: t.f.state.project_id,
          assignment_id: "A-2",
          actor: human,
          run: t.run,
        },
      ),
    ).rejects.toThrow("scope changed");
    expect(revoked).toBe(true);
    const prompt = await readFile(
      join(t.root, "runs", t.f.state.project_id, "A-2", "first.md"),
      "utf8",
    );
    expect(prompt).toContain("增量复核（只改测试）");
    expect(t.state().runs.find((r) => r.id === t.run.id)?.status).not.toBe(
      "dispatched",
    );
    expect(
      acknowledgeRun(
        t.state(),
        actor(2, "independent_reviewer"),
        { run_id: t.run.id },
        t.f.io,
      ).ok,
    ).toBe(false);
    expect(
      submitReview(
        t.state(),
        actor(2, "independent_reviewer"),
        {
          delivery_id: t.product.id,
          target_sha: t.product.subject.value,
          kind: "code",
          issues: [],
        },
        t.f.io,
      ).ok,
    ).toBe(false);
    expect(
      t.state().reviews.filter((r) => r.delivery_id === t.product.id),
    ).toHaveLength(0);
    expect(runtime.release).toHaveBeenCalled();
  } finally {
    await t.close();
  }
});

test.each(["revocation", "restart"])(
  "expired source enters and reuses the existing budget wait in real Store (%s)",
  async (reason) => {
    const t = await setup(1);
    try {
      if (reason === "revocation") t.f.revoke();
      else t.restart();
      expect(
        settleTestReviewLimits(t.store, t.f.state.project_id, t.f.io.clock),
      ).toEqual(["W-2"]);
      expect(t.state().work_items.find((w) => w.id === "W-2")?.status).toBe(
        "waiting_decision",
      );
      const decision = t
        .state()
        .decisions.find((q) => q.trigger === "review_limit");
      expect(decision?.decider).toBe("human");
      expect(decision?.human_required_reason).toBeTruthy();
      expect(
        settleTestReviewLimits(t.store, t.f.state.project_id, t.f.io.clock),
      ).toEqual(["W-2"]);
      expect(
        t.state().decisions.filter((q) => q.trigger === "review_limit"),
      ).toHaveLength(1);
      expect(t.state().decisions.find((q) => q.id === decision?.id)).toEqual(
        decision,
      );
      expect(
        queueRun(
          t.state(),
          human,
          { assignment_id: "A-2", model: "fixture", agent_cli_version: "1" },
          t.f.io,
        ).ok,
      ).toBe(false);
    } finally {
      await t.close();
    }
  },
);
