import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DECISION_OTHER_OPTION,
  type ProjectId,
  requestDecision,
} from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import { Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test } from "vitest";
import { cliTool } from "./command-access.js";
import { humanActor, runCommand } from "./host.js";
import { main } from "./index.js";
import type { CliIo } from "./io.js";

const project = "p-decision" as ProjectId;
let dataDir: string, store: Store, io: CliIo;
let output: string[], errors: string[];
const snapshot = () => store.uow.read((tx) => loadCommandState(tx, project));
async function run(args: string[]) {
  output = [];
  errors = [];
  return main(args, io);
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "cardigan-cli-decision-"));
  io = {
    env: { CARDIGAN_DATA_DIR: dataDir },
    cwd: dataDir,
    platform: "linux",
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
    signals: { on: () => undefined, off: () => undefined },
    spawnInherit: () => {
      throw new Error("must not spawn");
    },
    captureCommand: async () => {
      throw new Error("must not spawn");
    },
  };
  expect(await run(["project", "create", project, "--code", "TDEC"])).toBe(0);
  store = Store.open({ dataDir });
});
afterEach(() => {
  store?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("C-682: decision answer --other closes any open decision with the human's words; blank words are rejected", async () => {
  expect(cliTool("decision answer")).toBeNull();
  const decision = runCommand(store, {
    project_id: project,
    actor: humanActor(project),
    reduce: (s, a, p) =>
      requestDecision(
        s,
        a,
        {
          category: "spending",
          kind: "choose",
          question: "额度用完了，要不要提高支出上限？",
          context: "GitHub Actions 额度用完",
          options: [
            { key: "raise_limit", description: "提高上限", impact: "花钱" },
          ],
          recommended: "raise_limit",
          affected_cards: [],
          affected_work_items: [],
          blocking: false,
          decider: "human",
          plain_summary: { changed: "额度", impact: "检查暂停", risk: "花钱" },
        },
        p,
      ),
  });
  const before = snapshot();
  for (const args of [
    ["decision", "answer", decision.id],
    ["decision", "answer", decision.id, "--other", "   "],
    ["decision", "answer", decision.id, "--option", "raise_limit"],
    ["decision", "resolve", decision.id, "--other", "x"],
  ])
    expect(await run(args)).toBe(2);
  expect(snapshot()).toEqual(before);
  expect(
    await run([
      "decision",
      "answer",
      decision.id,
      "--other",
      "把仓库转为公开",
      "--project",
      project,
    ]),
  ).toBe(0);
  expect(output.join("\n")).toContain("已按“其他”结项");
  expect(snapshot().decisions.find((q) => q.id === decision.id)).toMatchObject({
    status: "resolved",
    resolution: {
      option: DECISION_OTHER_OPTION,
      raw_quote: "把仓库转为公开",
      resolved_by: "human",
    },
  });
  expect(
    await run(["decision", "answer", decision.id, "--other", "再来一次"]),
  ).not.toBe(0);
});
