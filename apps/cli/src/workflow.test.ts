import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type HumanAction,
  PM_MERGE_STALL_KIND,
  pauseStandingAssignment,
  queueRun,
  recordDecision,
  requestDecision,
  requestHumanAction,
  resolveDelegatedDecision,
} from "@cardigan/domain";
import { RuntimeTargets } from "@cardigan/host";
import {
  beginMachineObservation,
  completeMachineObservation,
  readMachineObservations,
  Store,
} from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { runCommand } from "./host.js";
import { main } from "./index.js";
import type { CliIo } from "./io.js";

vi.mock("@cardigan/host", async (importOriginal) => {
  const host = await importOriginal<typeof import("@cardigan/host")>();
  return {
    ...host,
    refreshMachineObservations: (
      options: Parameters<typeof host.refreshMachineObservations>[0],
    ) => host.refreshMachineObservations({ ...options, catalog: () => [] }),
  };
});

const TEST_PLAIN_SUMMARY = {
  changed: "测试用的改动说明",
  impact: "测试用的影响说明",
  risk: "无",
};

let dataDir: string;
let output: string[];
let errors: string[];
let io: CliIo;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cardigan-workflow-"));
  mkdirSync(join(dataDir, "config"), { mode: 0o700 });
  output = [];
  errors = [];
  io = {
    env: {
      CARDIGAN_RUNTIME_MODE: "local",
      CARDIGAN_DATA_DIR: dataDir,
      CARDIGAN_CONFIG_DIR: join(dataDir, "config"),
    },
    cwd: dataDir,
    platform: "linux",
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
    signals: { on: () => undefined, off: () => undefined },
    spawnInherit: () => {
      throw new Error("workflow commands must not spawn");
    },
    captureCommand: async () => ({ code: 1, stdout: "", stderr: "" }),
  };
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

async function run(argv: string[]): Promise<number> {
  output = [];
  errors = [];
  return main(argv, io);
}

function printed(): string {
  return output.join("\n");
}

function tokenFromOutput(): string {
  const lines = printed()
    .split("\n")
    .map((line) => line.trim());
  const index = lines.findIndex((line) => line.startsWith("token_id："));
  const token = lines[index + 2];
  if (token === undefined) throw new Error(`no token in:\n${printed()}`);
  return token;
}

async function bootstrap(project = "p-work"): Promise<void> {
  expect(await run(["init"])).toBe(0);
  expect(await run(["project", "create", project])).toBe(0);
  expect(
    await run([
      "role",
      "add",
      project,
      "pm",
      "--allowed-tools",
      "create_card,assign,record_decision,submit_review",
    ]),
  ).toBe(0);
  expect(
    await run([
      "role",
      "add",
      project,
      "coder",
      "--allowed-tools",
      "submit_delivery,post_comment,get_card",
    ]),
  ).toBe(0);
  expect(
    await run([
      "role",
      "add",
      project,
      "reviewer",
      "--allowed-tools",
      "submit_review",
    ]),
  ).toBe(0);
}

test("machine CLI is human-only, audits metadata and cannot enable remote execution", async () => {
  await bootstrap();
  expect(
    await run([
      "machine",
      "register",
      "worker-a",
      "--label",
      "Worker A",
      "--os",
      "darwin",
      "--arch",
      "arm64",
      "--tags",
      "gpu",
    ]),
  ).toBe(0);
  expect(printed()).toContain('"status":"offline"');
  expect(
    await run(["machine", "update", "worker-a", "--status", "online"]),
  ).toBe(0);
  expect(await run(["machine", "check", "worker-a"])).not.toBe(0);
  expect(errors.join("\n")).toContain("机器检查未通过");
  expect(
    await run(["machine", "update", "worker-a", "--ssh-endpoint", "forbidden"]),
  ).not.toBe(0);
  expect(
    await run([
      "machine",
      "update",
      "worker-a",
      "--allow-remote-launch",
      "true",
    ]),
  ).not.toBe(0);
  expect(await run(["machine", "drain", "worker-a"])).toBe(0);
  expect(await run(["machine", "show", "worker-a"])).toBe(0);
  expect(printed()).toContain('"status": "draining"');
  const store = Store.open({ dataDir });
  try {
    const events = store.uow.read((tx) =>
      tx.events.listAfter("p-work", undefined, 0),
    );
    expect(
      events.filter((e) => e.type.startsWith("machine_")).map((e) => e.type),
    ).toEqual(["machine_registered", "machine_updated", "machine_draining"]);
    expect(
      store.database.prepare("SELECT * FROM run_capacity_limits").all(),
    ).toEqual([]);
  } finally {
    store.close();
  }
  io = { ...io, env: { ...io.env, CARDIGAN_TOKEN: "untrusted-token" } };
  for (const sub of ["register", "update", "list", "show", "drain", "check"])
    expect(await run(["machine", sub, "worker-a"])).not.toBe(0);
});

test("machine check reports actual remote results without a blanket field-verification refusal", async () => {
  await bootstrap();
  expect(
    await run([
      "machine",
      "register",
      "worker-a",
      "--label",
      "Worker A",
      "--os",
      "linux",
      "--arch",
      "x64",
      "--status",
      "online",
    ]),
  ).toBe(0);
  const check = vi.spyOn(RuntimeTargets.prototype, "check");
  const resolve = vi
    .spyOn(RuntimeTargets.prototype, "resolve")
    .mockReturnValue({
      execution: { mode: "local", dataDir },
      session: "fixture",
      machine: {
        id: "worker-a",
        label: "Worker A",
        os: "linux",
        arch: "x64",
        herdr_machine: "worker-a",
        status: "online",
        tags: [],
        max_assignments: 1,
      },
    });
  try {
    for (const launch_enabled of [false, true]) {
      check.mockResolvedValueOnce({
        ok: true,
        value: { machine_id: "worker-a", blockers: [], launch_enabled },
      });
      expect(await run(["machine", "check", "worker-a"])).toBe(0);
      expect(printed()).toContain(`"launch_enabled": ${launch_enabled}`);
    }
    check.mockResolvedValueOnce({
      ok: true,
      value: {
        machine_id: "worker-a",
        blockers: ["worker_directories"],
        launch_enabled: false,
      },
    });
    expect(await run(["machine", "check", "worker-a"])).not.toBe(0);
    expect(printed()).toContain("worker_directories");
    expect(errors.join("\n")).not.toContain("现场前置仍未验收");
    expect(await run(["machine", "show", "worker-a"])).toBe(0);
    expect(printed()).toContain('"status": "failed"');
    expect(printed()).toContain("worker_directories");
  } finally {
    check.mockRestore();
    resolve.mockRestore();
  }
});

