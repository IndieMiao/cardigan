import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HumanAction } from "@cardigan/domain";
import { expect, test } from "vitest";
import { migrate, Store } from "./index.js";
import { migrationsThrough } from "./test-support.js";

const base = {
  requested_by: "assignment:A-1",
  why_human: "需要人确认",
  expected_return: "结果",
  blocked_work_items: [],
  status: "open",
} as const;
const action = (id: string, extra: Partial<HumanAction>): HumanAction =>
  ({
    ...base,
    id,
    key: id,
    card_id: "C-1",
    instructions: "请处理",
    ...extra,
  }) as HumanAction;

test("C-742: upgrading marks open 张良 actions as operator and leaves the rest", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cardigan-operator-actions-"));
  const store = Store.open({
    dataDir,
    migrationsDir: migrationsThrough(dataDir, 1795539364086),
  });
  try {
    const actions = [
      action("H-1", { instructions: "张良：换主机运维会话" }),
      action("H-2", { why_human: "需要上传 OSS" }),
      action("H-3", {
        handoff: { title: "张良：停卡住会话" } as HumanAction["handoff"],
      }),
      action("H-4", { instructions: "所有者：登录 GitHub" }),
      action("H-5", { instructions: "张良：已完成", status: "done" }),
      action("H-6", { instructions: "张良：系统", requested_by: "system" }),
      action("H-7", { instructions: "张良：显式", executor: "owner" }),
    ];
    store.uow.run((tx) => {
      for (const a of actions) tx.human_actions.put("cardigan", a);
    });
    expect(migrate(store.database)).toContainEqual({
      version: 1795585467683,
      name: "operator_human_actions",
    });
    const executor = (id: string) =>
      store.uow.read(
        (tx) =>
          tx.human_actions.get("cardigan", id as HumanAction["id"])?.executor,
      );
    expect(actions.map((a) => [a.id, executor(a.id)])).toEqual([
      ["H-1", "operator"],
      ["H-2", "operator"],
      ["H-3", "operator"],
      ["H-4", undefined],
      ["H-5", undefined],
      ["H-6", undefined],
      ["H-7", "owner"],
    ]);
    expect(migrate(store.database)).toEqual([]);
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
