// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { WorkItemView } from "../api.js";
import { cardDetail } from "../testing/fixtures.js";
import { CardWorkItems } from "./CardSidebar.js";

afterEach(cleanup);
const at = "2026-01-01T00:00:00.000Z";

function show(patch: (w: WorkItemView, i: number) => WorkItemView) {
  const detail = cardDetail();
  render(
    <CardWorkItems
      detail={{ ...detail, work_items: detail.work_items.map(patch) }}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  return detail.work_items.map(
    (w) => document.getElementById(`work-item-${w.id}`) as HTMLElement,
  );
}

test("MC-5 work item shows its requirements, the automatic choice with reasons, and every excluded machine", () => {
  const long =
    "服务端远程 Git 工作树准备尚未验证（角色工作树策略：write）".repeat(3);
  const [producer, verifier] = show((w, i) =>
    i === 0
      ? {
          ...w,
          requirements: {
            os: "darwin",
            capabilities: ["godot>=4.7", "ios.simulator"],
            tags: ["office"],
          },
          machine_selection: {
            status: "selected",
            at,
            machine_id: "local",
            assignment_id: "A-1",
            candidates: [
              {
                machine_id: "local",
                affinity: true,
                control_host: false,
                limit: 12,
                occupied: 8,
                remaining_ratio: 1 / 3,
                preference_rank: null,
              },
            ],
            excluded: [
              { machine_id: "cardigan-ci", reasons: [long] },
              {
                machine_id: "mac-mini",
                reasons: ["draining", "tag=office", "godot>=4.7：已过期"],
              },
            ],
          },
        }
      : w,
  );
  const text = producer?.textContent ?? "";
  expect(text).toContain(
    "运行需求：OS darwin；能力 godot>=4.7、ios.simulator；标签 office",
  );
  expect(text).toContain(
    "选机：local（自动选择：同卡产出已在此机器，剩余容量 33%（占用 8/12））",
  );
  const excluded = within(producer as HTMLElement).getByRole("list", {
    name: /未选机器/,
  });
  // Full reasons, never truncated.
  expect(excluded.textContent).toContain(`未选 cardigan-ci：${long}`);
  expect(excluded.textContent).toContain(
    "未选 mac-mini：停止接收新任务；缺少标签 office；godot>=4.7：已过期",
  );
  // Work items without placement data render as before.
  expect(verifier?.textContent).not.toContain("选机");
  expect(verifier?.textContent).not.toContain("运行需求");
});

test("MC-5 a deferred placement shows the recorded reason; an unaudited assignment claims no source", () => {
  const [producer, verifier] = show((w, i) =>
    i === 0
      ? {
          ...w,
          machine_selection: {
            status: "deferred",
            at,
            reason: "有多个候选机器，请明确指定 machine_id：cardigan-ci, local",
          },
        }
      : {
          ...w,
          machine_selection: {
            status: "assigned",
            at,
            machine_id: "mac-mini",
          },
        },
  );
  expect(producer?.textContent).toContain(
    "选机：未选出机器：有多个候选机器，请明确指定 machine_id：cardigan-ci, local",
  );
  expect(verifier?.textContent).toContain("选机：mac-mini（已分配）");
  expect(verifier?.textContent).not.toContain("指定");
  expect(screen.queryByRole("list", { name: /未选机器/ })).toBeNull();
});