test.each(["runtime-workers", "terminal-config"])(
  "machine check revokes old success when %s initialization fails",
  async (stage) => {
    await bootstrap();
    const store = Store.open({ dataDir });
    const oldTime = new Date(Date.now() - 60_000).toISOString();
    const check = vi.spyOn(RuntimeTargets.prototype, "check");
    try {
      const system = { kind: "system", project_id: "p-work" } as const;
      beginMachineObservation(store, system, "p-work", "local", "old", oldTime);
      completeMachineObservation(
        store,
        system,
        "p-work",
        "local",
        "old",
        {
          status: "passed",
          checked_at: oldTime,
          blockers: [],
          launch_enabled: true,
        },
        [
          {
            key: "node",
            version: "24.0.0",
            verified_at: oldTime,
            evidence_ref: "fixture-old",
          },
        ],
      );
      expect(
        readMachineObservations(store, "p-work", "local").health?.available,
      ).toBe(true);
      if (stage === "runtime-workers")
        writeFileSync(
          join(dataDir, "config", "runtime-workers.yaml"),
          "version: 999\nmachines: []\n",
          { mode: 0o600 },
        );
      else io = { ...io, env: { ...io.env, CARDIGAN_RUNTIME_MODE: "invalid" } };
      expect(await run(["machine", "check", "local"])).not.toBe(0);
      expect(check).not.toHaveBeenCalled();
      const after = readMachineObservations(store, "p-work", "local");
      expect(after.capabilities).toEqual([]);
      expect(after.health).toMatchObject({
        status: "failed",
        available: false,
        blockers: ["machine_observation_failed"],
      });
      expect(after.health?.checked_at).not.toBe(oldTime);
      expect(after.health?.evidence_ref).not.toBe("machine-observation:old");
      expect(await run(["machine", "show", "local"])).toBe(0);
      expect(printed()).toContain('"status": "failed"');
      expect(printed()).not.toContain('"version": "24.0.0"');
    } finally {
      check.mockRestore();
      store.close();
    }
  },
);

test("machine show reads persisted versions, verification times and health; MCP Token cannot refresh", async () => {
  await bootstrap();
  const store = Store.open({ dataDir });
  const now = new Date().toISOString();
  try {
    const system = { kind: "system", project_id: "p-work" } as const;
    beginMachineObservation(store, system, "p-work", "local", "fixture", now);
    completeMachineObservation(
      store,
      system,
      "p-work",
      "local",
      "fixture",
      { status: "passed", checked_at: now, launch_enabled: true, blockers: [] },
      [
        {
          key: "node",
          version: "24.0.0",
          verified_at: now,
          evidence_ref: "fixture-proof",
        },
      ],
    );
  } finally {
    store.close();
  }
  expect(await run(["machine", "show", "local"])).toBe(0);
  expect(printed()).toContain('"version": "24.0.0"');
  expect(printed()).toContain(`"verified_at": "${now}"`);
  expect(printed()).toContain('"status": "passed"');
  io = { ...io, env: { ...io.env, MCP_TOKEN: "fixture-token" } };
  expect(await run(["machine", "check", "local"])).not.toBe(0);
  expect(errors.join("\n")).toContain("Token");
});

test("machine updates atomically share physical descriptions while preserving each project's policy and audit", async () => {
  await bootstrap("project-a");
  expect(await run(["project", "create", "project-b"])).toBe(0);
  const store = Store.open({ dataDir });
  try {
    store.uow.run((tx) => {
      for (const project of ["project-a", "project-b"]) {
        const local = tx.machines.get(project, "local");
        if (!local) throw new Error("missing local");
        tx.machines.put(project, {
          ...local,
          herdr_machine: `${project}-alias`,
          tags: [project],
          status: project === "project-a" ? "online" : "draining",
        });
      }
    });
    const read = (project: string) =>
      store.uow.read((tx) => tx.machines.list(project));
    const beforeA = read("project-a"),
      beforeB = read("project-b");
    const update = (
      project: string,
      label: string,
      os: string,
      arch: string,
      rest: string[] = [],
    ) =>
      run([
        "machine",
        "update",
        "local",
        "--project",
        project,
        "--label",
        label,
        "--os",
        os,
        "--arch",
        arch,
        ...rest,
      ]);
    expect(
      await update("project-a", "Shared Host", "darwin", "arm64", [
        "--tags",
        "updated",
        "--status",
        "degraded",
      ]),
    ).toBe(0);
    expect(read("project-a")).toEqual([
      {
        ...beforeA[0],
        label: "Shared Host",
        os: "darwin",
        arch: "arm64",
        tags: ["updated"],
        status: "degraded",
      },
    ]);
    expect(read("project-b")).toEqual([
      { ...beforeB[0], label: "Shared Host", os: "darwin", arch: "arm64" },
    ]);
    expect(await update("project-b", "Renamed Host", "linux", "x64")).toBe(0);
    for (const project of ["project-a", "project-b"]) {
      expect(read(project)[0]).toMatchObject({
        label: "Renamed Host",
        os: "linux",
        arch: "x64",
      });
      const events = store.uow.read((tx) =>
        tx.events
          .listAfter(project, undefined, 0)
          .filter((e) => e.type === "machine_updated"),
      );
      expect(events).toHaveLength(2);
      expect(events).toMatchObject([
        {
          actor: { kind: "human", project_id: project },
          payload: { machine: { label: "Shared Host" } },
        },
        {
          actor: { kind: "human", project_id: project },
          payload: { machine: { label: "Renamed Host" } },
        },
      ]);
    }
    expect(read("project-b")[0]).toMatchObject({
      status: "draining",
      tags: ["project-b"],
      herdr_machine: "project-b-alias",
    });
    // Any failed audit must undo all projects, revisions and allocated event IDs.
    const snapshot = () =>
      [
        "machines",
        "events",
        "event_counters",
        "command_versions",
        "command_rows",
      ].map((table) =>
        store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      );
    const beforeFailure = snapshot();
    store.database.exec(
      "CREATE TRIGGER fail_machine_audit BEFORE INSERT ON events WHEN NEW.project_id = 'project-b' AND NEW.type = 'machine_updated' BEGIN SELECT RAISE(ABORT, 'fixture audit failure'); END",
    );
    expect(
      await update("project-a", "Rolled Back", "darwin", "arm64"),
    ).not.toBe(0);
    expect(errors.join("\n")).toContain("fixture audit failure");
    expect(snapshot()).toEqual(beforeFailure);
    expect(read("project-a")[0]?.label).toBe("Renamed Host");
    expect(read("project-b")[0]?.label).toBe("Renamed Host");
  } finally {
    store.close();
  }
});

