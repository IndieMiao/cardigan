import { loadCommandState } from "@cardigan/mcp-server";
import { Store } from "@cardigan/store";
import { expect, test } from "vitest";
import { ServerGit } from "./git.js";

test("server Git binds the host-only proof port and an unavailable source stays full-review", async () => {
  const store = Store.open({ dbPath: ":memory:" });
  try {
    store.createProject({ id: "project" });
    const project = { id: "project" };
    new ServerGit({
      store,
      dataDir: "unused-fixture",
      execution: {
        mode: "agent-ssh",
        dataDir: "unused-fixture",
        agentRoot: "/fixture/agent",
        gid: 1,
        machine: "fixture",
        identityFile: "/fixture/key",
        knownHostsFile: "/fixture/known",
      },
      captureAgent: async () => ({ ok: true, value: "" }),
      testReview: {
        policyFile: () => undefined,
        source: {
          policyBoundary: () => undefined,
          collect: async () => undefined,
          isCurrent: () => false,
        },
      },
    });
    const trust = store.uow.read(
      (tx) => loadCommandState(tx, project.id).test_review_trust,
    );
    expect(trust).toBeDefined();
    expect(
      await trust?.prepare({
        project_id: project.id,
        verifier_id: "W-2",
        work_item_id: "W-1",
        assignment_id: "A-2",
        previous_delivery_id: "D-1",
        previous_review_id: "V-1",
        old_sha: "a".repeat(40),
        new_sha: "b".repeat(40),
        old_tree: "c".repeat(40),
        context: "fixture",
        base_branch: "main",
      }),
    ).toBeUndefined();
  } finally {
    store.close();
  }
});
