// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { MergeStageView } from "../api.js";
import { ApiError } from "../api.js";
import { DEFAULT_CARD_DISPLAY } from "../card-display.js";
import { parseRoute, routeHash } from "../route.js";
import { card, fakeClient } from "../testing/fixtures.js";
import { BoardCard } from "./BoardCard.js";
import {
  CardBatchChecks,
  groupBatchCards,
  MergeBatchPage,
  MergeStageBadge,
} from "./MergeBatch.js";

afterEach(cleanup);
test.each([
  ["awaiting_confirmation", "待确认"],
  ["queued", "排队中 · 第 2 位"],
  ["held_by_window", "等待合并窗口：保护 C-3"],
  ["batch_checking", "MB-1 批次检查中"],
  ["bisecting", "MB-1 二分定位中"],
  ["culprit", "MB-1 定位为失败原因"],
  ["merged_in_batch", "MB-1 已随批次合并"],
] as const)("renders %s without inventing a card state", (stage, label) => {
  render(
    <MergeStageBadge
      projectId="p"
      card={{
        merge_solo: true,
        merge_stage: {
          stage,
          batch_id: "MB-1",
          position: 2,
          protecting_card_id: "C-3",
        },
      }}
    />,
  );
  expect(screen.getByText(label)).toBeTruthy();
  expect(screen.getByText("单独批次")).toBeTruthy();
});

test("C-677: a window hold names a held protecting card and lists the shared files on hover", () => {
  render(
    <MergeStageBadge
      projectId="p"
      card={{
        merge_stage: {
          stage: "held_by_window",
          protecting_card_id: "C-3",
          protecting_files: ["a.ts", "b.ts"],
          protecting_card_held: true,
        },
      }}
    />,
  );
  expect(
    screen.getByText("等待合并窗口：保护 C-3（已暂停）").getAttribute("title"),
  ).toBe("a.ts\nb.ts");
});

test("groups batch peers without reordering unrelated cards, and highlights only those peers", () => {
  const stage: MergeStageView = {
    stage: "batch_checking",
    batch_id: "MB-1",
    color: 1,
  };
  const cards = [
    { ...card, id: "C-1", merge_stage: stage },
    { ...card, id: "C-2" },
    { ...card, id: "C-3", merge_stage: stage },
    { ...card, id: "C-4" },
  ];
  expect(groupBatchCards(cards).map((c) => c.id)).toEqual([
    "C-1",
    "C-3",
    "C-2",
    "C-4",
  ]);
  const view = render(
    <ul className="board-list">
      {cards.map((c) => (
        <li key={c.id}>
          <BoardCard card={c} projectId="p" display={DEFAULT_CARD_DISPLAY} />
        </li>
      ))}
    </ul>,
  );
  const peer = view.container.querySelector<HTMLElement>("[data-batch-id]");
  if (!peer) throw new Error("Missing peer");
  fireEvent.mouseEnter(peer);
  expect(
    view.container.querySelectorAll("[data-batch-highlight]"),
  ).toHaveLength(2);
  fireEvent.mouseLeave(peer);
  expect(
    view.container.querySelectorAll("[data-batch-highlight]"),
  ).toHaveLength(0);
});

test("batch route restores member order and bisect results in a dialog", async () => {
  const route = {
    kind: "merge-batch" as const,
    projectId: "p",
    batchId: "MB-7",
  };
  expect(parseRoute(routeHash(route))).toEqual(route);
  const batch = {
    id: "MB-7",
    status: "bisecting",
    solo: false,
    base_sha: "a".repeat(40),
    final_sha: "b".repeat(40),
    final_tree_sha: "c".repeat(40),
    members: [
      {
        card_id: "C-1",
        completion_id: "D-1",
        merge_sha: "d".repeat(40),
        tree_sha: "e".repeat(40),
      },
    ],
  };
  render(
    <MergeBatchPage
      projectId="p"
      batchId="MB-7"
      client={fakeClient({
        mergeBatch: async () => ({ batch, probes: [{ ...batch, id: "MB-8" }] }),
      })}
    />,
  );
  expect(await screen.findByRole("link", { name: "C-1" })).toBeTruthy();
  expect(screen.getByRole("dialog", { name: "MB-7" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "二分过程" })).toBeTruthy();
});

test("solo toggle uses the human API and card and batch evidence have distinct sections", async () => {
  const setMergeSolo = vi.fn(async () => {}),
    done = vi.fn();
  const check = {
    attempt_id: "check",
    completion_id: "D-1",
    candidate_sha: "a".repeat(40),
    tree_sha: "b".repeat(40),
    status: "passed" as const,
    checks: [],
    updated_at: "2026-01-01T00:00:00Z",
  };
  render(
    <CardBatchChecks
      projectId="p"
      card={{
        ...card,
        merge_stage: {
          stage: "batch_checking",
          batch_id: "MB-1",
          card_check: check,
          batch_check: check,
        },
      }}
      client={fakeClient({ setMergeSolo })}
      done={done}
    />,
  );
  expect(screen.getByRole("heading", { name: "卡级快速检查" })).toBeTruthy();
  expect(
    screen.getByRole("heading", { name: "批次全量检查 · MB-1 最终提交" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: "单独批次" }));
  await vi.waitFor(() => expect(done).toHaveBeenCalledOnce());
  expect(setMergeSolo).toHaveBeenCalledWith("p", card.id, true);
});

test("resolved batches identify the culprit and the published prefix members", async () => {
  const first = {
    card_id: "C-1",
    completion_id: "D-1",
    merge_sha: "a".repeat(40),
    tree_sha: "b".repeat(40),
  };
  const second = { ...first, card_id: "C-2", completion_id: "D-2" };
  const batch = {
    id: "MB-1",
    status: "resolved",
    members: [first, second],
    culprit: "C-2",
    published_prefix: "MB-2",
    solo: false,
    base_sha: "c".repeat(40),
    final_sha: "d".repeat(40),
    final_tree_sha: "e".repeat(40),
  };
  render(
    <MergeBatchPage
      projectId="p"
      batchId="MB-1"
      client={fakeClient({
        mergeBatch: async () => ({
          batch,
          probes: [
            { ...batch, id: "MB-2", members: [first], status: "published" },
          ],
        }),
      })}
    />,
  );
  expect(
    (await screen.findByRole("link", { name: "C-2" })).closest("li")
      ?.textContent,
  ).toContain("失败原因");
  expect(
    screen.getByRole("link", { name: "C-1" }).closest("li")?.textContent,
  ).toContain("已合并前缀");
});

test("solo toggle exposes permission failures and restores the saved value", async () => {
  render(
    <CardBatchChecks
      projectId="p"
      card={{ ...card, merge_stage: { stage: "queued" } }}
      client={fakeClient({
        setMergeSolo: async () => {
          throw new ApiError(403, "unauthorized", "Denied");
        },
      })}
      done={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("checkbox", { name: "单独批次" }));
  expect((await screen.findByRole("alert")).textContent).toContain("没有权限");
  expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe(
    "false",
  );
});