test.each(["invalid", "unsafe"])(
  "machine commands reject %s capacity configuration without saving a fault value",
  async (kind) => {
    await bootstrap();
    const configDir = join(dataDir, "config");
    mkdirSync(configDir, { mode: 0o700, recursive: true });
    const file = join(configDir, "run-capacity.yaml");
    const marker = "fixture-private-configuration";
    if (kind === "invalid")
      writeFileSync(file, `machines: { local: ${marker} }`, { mode: 0o600 });
    else {
      const target = join(configDir, "untrusted.yaml");
      writeFileSync(target, `machines: { local: 4 } # ${marker}`, {
        mode: 0o600,
      });
      symlinkSync(target, file);
    }
    io.env.CARDIGAN_CONFIG_DIR = configDir;
    const store = Store.open({ dataDir });
    try {
      const snapshot = () =>
        ["machines", "events", "run_capacity_limits"].map((table) =>
          store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
        );
      const before = snapshot();
      for (const args of [
        ["check", "local"],
        ["update", "local", "--tags", "fixture"],
        [
          "register",
          "worker-a",
          "--label",
          "Worker A",
          "--os",
          "darwin",
          "--arch",
          "arm64",
        ],
        ["list"],
        ["show", "local"],
        ["drain", "local"],
      ]) {
        expect(await run(["machine", ...args])).not.toBe(0);
        expect(errors.join("\n")).toContain(
          kind === "invalid"
            ? "配置无效，暂停普通 Run"
            : "无法安全读取 run-capacity.yaml",
        );
        expect(errors.join("\n") + printed()).not.toContain(marker);
        expect(printed()).not.toContain("max_assignments");
        expect(snapshot()).toEqual(before);
      }
    } finally {
      store.close();
    }
  },
);

test("card create builds a dev card and lists its work items", async () => {
  await bootstrap();
  expect(
    await run([
      "card",
      "create",
      "--template",
      "dev",
      "--title",
      "Fictional card",
      "--goal",
      "Prove the CLI",
      "--acceptance",
      "tests pass;docs updated",
      "--repo",
      "example/repo",
    ]),
  ).toBe(0);
  expect(printed()).toContain("已创建卡片 C-1");
  expect(printed()).toContain("W-1  produce  coder");
  expect(printed()).toContain("W-2  verify  reviewer");
  expect(printed()).toContain("W-3  verify  pm");

  // Only the dev template exists in M1.
  expect(
    await run([
      "card",
      "create",
      "--template",
      "bug",
      "--title",
      "x",
      "--goal",
      "x",
      "--acceptance",
      "x",
      "--repo",
      "x",
    ]),
  ).toBe(2);
  expect(errors.join("\n")).toContain("模板不存在");
});

test("design card create accepts display-only and structured state and save input", async () => {
  await bootstrap();
  for (const [id, tool] of [
    ["design_director", "submit_review"],
    ["ui_ux_designer", "submit_delivery"],
  ] as const)
    expect(
      await run(["role", "add", "p-work", id, "--allowed-tools", tool]),
    ).toBe(0);
  const args = [
    "card",
    "create",
    "--template",
    "design",
    "--title",
    "Settings",
    "--goal",
    "Design",
    "--acceptance",
    "Review the draft",
  ];
  expect(await run(args)).not.toBe(0);
  expect(errors.join("\n")).toContain("状态与保存");
  const plan = {
    save_timing: "按组",
    leave_behavior: "离开",
    failure_feedback: "全站提示",
    consistency: "写后补读",
  };
  expect(await run([...args, "--state-and-save", "无写入"])).toBe(0);
  expect(await run([...args, "--state-and-save", JSON.stringify(plan)])).toBe(
    0,
  );
  const store = Store.open({ dataDir });
  try {
    expect(
      store.uow.read((tx) =>
        tx.cards.list("p-work").map((c) => c.state_and_save),
      ),
    ).toEqual(["无写入", plan]);
  } finally {
    store.close();
  }
});

test("the project falls back to CARDIGAN_PROJECT and complains when ambiguous", async () => {
  await bootstrap("p-one");
  await bootstrap("p-two");
  expect(
    await run([
      "card",
      "create",
      "--template",
      "dev",
      "--title",
      "x",
      "--goal",
      "x",
      "--acceptance",
      "x",
      "--repo",
      "x",
    ]),
  ).toBe(2);
  expect(errors.join("\n")).toContain("--project");

  io.env.CARDIGAN_PROJECT = "p-two";
  expect(
    await run([
      "card",
      "create",
      "--template",
      "dev",
      "--title",
      "x",
      "--goal",
      "x",
      "--acceptance",
      "x",
      "--repo",
      "x",
    ]),
  ).toBe(0);
  expect(printed()).toContain("已创建卡片 C-1");
});

test("assign issues a token once and re-assigning rotates it", async () => {
  await bootstrap();
  await run([
    "card",
    "create",
    "--template",
    "dev",
    "--title",
    "T",
    "--goal",
    "G",
    "--acceptance",
    "A",
    "--repo",
    "r/x",
  ]);
  expect(await run(["assign", "W-1", "--role", "coder"])).toBe(0);
  const first = tokenFromOutput();
  expect(printed()).toContain("已指派 W-1 → A-1");

  const store = Store.open({ dataDir });
  try {
    // The plaintext token is nowhere in the database; only its hash is stored.
    expect(store.verifyToken(first)).toBeDefined();
  } finally {
    store.close();
  }

  expect(await run(["assign", "W-1", "--role", "coder"])).toBe(0);
  const second = tokenFromOutput();
  expect(second).not.toBe(first);
  const reopened = Store.open({ dataDir });
  try {
    // Re-assigning keeps one assignment and revokes the previous token.
    expect(reopened.verifyToken(first)).toBeUndefined();
    expect(reopened.verifyToken(second)).toBeDefined();
  } finally {
    reopened.close();
  }
});

