import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fenceLongOperations,
  liveLongOperations,
  releaseLongOperationFence,
} from "@cardigan/host";
import { Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MergeStageError } from "./merge-failure.js";
import {
  batchSubject,
  holdMergeStep,
  MERGE_STEP_LINGER_MS,
  MergeStepDeferred,
  mergeStep,
} from "./merge-step.js";

let root: string;
let store: Store;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cg-merge-step-"));
  store = Store.open({ dataDir: root, dbPath: ":memory:" });
  store.createProject({ id: "cardigan" });
});
afterEach(async () => {
  vi.useRealTimers();
  store.close();
  await rm(root, { recursive: true, force: true });
});

const card = { project_id: "cardigan", card_id: "C-7", subject: "合并 C-7" };
const rows = () =>
  liveLongOperations(store).map((op) => ({
    kind: op.kind,
    card_id: op.card_id,
    label: op.label,
  }));

test("C-799: a running merge step is a managed operation naming its card and step; one burst shares one row", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const seen: unknown[] = [];
  await mergeStep(store, card, "同步源仓库", () => {
    seen.push(rows());
  });
  // The next step of the same pass reuses the standing row: no new write.
  await mergeStep(store, card, "读取基线", () => {
    seen.push(rows());
  });
  const first = [
    { kind: "merge_step", card_id: "C-7", label: "合并 C-7 的「同步源仓库」" },
  ];
  expect(seen).toEqual([first, first]);
  // It outlives the burst briefly, then goes.
  expect(rows()).toEqual(first);
  await vi.advanceTimersByTimeAsync(MERGE_STEP_LINGER_MS);
  expect(rows()).toEqual([]);
  // A failure keeps its stage tag and still releases the step.
  await expect(
    mergeStep(store, card, "发布合并", () => {
      throw new Error("push rejected");
    }),
  ).rejects.toMatchObject({ stage: "发布合并" });
  await expect(
    mergeStep(store, card, "发布合并", () => {
      throw new Error("push rejected");
    }),
  ).rejects.toBeInstanceOf(MergeStageError);
  await vi.advanceTimersByTimeAsync(MERGE_STEP_LINGER_MS);
  expect(rows()).toEqual([]);
});

test("C-799: under a restart fence no step starts, an idle row goes at once, and a running step ends without the linger", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  // No row yet: registration and the fence check are one transaction.
  fenceLongOperations(store);
  const work = vi.fn();
  await expect(mergeStep(store, card, "同步源仓库", work)).rejects.toEqual(
    new MergeStepDeferred("合并 C-7 的「同步源仓库」"),
  );
  expect(work).not.toHaveBeenCalled();
  releaseLongOperationFence(store);
  // A lingering row: a fence taken now sees it; the next step does not start
  // and the row is dropped so the restart need not wait out the linger.
  await mergeStep(store, card, "同步源仓库", () => {});
  expect(fenceLongOperations(store)).toHaveLength(1);
  expect(() => holdMergeStep(store, card, "读取基线")).toThrow(
    MergeStepDeferred,
  );
  expect(rows()).toEqual([]);
  releaseLongOperationFence(store);
  // A step running when the fence comes is waited for; its end frees the
  // registry immediately.
  const release = holdMergeStep(store, card, "发布合并");
  expect(fenceLongOperations(store)).toHaveLength(1);
  release();
  release();
  expect(rows()).toEqual([]);
  releaseLongOperationFence(store);
});

test("C-799: overlapping steps keep the row until the last one ends", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const a = holdMergeStep(store, card, "同步源仓库");
  const b = holdMergeStep(
    store,
    { project_id: "cardigan", card_id: "C-8", subject: "合并 C-8" },
    "准备合并候选",
  );
  a();
  await vi.advanceTimersByTimeAsync(MERGE_STEP_LINGER_MS * 2);
  expect(rows()).toHaveLength(1);
  b();
  await vi.advanceTimersByTimeAsync(MERGE_STEP_LINGER_MS);
  expect(rows()).toEqual([]);
});

test("C-799: a batch names its id and members, bounded", () => {
  expect(
    batchSubject({
      id: "MB-122",
      members: ["C-787", "C-789", "C-783"].map((card_id) => ({ card_id })),
    }),
  ).toBe("批次 MB-122（C-787、C-789、C-783）");
  const many = batchSubject({
    id: "MB-9",
    members: Array.from({ length: 12 }, (_, i) => ({ card_id: `C-${i}` })),
  });
  expect(many.endsWith(" 等 12 张）")).toBe(true);
  expect(many).not.toContain("C-8");
});
