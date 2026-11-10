import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Actor,
  type Assignment,
  acknowledgeRun,
  assign,
  type CommandEffect,
  type CommandPorts,
  type CommandState,
  createCard,
  dispatchRun,
  finishRun,
  queueRun,
  type Result,
  type Run,
  type RuntimeRef,
} from "@cardigan/domain";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import { getRoleVersion, Store, writeRole } from "@cardigan/store";

export function dispatchFixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "cg-dispatch-"));
  let time = Date.parse("2030-01-01T00:00:00.000Z");
  const clock = { now: () => new Date(time).toISOString() },
    project = "p-dispatch" as never;
  const store = Store.open({ dataDir, clock });
  store.createProject({ id: project, name: "Dispatcher" });
  const { role: coderRole } = store.uow.run((tx) =>
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
          "submit_delivery",
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
  function ensureVerifier(role_id: "pm" | "reviewer") {
    store.uow.run((tx) => {
      if (getRoleVersion(tx, project, role_id)) return;
      writeRole(
        tx,
        project,
        {
          ...coderRole,
          role_id,
          display_name: role_id,
          kind: role_id === "pm" ? "standing" : "work",
          allowed_tools: ["submit_review", "finish_run"],
          capabilities: [],
        },
        { mode: "add" },
      );
    });
  }
  ensureVerifier("reviewer");
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
    ensureVerifier("pm");
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
  const actorFor = (a: Assignment): Actor => {
    const role = store.uow.read((tx) =>
      tx.roles.get(project, {
        role_id: a.role_id,
        role_version: a.role_version,
      }),
    );
    if (!role) throw new Error("Missing actor role");
    return {
      ...role,
      kind: "assignment",
      project_id: project,
      assignment_id: a.id,
    };
  };
  const refFor = (a: Assignment): RuntimeRef => ({
    machine_id: "local",
    runtime_machine: "local",
    terminal_ref: `t${a.id.slice(2)}`,
    agent_name: `coder-${a.id.toLowerCase()}`,
  });
  function session(a: Assignment, complete = true): Run {
    const run = apply((s, actor, p) =>
      queueRun(
        s,
        actor,
        {
          assignment_id: a.id,
          model: "session-model",
          agent_cli_version: "session-cli",
        },
        p,
      ),
    );
    apply((s, actor, p) =>
      dispatchRun(s, actor, { run_id: run.id, runtime_ref: refFor(a) }, p),
    );
    apply(
      (s, actor, p) => acknowledgeRun(s, actor, { run_id: run.id }, p),
      actorFor(a),
    );
    if (complete)
      apply(
        (s, actor, p) =>
          finishRun(
            s,
            actor,
            { run_id: run.id, outcome: "completed", summary: "fixture" },
            p,
          ),
        actorFor(a),
      );
    return run;
  }
  return {
    store,
    session,
    refFor,
    actorFor,
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