test("token issue validates the assignment and its state", async () => {
  await bootstrap();
  expect(await run(["token", "issue", "A-99"])).toBe(2);
  expect(errors.join("\n")).toContain(
    "无法签发 Token A-99：Assignment A-99 不存在（not_found）",
  );
  expect(await run(["token", "issue", "not-an-id"])).toBe(2);
  expect(errors.join("\n")).toContain("不合法");
});

test("human-action reports domain rejection in Chinese with the same exit code", async () => {
  await bootstrap();
  expect(await run(["human-action", "done", "H-99", "--text", "done"])).toBe(2);
  expect(errors.join("\n")).toContain(
    "无法完成待办操作 H-99：对象在当前项目中不存在（not_found）",
  );
  expect(printed()).toBe("");
});

test("P2a-6: CLI assign separates authors, reviewers and PM acceptance and rejects a borrowed identity", async () => {
  await bootstrap();
  expect(
    await run([
      "card",
      "create",
      "--template",
      "dev",
      "--title",
      "Identity separation",
      "--goal",
      "Independent review",
      "--acceptance",
      "Distinct assignments",
      "--repo",
      "example/repo",
    ]),
  ).toBe(0);
  const roles = ["coder", "reviewer", "pm"];
  const tokens: string[] = [];
  for (const [index, role] of roles.entries()) {
    expect(await run(["assign", `W-${index + 1}`, "--role", role])).toBe(0);
    expect(printed()).toContain(`已指派 W-${index + 1} → A-${index + 1}`);
    tokens.push(tokenFromOutput());
  }

  const store = Store.open({ dataDir });
  try {
    store.uow.run((tx) => {
      expect(
        tx.assignments.list("p-work").map((a) => [a.id, a.work_item_id]),
      ).toEqual([
        ["A-1", "W-1"],
        ["A-2", "W-2"],
        ["A-3", "W-3"],
      ]);
      const reviewer = tx.work_items.get("p-work", "W-2" as never);
      if (!reviewer) throw new Error("Missing reviewer");
      // No CLI option reuses an identity; simulate a conflicting stored link.
      tx.work_items.put("p-work", {
        ...reviewer,
        assignment_id: "A-1" as never,
      });
    });
  } finally {
    store.close();
  }

  expect(await run(["assign", "W-2", "--role", "reviewer"])).toBe(2);
  expect(errors.join("\n")).toContain(
    "无法指派工作项 W-2：这个工作项已经有负责的 Assignment，不能再指派新的（invariant_violation）",
  );
  expect(printed()).toBe("");
  const reopened = Store.open({ dataDir });
  try {
    // Rejection must not rotate any credentials or rebind either Assignment.
    for (const [index, token] of tokens.entries()) {
      expect(reopened.verifyToken(token)?.assignment_id).toBe(`A-${index + 1}`);
    }
    expect(
      reopened.uow.read((tx) => tx.assignments.list("p-work")),
    ).toHaveLength(3);
  } finally {
    reopened.close();
  }
});

test("office and ops are separate standing assignments with independent tokens", async () => {
  await bootstrap();
  expect(await run(["pm", "create", "--office"])).toBe(0);
  const officeToken = tokenFromOutput();
  expect(printed()).toContain("已创建常驻 PM Office：A-1");

  // Ops is a second standing assignment of the same pm role, not a downgrade
  // of the Office one (§7.1, §10.4).
  expect(await run(["pm", "create", "--ops"])).toBe(0);
  const opsToken = tokenFromOutput();
  expect(printed()).toContain("已创建常驻 PM Ops：A-2");

  const store = Store.open({ dataDir });
  try {
    const standing = store.uow.read((tx) =>
      tx.assignments
        .list("p-work" as never)
        .filter((a) => a.scope === "standing"),
    );
    expect(standing.map((a) => a.id).sort()).toEqual(["A-1", "A-2"]);
    expect(store.verifyToken(officeToken)?.allowed_tools).toContain(
      "record_decision",
    );
    expect(store.verifyToken(opsToken)?.allowed_tools ?? []).not.toContain(
      "record_decision",
    );
  } finally {
    store.close();
  }

  // Re-issuing the Office token leaves the Ops token alone, and vice versa.
  expect(await run(["token", "issue", "A-1"])).toBe(0);
  const rotatedOffice = tokenFromOutput();
  const reopened = Store.open({ dataDir });
  try {
    expect(reopened.verifyToken(officeToken)).toBeUndefined();
    expect(reopened.verifyToken(rotatedOffice)).toBeDefined();
    expect(reopened.verifyToken(opsToken)).toBeDefined();
  } finally {
    reopened.close();
  }

  expect(await run(["token", "issue", "A-2"])).toBe(0);
  const rotatedOps = tokenFromOutput();
  const again = Store.open({ dataDir });
  try {
    expect(again.verifyToken(opsToken)).toBeUndefined();
    expect(again.verifyToken(rotatedOffice)).toBeDefined();
    expect(again.verifyToken(rotatedOps)).toBeDefined();
    expect(again.verifyToken(rotatedOps)?.allowed_tools ?? []).not.toContain(
      "record_decision",
    );
  } finally {
    again.close();
  }

  // Asking for --ops again reuses the Ops assignment instead of adding a third.
  expect(await run(["pm", "create", "--ops"])).toBe(0);
  expect(printed()).toContain("复用常驻 PM Ops：A-2");
});

test("pm create --ops drops record_decision and needs the role to have it", async () => {
  expect(await run(["init"])).toBe(0);
  await run(["project", "create", "p-work"]);
  await run([
    "role",
    "add",
    "p-work",
    "pm",
    "--allowed-tools",
    "create_card,assign",
  ]);

  // Without record_decision in the role, the two modes cannot be told apart.
  expect(await run(["pm", "create", "--ops"])).toBe(2);
  expect(errors.join("\n")).toContain("record_decision");

  await run([
    "role",
    "add",
    "p-work",
    "pm",
    "--version",
    "2",
    "--allowed-tools",
    "create_card,assign,record_decision",
  ]);
  // The newest pm role version now allows both modes.
  expect(await run(["pm", "create", "--ops", "--project", "p-work"])).toBe(0);
  expect(printed()).toContain("allowed_tools：create_card, assign");
});

