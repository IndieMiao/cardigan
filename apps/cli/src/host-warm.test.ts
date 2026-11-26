import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Decision,
  type ProjectId,
  recordDecision,
  requestDecision,
} from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import { Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test } from "vitest";
import { CliError } from "./errors.js";
import { humanActor, runCommand } from "./host.js";
import { main } from "./index.js";
import type { CliIo } from "./io.js";

const project = "p-warm" as ProjectId;
let dataDir: string;
const opened: Store[] = [];
const open = () => {
  const store = Store.open({ dataDir });
  opened.push(store);
  return store;
};

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "cardigan-cli-warm-"));
  const io: CliIo = {
    env: { CARDIGAN_DATA_DIR: dataDir },
    cwd: dataDir,
    platform: "linux",
    stdout: () => undefined,
    stderr: () => undefined,
    signals: { on: () => undefined, off: () => undefined },
    spawnInherit: () => {
      throw new Error("must not spawn");
    },
    captureCommand: async () => {
      throw new Error("must not spawn");
    },
  };
  expect(await main(["project", "create", project, "--code", "TWRM"], io)).toBe(
    0,
  );
});
afterEach(() => {
  for (const store of opened.splice(0)) store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function ask(store: Store, question: string): Decision {
  return runCommand(store, {
    project_id: project,
    actor: humanActor(project),
    reduce: (s, a, p) =>
      requestDecision(
        s,
        a,
        {
          category: "general",
          kind: "choose",
          question,
          context: "C-780",
          options: [
            { key: "a", description: "甲", impact: "甲" },
            { key: "b", description: "乙", impact: "乙" },
          ],
          recommended: "a",
          affected_cards: [],
          affected_work_items: [],
          blocking: false,
          decider: "human",
          plain_summary: { changed: "测试", impact: "测试", risk: "无" },
        },
        p,
      ),
  });
}

const answer = (decision_id: Decision["id"], option: string) =>
  ({
    project_id: project,
    actor: humanActor(project),
    reduce: (s, a, p) =>
      recordDecision(
        s,
        a,
        { decision_id, option, rationale: option, raw_quote: option },
        p,
      ),
  }) satisfies Parameters<typeof runCommand<unknown>>[1];

/** Record, in order, which transaction each command-state build ran in. */
function observe(store: Store) {
  const log: string[] = [];
  store.observe({
    stateBuild: () => log.push("build"),
    transaction: (kind) => log.push(kind),
    writeLock: () => undefined,
  });
  return log;
}

test("C-780: a cold CLI process builds command state before taking the write lock", () => {
  const seed = open();
  ask(seed, "预置历史");
  seed.close();
  opened.splice(opened.indexOf(seed), 1);

  const cli = open();
  const log = observe(cli);
  ask(cli, "冷进程的写命令");
  // The build happens in the warm read; the write transaction only rechecks
  // the version and hits the cache.
  expect(log).toEqual(["build", "read", "run"]);
});

test("C-780: a write committed between the warm read and the write lock is seen, not the stale warm state", () => {
  const setup = open();
  const decision = ask(setup, "预热期间被别人回答");
  const other = open();
  const cli = open();
  const log = observe(cli);
  // Another process answers the decision right after the CLI's warm read.
  const read = cli.uow.read.bind(cli.uow);
  const racing = Object.create(cli, {
    uow: {
      value: {
        run: cli.uow.run.bind(cli.uow),
        read: <T>(operation: Parameters<typeof read<T>>[0]): T => {
          const value = read(operation);
          runCommand(other, answer(decision.id, "b"));
          return value;
        },
      },
    },
  }) as Store;

  let seenInWrite: Decision["status"] | undefined;
  expect(() =>
    runCommand(racing, {
      ...answer(decision.id, "a"),
      reduce: (s, a, p) => {
        seenInWrite = s.decisions.find((d) => d.id === decision.id)?.status;
        return recordDecision(
          s,
          a,
          {
            decision_id: decision.id,
            option: "a",
            rationale: "a",
            raw_quote: "a",
          },
          p,
        );
      },
    }),
  ).toThrow(CliError);
  // The warm read built the old version; the write transaction rebuilt it at
  // the newer committed version and rejected the command against it.
  expect(log).toEqual(["build", "read", "build", "run"]);
  expect(seenInWrite).toBe("resolved");
  const final = cli.uow
    .read((tx) => loadCommandState(tx, project))
    .decisions.find((d) => d.id === decision.id);
  expect(final?.status).toBe("resolved");
  expect(final?.resolution?.option).toBe("b");
});
