import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Actor,
  assign,
  type CommandEffect,
  type CommandPorts,
  type CommandState,
  createCard,
  type Result,
} from "@cardigan/domain";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import { Store, writeRole } from "@cardigan/store";

export function dispatchFixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "cg-dispatch-"));
  let time = Date.parse("2030-01-01T00:00:00.000Z");
  const clock = { now: () => new Date(time).toISOString() },
    project = "p-dispatch" as never;
  const store = Store.open({ dataDir, clock });
  store.createProject({ id: project, name: "Dispatcher" });
  store.uow.run((tx) =>
    writeRole(
      tx,
      project,
      {
        role_id: "coder",
        version: 1,
        display_name: "Coder",
        kind: "work",
        harness: "pi",
        launch_profile_ref: "fixture",
        core_prompt: "fixture",
        allowed_tools: [
          "whoami",
          "get_card",
          "get_updates",
          "ack_events",
          "finish_run",
          "post_comment",
        ],
        capabilities: ["code"],
        abilities: [],
        worktree: "none",
        required_machine_tags: [],
      },
      { mode: "add" },
    ),
  );
  function apply<T>(
    reduce: (
      state: CommandState,
      actor: Actor,
      ports: CommandPorts,
    ) => Result<CommandEffect<T>>,
    actor: Actor = { kind: "human", project_id: project },
  ): T {
    return store.uow.run((tx) => {
      const effect = unwrap(
        reduce(loadCommandState(tx, project), actor, { clock, ids: tx.ids }),
      );
      persistEffect(tx, project, effect);
      return effect.data;
    });
  }
  function create() {
    const card = apply((s, a, p) =>
      createCard(
        s,
        a,
        {
          title: "Work",
          goal: "Route work",
          acceptance_criteria: ["delivered"],
          repo: "fixture/repo",
          base_branch: "main",
          source: { kind: "quote", text: "fixture" },
        },
        p,
      ),
    );
    const item = store.uow.read((tx) =>
      tx.work_items
        .list(project)
        .find((w) => w.card_id === card.id && w.kind === "produce"),
    );
    if (!item) throw new Error("Missing work item");
    const assignment = apply((s, a, p) =>
      assign(s, a, { work_item_id: item.id, role_id: "coder" }, p),
    );
    return { card, item, assignment };
  }
  return {
    store,
    project,
    dataDir,
    clock,
    apply,
    create,
    advance: (ms: number) => {
      time += ms;
    },
    state: () => store.uow.read((tx) => loadCommandState(tx, project)),
    close: () => {
      store.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