test("human-action done completes the action and requires --text", async () => {
  await bootstrap();
  await run([
    "card",
    "create",
    "--template",
    "dev",
    "--title",
    "T",
    "--goal",
    "G",
    "--acceptance",
    "A",
    "--repo",
    "r/x",
  ]);
  await run(["assign", "W-1", "--role", "coder"]);

  const store = Store.open({ dataDir });
  let action: HumanAction;
  try {
    action = runCommand(store, {
      project_id: "p-work" as never,
      actor: { kind: "human", project_id: "p-work" as never },
      reduce: (state, actor, ports) =>
        requestHumanAction(
          state,
          actor,
          {
            card_id: "C-1" as never,
            instructions: "Fictional manual step",
            why_human: "needs a credential",
            expected_return: "confirmation",
            blocked_work_items: [],
          },
          ports,
        ),
    });
  } finally {
    store.close();
  }

  expect(await run(["human-action", "done", action.id])).toBe(2);
  expect(errors.join("\n")).toContain("--text");

  // C-132: new actions are H-n; the legacy h(n) spelling still finds them.
  expect(action.id).toMatch(/^H-[1-9][0-9]*$/u);
  expect(
    await run([
      "human-action",
      "done",
      action.id.replace(/^H-(\d+)$/u, "h($1)"),
      "--text",
      "fictional result",
    ]),
  ).toBe(0);
  expect(printed()).toContain(`已完成 ${action.id}：done`);

  const reopened = Store.open({ dataDir });
  try {
    const stored = reopened.uow.read((tx) =>
      tx.human_actions.get("p-work" as never, action.id),
    );
    expect(stored?.status).toBe("done");
    expect(stored?.result?.text).toBe("fictional result");
  } finally {
    reopened.close();
  }
});

test("assign rejects a role that does not match the work item", async () => {
  await bootstrap();
  await run([
    "card",
    "create",
    "--template",
    "dev",
    "--title",
    "T",
    "--goal",
    "G",
    "--acceptance",
    "A",
    "--repo",
    "r/x",
  ]);
  expect(await run(["assign", "W-1", "--role", "reviewer"])).toBe(2);
  expect(errors.join("\n")).toContain("指派的角色必须与工作项要求一致");
});

test("assign --start hands off without printing a token", async () => {
  await bootstrap();
  await run([
    "card",
    "create",
    "--template",
    "dev",
    "--title",
    "T",
    "--goal",
    "G",
    "--acceptance",
    "A",
    "--repo",
    "r/x",
  ]);

  const calls: Array<{ assignment_id: string; project_id: string }> = [];
  const code = await main(["assign", "W-1", "--role", "coder", "--start"], io, {
    start: async (options) => {
      calls.push({
        assignment_id: options.assignment_id,
        project_id: options.project_id,
      });
      options.io.stdout(`已启动 ${options.assignment_id}`);
      return 0;
    },
  });

  expect(code).toBe(0);
  expect(calls).toEqual([{ assignment_id: "A-1", project_id: "p-work" }]);
  // One command from a card to a running Agent: the token lives in the run
  // directory only, so nothing token-shaped is printed here.
  expect(printed()).toContain("已启动 A-1");
  expect(printed()).not.toContain("token_id");
  expect(printed()).not.toContain("Token");

  // No token was issued outside the run directory either.
  const store = Store.open({ dataDir });
  try {
    expect(
      store.uow.run((tx) =>
        tx.tokensForAssignment("p-work" as never, "A-1" as never),
      ),
    ).toHaveLength(0);
  } finally {
    store.close();
  }
});

/** Create the two standing PM assignments (Office and Ops). */
async function createPmPair(): Promise<void> {
  await run(["init"]);
  await run(["project", "create", "p-work"]);
  await run([
    "role",
    "add",
    "p-work",
    "pm",
    "--allowed-tools",
    "create_card,assign,record_decision",
  ]);
  expect(await run(["pm", "create", "--office", "--project", "p-work"])).toBe(
    0,
  );
  expect(await run(["pm", "create", "--ops", "--project", "p-work"])).toBe(0);
}

test("pm start launches Office and Ops through the one-command start", async () => {
  await createPmPair();

  const calls: string[] = [];
  const code = await main(["pm", "start", "--project", "p-work"], io, {
    start: async (options) => {
      calls.push(options.assignment_id);
      options.io.stdout(`started ${options.assignment_id}`);
      return 0;
    },
  });

  expect(code).toBe(0);
  // Both standing assignments, in creation order.
  expect(calls).toEqual(["A-1", "A-2"]);
  expect(printed()).toContain("已启动 2 个常驻 PM");
  expect(printed()).toContain("started A-1");
  expect(printed()).toContain("started A-2");
});

test("pm start skips a PM that already has an unfinished Run", async () => {
  await createPmPair();
  const store = Store.open({ dataDir });
  try {
    runCommand(store, {
      project_id: "p-work" as never,
      actor: { kind: "human", project_id: "p-work" as never },
      reduce: (state, actor, ports) =>
        queueRun(
          state,
          actor,
          {
            assignment_id: "A-1" as never,
            model: "fixture-model",
            agent_cli_version: "pi 1.5.0",
          },
          ports,
        ),
    });
  } finally {
    store.close();
  }

  const calls: string[] = [];
  const code = await main(["pm", "start", "--project", "p-work"], io, {
    start: async (options) => {
      calls.push(options.assignment_id);
      return 0;
    },
  });

  expect(code).toBe(0);
  expect(calls).toEqual(["A-2"]);
  expect(printed()).toContain("PM Office（A-1）已在运行，跳过");
});

test("pm start can start one mode and refuses when no PM exists", async () => {
  await createPmPair();

  const calls: string[] = [];
  expect(
    await main(["pm", "start", "--ops", "--project", "p-work"], io, {
      start: async (options) => {
        calls.push(options.assignment_id);
        return 0;
      },
    }),
  ).toBe(0);
  expect(calls).toEqual(["A-2"]);

  // A fresh project has no standing PM assignments yet.
  expect(await run(["project", "create", "p-other"])).toBe(0);
  expect(await run(["pm", "start", "--project", "p-other"])).toBe(2);
  expect(errors.join("\n")).toContain("pm create");
});

