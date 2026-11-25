import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectId } from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import { Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test } from "vitest";
import { main } from "./index.js";
import type { CliIo } from "./io.js";
import {
  openHumanCardTemplates,
  registerTemplateRoles,
} from "./template-fixtures.js";

const alpha = "alpha" as ProjectId;
const beta = "beta" as ProjectId;
let dataDir: string;
let output: string[];
let errors: string[];
let env: Record<string, string>;

const io = (): CliIo => ({
  env,
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
});

async function run(args: string[]): Promise<number> {
  output = [];
  errors = [];
  return main(args, io());
}

async function createCard(project: ProjectId, title: string): Promise<void> {
  expect(
    await run([
      "card",
      "create",
      "--template",
      "dev",
      "--title",
      title,
      "--goal",
      "goal",
      "--acceptance",
      "criterion",
      "--repo",
      "example/repo",
      "--project",
      project,
    ]),
    errors.join("\n"),
  ).toBe(0);
}

function titles(project: ProjectId): Record<string, string> {
  const store = Store.open({ dataDir });
  try {
    return Object.fromEntries(
      store.uow
        .read((tx) => loadCommandState(tx, project))
        .cards.map((card) => [card.id, card.title]),
    );
  } finally {
    store.close();
  }
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "cardigan-qualified-args-"));
  env = { CARDIGAN_DATA_DIR: dataDir };
  for (const [project, code] of [
    [alpha, "ALP"],
    [beta, "BET"],
  ] as const) {
    expect(await run(["project", "create", project, "--code", code])).toBe(0);
    const setup = Store.open({ dataDir });
    try {
      registerTemplateRoles(setup, project);
      openHumanCardTemplates(setup, project);
    } finally {
      setup.close();
    }
  }
  // alpha has C-1; beta has C-1 and C-2.
  await createCard(alpha, "alpha one");
  await createCard(beta, "beta one");
  await createCard(beta, "beta two");
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

test("C-675: a full number picks its project without --project", async () => {
  expect(await run(["card", "update", "BET-C-1", "--title", "B1"])).toBe(0);
  expect(output.join("\n")).toContain("C-1");
  expect(titles(beta)["C-1"]).toBe("B1");
  expect(titles(alpha)["C-1"]).toBe("alpha one");

  // `--flag=value` and comma lists are read too; free text is never rewritten.
  expect(
    await run([
      "card",
      "update",
      "ALP-C-1",
      "--title",
      "BET-C-2",
      "--superseded-by=ALP-C-1",
    ]),
  ).toBe(2);
  // Reached the command in alpha (a card cannot supersede itself), not refused for mixing projects.
  expect(errors.join("\n")).not.toContain("属于不同项目");
  expect(await run(["card", "update", "ALP-C-1", "--title", "BET-C-2"])).toBe(
    0,
  );
  expect(titles(alpha)["C-1"]).toBe("BET-C-2");
  expect(titles(beta)["C-2"]).toBe("beta two");

  // A matching --project is fine.
  expect(
    await run(["card", "update", "BET-C-2", "--title", "B2", "--project=beta"]),
  ).toBe(0);
  expect(titles(beta)["C-2"]).toBe("B2");
});

test("C-675: a full number that disagrees with --project is refused", async () => {
  const before = [titles(alpha), titles(beta)];
  expect(
    await run([
      "card",
      "update",
      "BET-C-1",
      "--title",
      "x",
      "--project",
      "alpha",
    ]),
  ).toBe(2);
  expect(errors.join("\n")).toBe(
    "完整编号 BET-C-1 属于项目 beta，与 --project alpha 不一致",
  );
  // Two projects' full numbers in one command, and unknown codes, are refused too.
  expect(
    await run([
      "card",
      "update",
      "ALP-C-1",
      "--title",
      "x",
      "--superseded-by",
      "BET-C-2",
    ]),
  ).toBe(2);
  expect(errors.join("\n")).toContain("ALP-C-1、BET-C-2 属于不同项目");
  expect(await run(["card", "update", "ZZZ-C-1", "--title", "x"])).toBe(2);
  expect(errors.join("\n")).toContain("代号 ZZZ 没有登记给任何项目");
  expect([titles(alpha), titles(beta)]).toEqual(before);
});

test("C-675: CARDIGAN_PROJECT is a default; a full number still picks its project", async () => {
  env = { ...env, CARDIGAN_PROJECT: alpha };
  expect(await run(["card", "update", "BET-C-1", "--title", "B1"])).toBe(0);
  expect(titles(beta)["C-1"]).toBe("B1");
  // An empty --project is no project: the full number still decides.
  expect(
    await run(["card", "update", "BET-C-2", "--title", "B2", "--project="]),
  ).toBe(0);
  expect(titles(beta)["C-2"]).toBe("B2");
  expect(titles(alpha)["C-2"]).toBeUndefined();
  // Short numbers keep using the context.
  expect(await run(["card", "update", "C-1", "--title", "A1"])).toBe(0);
  expect(titles(alpha)["C-1"]).toBe("A1");
});

test("C-675: without a project, a short number several projects share is refused", async () => {
  const before = [titles(alpha), titles(beta)];
  expect(await run(["card", "update", "C-1", "--title", "x"])).toBe(2);
  expect(errors.join("\n")).toBe(
    "C-1 在多个项目里都有：ALP-C-1（alpha）、BET-C-1（beta）；请改用完整编号，或用 --project 指定项目",
  );
  expect([titles(alpha), titles(beta)]).toEqual(before);

  // One only beta has resolves there; one no project has keeps the old refusal.
  expect(await run(["card", "update", "C-2", "--title", "B2"])).toBe(0);
  expect(titles(beta)["C-2"]).toBe("B2");
  expect(await run(["card", "update", "C-9", "--title", "x"])).toBe(2);
  expect(errors.join("\n")).toContain("有多个项目，请用 --project 指定");

  // With --project, short numbers resolve in that project as before.
  expect(
    await run(["card", "update", "C-1", "--title", "A1", "--project", "alpha"]),
  ).toBe(0);
  expect(titles(alpha)["C-1"]).toBe("A1");
});
