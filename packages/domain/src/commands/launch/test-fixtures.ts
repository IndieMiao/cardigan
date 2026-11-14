import type {
  Actor,
  Assignment,
  CommandEffect,
  CommandPorts,
  CommandState,
  Result,
  Run,
  RuntimeRef,
  WorkItem,
} from "../../index.js";
import { assign, createCard, dispatchRun, queueRun } from "../../index.js";
import {
  apply,
  human,
  now,
  ports,
  role,
  subject,
  value,
} from "../test-fixtures.js";

const f = {} as {
  state: CommandState;
  coder: Assignment;
  reviewer: Assignment;
  io: CommandPorts;
};
const system: Actor = { kind: "system", project_id: human.project_id };
const ref: RuntimeRef = {
  machine_id: "local",
  runtime_machine: "local",
  terminal_ref: "t1",
  agent_name: "coder",
  worktree_path: "/fixture/worktree",
  branch: "agent/example",
  agent_session_id: "session-1",
};
const present = <T>(v: T | undefined): T => {
  if (v === undefined) throw new Error("Missing fixture");
  return v;
};
function commit<T>(r: Result<CommandEffect<T>>) {
  const e = value(r);
  f.state = apply(f.state, e);
  return e.data;
}
const actor = (a = f.coder): Actor => ({
  kind: "assignment",
  project_id: f.state.project_id,
  assignment_id: a.id,
  ...role(a.role_id),
  role_version: a.role_version,
  allowed_tools: ["whoami", "submit_delivery", "submit_review", "finish_run"],
});
const queue = (a = f.coder) =>
  queueRun(
    f.state,
    human,
    { assignment_id: a.id, model: "fixture-model", agent_cli_version: "1.2.3" },
    f.io,
  );
const dispatch = (r: Run, runtime_ref = ref) =>
  dispatchRun(
    f.state,
    system,
    { run_id: r.id, runtime_ref, base_sha: subject.value },
    f.io,
  );
const item = (a = f.coder): WorkItem =>
  present(f.state.work_items.find((w) => w.id === a.work_item_id));
function setup() {
  f.io = ports();
  f.state = {
    project_id: human.project_id,
    machines: [
      {
        id: "local",
        label: "local",
        herdr_machine: "local",
        os: "linux",
        arch: "x64",
        tags: [],
        max_assignments: 4,
        status: "online",
        last_seen: now,
      },
    ],
    roles: [role("coder"), role("reviewer"), role("pm")],
    cards: [],
    work_items: [],
    assignments: [],
    runs: [],
    deliveries: [],
    reviews: [],
    decisions: [],
    human_actions: [],
    attachments: [],
    cursors: [],
    timeline: [],
    events: [],
  };
  commit(
    createCard(
      f.state,
      human,
      {
        title: "Launch",
        goal: "Ship",
        acceptance_criteria: ["Pass"],
        source: { kind: "quote", text: "Build" },
        repo: "example/repo",
        base_branch: "main",
      },
      f.io,
    ),
  );
  const assignRole = (role_id: string) =>
    commit(
      assign(
        f.state,
        human,
        {
          work_item_id: present(
            f.state.work_items.find((w) => w.role_id === role_id),
          ).id,
          role_id,
        },
        f.io,
      ),
    );
  f.coder = assignRole("coder");
  f.reviewer = assignRole("reviewer");
}

export { actor, commit, dispatch, f, item, present, queue, ref, setup, system };