test("C-154: pm restart reopens one standing PM session without pausing it", async () => {
  await createPmPair();
  const calls: { id: string; restart?: boolean }[] = [];
  const start = async (options: {
    assignment_id: string;
    restart_session?: boolean;
  }) => {
    calls.push({
      id: options.assignment_id,
      ...(options.restart_session ? { restart: true } : {}),
    });
    return 0;
  };
  expect(
    await main(["pm", "restart", "--ops", "--project", "p-work"], io, {
      start,
    }),
  ).toBe(0);
  expect(calls).toEqual([{ id: "A-2", restart: true }]);
  expect(printed()).toContain("已重开 PM Ops（A-2）的会话");
  expect(printed()).toContain("待处理事项没有转交");
  // Exactly one mode, as for pm rotate.
  expect(
    await main(["pm", "restart", "--project", "p-work"], io, { start }),
  ).toBe(2);
  expect(calls).toHaveLength(1);
  // A paused PM is resumed with pm start, never restarted.
  const store = Store.open({ dataDir });
  try {
    runCommand(store, {
      project_id: "p-work" as never,
      actor: { kind: "human", project_id: "p-work" as never },
      reduce: (state, actor, ports) =>
        pauseStandingAssignment(
          state,
          actor,
          { assignment_id: "A-1" as never },
          ports,
        ),
    });
  } finally {
    store.close();
  }
  expect(
    await main(["pm", "restart", "--office", "--project", "p-work"], io, {
      start,
    }),
  ).toBe(2);
  expect(errors.join("\n")).toContain("cardigan pm start --office");
  expect(calls).toHaveLength(1);
});

test("needs-you lists open human decisions and pending human actions", async () => {
  await bootstrap();
  await run([
    "card",
    "create",
    "--template",
    "dev",
    "--title",
    "T",
    "--goal",
    "G",
    "--acceptance",
    "A",
    "--repo",
    "r/x",
  ]);
  await run(["assign", "W-1", "--role", "coder"]);
  // Recording a decision is PM Office's job (§10.4), so the test needs one.
  await run(["pm", "create", "--office", "--project", "p-work"]);

  const store = Store.open({ dataDir });
  try {
    const human = { kind: "human", project_id: "p-work" as never } as const;
    const office = store.uow.read((tx) =>
      tx.assignments
        .list("p-work" as never)
        .find((candidate) => candidate.scope === "standing"),
    );
    if (office === undefined) throw new Error("no PM Office assignment");
    const decision = runCommand(store, {
      project_id: "p-work" as never,
      actor: human,
      reduce: (state, actor, ports) =>
        requestDecision(
          state,
          actor,
          {
            card_id: "C-1" as never,
            category: "general",
            kind: "choose",
            question: "Which shape should the API take?",
            context: "Two options look reasonable",
            options: [
              { key: "a", description: "REST", impact: "Simpler" },
              { key: "b", description: "RPC", impact: "Faster" },
            ],
            recommended: "a",
            affected_cards: ["C-1" as never],
            affected_work_items: ["W-1" as never],
            blocking: false,
            decider: "human",
            plain_summary: TEST_PLAIN_SUMMARY,
          },
          ports,
        ),
    });
    const action = runCommand(store, {
      project_id: "p-work" as never,
      actor: human,
      reduce: (state, actor, ports) =>
        requestHumanAction(
          state,
          actor,
          {
            card_id: "C-1" as never,
            instructions: "Connect the device",
            why_human: "Only a human has hands",
            expected_return: "a photo",
            blocked_work_items: [],
          },
          ports,
        ),
    });
    // A decision for a role never shows up here.
    runCommand(store, {
      project_id: "p-work" as never,
      actor: human,
      reduce: (state, actor, ports) =>
        requestDecision(
          state,
          actor,
          {
            card_id: "C-1" as never,
            category: "general",
            kind: "choose",
            question: "Internal choice",
            context: "PM decides",
            options: [
              { key: "a", description: "Do it", impact: "Faster" },
              { key: "b", description: "Skip", impact: "Cheaper" },
            ],
            recommended: "a",
            affected_cards: ["C-1" as never],
            affected_work_items: [],
            blocking: false,
            decider: "role:pm",
            // No active PM Ops: it falls back to the human, so it needs one.
            plain_summary: TEST_PLAIN_SUMMARY,
          },
          ports,
        ),
    });

    expect(await run(["needs-you", "--project", "p-work"])).toBe(0);
    const text = printed();
    expect(text).toContain(decision.id);
    expect(text).toContain("Which shape should the API take?");
    expect(text).toContain(action.id);
    expect(text).toContain("Connect the device");
    expect(text).toContain("Only a human has hands");
    expect(text).toContain("a photo");
    expect(text).toContain("Internal choice"); // No active PM Ops: human fallback.

    // Answering the decision clears it from the view; only Office may record it.
    runCommand(store, {
      project_id: "p-work" as never,
      actor: {
        kind: "assignment",
        project_id: "p-work" as never,
        assignment_id: office.id,
        role_id: office.role_id,
        role_version: office.role_version,
        allowed_tools: ["record_decision"],
      } as never,
      reduce: (state, actor, ports) =>
        recordDecision(
          state,
          actor,
          {
            decision_id: decision.id,
            option: "a",
            rationale: "REST is simpler",
            raw_quote: "选 A",
          },
          ports,
        ),
    });
    expect(await run(["needs-you", "--project", "p-work"])).toBe(0);
    expect(printed()).not.toContain("Which shape should the API take?");
    expect(printed()).toContain("Connect the device");
  } finally {
    store.close();
  }
});

test("needs-you says so when nothing is waiting for the human", async () => {
  await bootstrap();
  expect(await run(["needs-you", "--project", "p-work"])).toBe(0);
  expect(printed()).toContain("Needs You 是空的");
});

test("needs-you lists 知会 newest first and marks them read like the Workbench", async () => {
  await bootstrap();
  await run([
    "card",
    "create",
    "--template",
    "dev",
    "--title",
    "T",
    "--goal",
    "G",
    "--acceptance",
    "A",
    "--repo",
    "r/x",
  ]);
  // PM Ops needs the default pm pack's resolve_delegated_decision tool.
  expect(await run(["role", "upgrade", "pm", "--from-default"])).toBe(0);
  expect(await run(["pm", "create", "--ops", "--project", "p-work"])).toBe(0);

  const store = Store.open({ dataDir });
  try {
    const human = { kind: "human", project_id: "p-work" as never } as const;
    const ops = store.uow.read((tx) =>
      tx.assignments
        .list("p-work" as never)
        .find((candidate) => candidate.standing_mode === "ops"),
    );
    if (ops === undefined) throw new Error("no PM Ops assignment");
    const opsActor = {
      kind: "assignment",
      project_id: "p-work" as never,
      assignment_id: ops.id,
      role_id: ops.role_id,
      role_version: ops.role_version,
      allowed_tools: ["resolve_delegated_decision"],
    } as never;
    // Two general decisions PM Ops decides under project authorization.
    const delegated = (question: string, rationale: string) => {
      const q = runCommand(store, {
        project_id: "p-work" as never,
        actor: human,
        reduce: (state, actor, ports) =>
          requestDecision(
            state,
            actor,
            {
              card_id: "C-1" as never,
              category: "general",
              kind: "choose",
              question,
              context: "背景",
              options: [{ key: "a", description: "方案 A", impact: "影响" }],
              recommended: "a",
              affected_cards: [],
              affected_work_items: [],
              blocking: false,
              decider: "human",
              plain_summary: TEST_PLAIN_SUMMARY,
            },
            ports,
          ),
      });
      expect(q.decider).toBe("role:pm");
      runCommand(store, {
        project_id: "p-work" as never,
        actor: opsActor,
        reduce: (state, actor, ports) =>
          resolveDelegatedDecision(
            state,
            actor,
            { decision_id: q.id, option: "a", rationale },
            ports,
          ),
      });
      return q.id;
    };
    const older = delegated("Older question?", "first reason");
    const newer = delegated("Newer question?", "second reason");

    expect(await run(["needs-you", "--project", "p-work"])).toBe(0);
    let text = printed();
    expect(text).toContain("知会（未读 2，共 2）");
    expect(text).not.toContain("Needs You 是空的");
    expect(text).toContain("方案 A。理由：second reason");
    expect(text.indexOf(newer)).toBeLessThan(text.indexOf(older));
    const ids = [
      ...text.matchAll(/\[未读\] (\S+) {2}PM 代拍 {2}(\S+) {2}C-1/g),
    ].map((m) => ({ id: m[1] as string, decision: m[2] }));
    expect(ids.map((n) => n.decision)).toEqual([newer, older]);

    // Mark one notice read by id: it stays listed, flagged read.
    const first = ids[0]?.id as string;
    expect(await run(["needs-you", "read", first, "--project", "p-work"])).toBe(
      0,
    );
    expect(printed()).toContain("已标为已读 1 条知会");
    expect(await run(["needs-you", "--project", "p-work"])).toBe(0);
    text = printed();
    expect(text).toContain("知会（未读 1，共 2）");
    expect(text).toContain(`[已读] ${first}`);
    expect(text).toContain(`[未读] ${ids[1]?.id}`);
    // Marking again is idempotent; an unknown id is refused.
    expect(await run(["needs-you", "read", first, "--project", "p-work"])).toBe(
      0,
    );
    expect(printed()).toContain("已经是已读");
    expect(
      await run(["needs-you", "read", "missing", "--project", "p-work"]),
    ).toBe(2);
    expect(errors.join("\n")).toContain("missing");
    expect(await run(["needs-you", "read", "--project", "p-work"])).toBe(2);

    // --all marks every remaining unread notice.
    expect(
      await run(["needs-you", "read", "--all", "--project", "p-work"]),
    ).toBe(0);
    expect(printed()).toContain("已标为已读 1 条知会");
    expect(await run(["needs-you", "--project", "p-work"])).toBe(0);
    expect(printed()).toContain("知会（未读 0，共 2）");
    expect(printed()).not.toContain("[未读]");
    expect(
      await run(["needs-you", "read", "--all", "--project", "p-work"]),
    ).toBe(0);
    expect(printed()).toContain("没有未读的知会");
    // Rendering follows the recorded action, including failures after confirmation.
    store.uow.run((tx) => {
      const project = human.project_id;
      const q = tx.decisions.get(project, newer);
      if (!q) throw new Error("Missing notice decision");
      tx.decisions.put(project, {
        ...q,
        kind: "approve",
        target: { delivery_id: "D-1" as never },
        trigger: "merge_confirmation",
      });
      let at = Date.parse("2099-01-01T00:00:00Z");
      for (const [type, option, actor] of [
        ["decision_resolved", "merge", opsActor],
        ["merge_changes_requested", "request_changes", opsActor],
        ["merge_check_requeued", "recheck", opsActor],
        ["decision_resolved", "merge", { kind: "system", project_id: project }],
      ] as const) {
        tx.events.append(project, {
          id: tx.ids.nextEventId(),
          seq: tx.ids.nextEventSequence(project, "C-1" as never),
          card_id: "C-1" as never,
          type,
          actor,
          created_at: new Date(at++).toISOString(),
          payload: {
            decision_id: newer,
            option,
            via: "delegated",
            notice: "已处理。",
          },
        });
      }
      // C-177: a stall alert on a still-open confirmation is not an auto-merge.
      tx.events.append(project, {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(project, "C-1" as never),
        card_id: "C-1" as never,
        type: PM_MERGE_STALL_KIND,
        actor: { kind: "system", project_id: project },
        created_at: new Date(at++).toISOString(),
        payload: {
          decision_id: newer,
          notice: "PM 持有的合并确认已停留 65 分钟（C-1）",
        },
      });
    });
    expect(await run(["needs-you", "--project", "p-work"])).toBe(0);
    for (const label of [
      "PM 代确认合并",
      "PM 退回修改",
      "PM 重新检查",
      "超时自动合并",
      "PM 合并确认停留",
    ])
      expect(printed()).toContain(`  ${label}  ${newer}`);
    const lines = printed().split("\n");
    const stallLine = lines.findIndex((line) =>
      line.includes(`  PM 合并确认停留  ${newer}`),
    );
    expect(lines[stallLine]).not.toContain("超时自动合并");
    expect(lines.slice(stallLine, stallLine + 3).join("\n")).toContain(
      "PM 持有的合并确认已停留 65 分钟（C-1）",
    );
    expect(
      lines.filter((line) => line.includes(`超时自动合并  ${newer}`)),
    ).toHaveLength(1);
  } finally {
    store.close();
  }
});

test("M4.5: pm create writes the standing mode once and never changes it", async () => {
  await bootstrap();
  expect(await run(["pm", "create", "--ops"])).toBe(0);
  const store = Store.open({ dataDir });
  try {
    expect(
      store.uow.read((tx) =>
        tx.assignments.get("p-work" as never, "A-1" as never),
      )?.standing_mode,
    ).toBe("ops");
  } finally {
    store.close();
  }

  // Asking for Office later does not promote the Ops Assignment; it seats the
  // second standing Assignment, and Ops keeps its mode.
  expect(await run(["pm", "create", "--office"])).toBe(0);
  const reopened = Store.open({ dataDir });
  try {
    expect(
      reopened.uow.read((tx) =>
        tx.assignments
          .list("p-work" as never)
          .filter((assignment) => assignment.scope === "standing")
          .map((assignment) => [assignment.id, assignment.standing_mode]),
      ),
    ).toEqual([
      ["A-1", "ops"],
      ["A-2", "office"],
    ]);
  } finally {
    reopened.close();
  }
});

test("M4.5: a legacy standing row is inferred from its newest token once", async () => {
  await bootstrap();
  expect(await run(["pm", "create", "--ops"])).toBe(0);
  const opsToken = tokenFromOutput();

  // Simulate a row written before the field existed: same token, no mode.
  const store = Store.open({ dataDir });
  try {
    store.uow.run((tx) => {
      const current = tx.assignments.get("p-work" as never, "A-1" as never);
      if (current === undefined) throw new Error("missing assignment");
      const { standing_mode, ...legacy } = current;
      void standing_mode;
      tx.assignments.put("p-work" as never, legacy);
    });
  } finally {
    store.close();
  }

  expect(await run(["token", "issue", "A-1"])).toBe(0);
  const rotated = tokenFromOutput();
  const reopened = Store.open({ dataDir });
  try {
    expect(
      reopened.uow.read((tx) =>
        tx.assignments.get("p-work" as never, "A-1" as never),
      )?.standing_mode,
    ).toBe("ops");
    expect(reopened.verifyToken(opsToken)).toBeUndefined();
    expect(reopened.verifyToken(rotated)?.allowed_tools ?? []).not.toContain(
      "record_decision",
    );
  } finally {
    reopened.close();
  }
});

test("assign --employee accepts IDs and case-insensitive names and explains rejection in Chinese", async () => {
  await bootstrap();
  for (const name of ["Alice", "Bob"])
    expect(
      await run([
        "employee",
        "add",
        "--name",
        name,
        "--title",
        "开发",
        "--role",
        "coder",
      ]),
    ).toBe(0);
  expect(
    await run([
      "employee",
      "add",
      "--name",
      "alice",
      "--title",
      "开发",
      "--role",
      "coder",
    ]),
  ).not.toBe(0);
  expect(errors.join("\n")).toContain("在职员工");
  for (const reference of ["aLIce", "E-2", undefined]) {
    expect(
      await run([
        "card",
        "create",
        "--template",
        "dev",
        "--title",
        "Employee",
        "--goal",
        "Ship",
        "--acceptance",
        "Pass",
        "--repo",
        "fixture",
      ]),
    ).toBe(0);
    const n = reference === "aLIce" ? 1 : reference === "E-2" ? 4 : 7;
    expect(
      await run([
        "assign",
        `W-${n}`,
        "--role",
        "coder",
        ...(reference ? ["--employee", reference] : []),
      ]),
    ).toBe(0);
    expect(printed()).toContain(`员工 ${reference === "E-2" ? "E-2" : "E-1"}`);
  }
  expect(
    await run(["assign", "W-1", "--role", "coder", "--employee", "E-2"]),
  ).not.toBe(0);
  expect(errors.join("\n")).toContain("员工创建后不能修改");
  expect(await run(["employee", "deactivate", "E-2"])).toBe(0);
  expect(
    await run([
      "card",
      "create",
      "--template",
      "dev",
      "--title",
      "Inactive",
      "--goal",
      "Ship",
      "--acceptance",
      "Pass",
      "--repo",
      "fixture",
    ]),
  ).toBe(0);
  expect(
    await run(["assign", "W-10", "--role", "coder", "--employee", "E-2"]),
  ).not.toBe(0);
  expect(errors.join("\n")).toContain("已停用");
});

test("assign excludes external Office employees while external rotation and ordinary assignment still work", async () => {
  await bootstrap();
  expect(await run(["pm", "create", "--office"])).toBe(0);
  expect(
    await run([
      "employee",
      "add",
      "--name",
      "External Office",
      "--title",
      "PM",
      "--role",
      "pm",
    ]),
  ).toBe(0);
  const rotate = [
    "pm",
    "rotate",
    "--office",
    "--external",
    "--employee",
    "E-1",
  ];
  expect(await run(rotate)).toBe(0);
  expect(await run(rotate)).toBe(0);
  expect(
    await run([
      "card",
      "create",
      "--template",
      "dev",
      "--title",
      "External employee",
      "--goal",
      "Ship",
      "--acceptance",
      "Pass",
      "--repo",
      "fixture",
    ]),
  ).toBe(0);
  for (const reference of ["E-1", "external office", undefined]) {
    expect(
      await run([
        "assign",
        "W-3",
        "--role",
        "pm",
        ...(reference ? ["--employee", reference] : []),
      ]),
    ).toBe(2);
    expect(errors.join("\n")).toContain("外接员工，不由 Cardigan 启动");
  }
  const store = Store.open({ dataDir });
  try {
    expect(
      store.uow
        .read((tx) => tx.work_items.list("p-work"))
        .find((w) => w.id === "W-3")?.assignment_id,
    ).toBeUndefined();
  } finally {
    store.close();
  }
  expect(
    await run([
      "employee",
      "add",
      "--name",
      "Internal PM",
      "--title",
      "PM",
      "--role",
      "pm",
    ]),
  ).toBe(0);
  expect(await run(["assign", "W-3", "--role", "pm"])).toBe(0);
  expect(printed()).toContain("员工 E-2");
});
