import { useCallback, useId, useState } from "react";
import type {
  CardiganClient,
  CardListItem,
  CardView,
  MergeStageView,
} from "../api.js";
import { describeWriteError } from "../api.js";
import { routeHash } from "../route.js";
import { useResource } from "../useResource.js";
import {
  MergeBatchAction,
  MergeBatchDrawer,
  MergeBatchMembers,
  MergeBatchSoloLabel,
  MergeBatchStage,
} from "./layout/MergeBatchLayout.js";
import { MergeCheck } from "./MergeCheck.js";
import { Button } from "./ui/button.js";
import { Checkbox } from "./ui/checkbox.js";
import * as Dialog from "./ui/dialog.js";

export function mergeStageLabel(stage: MergeStageView): string {
  switch (stage.stage) {
    case "awaiting_confirmation":
      return "待确认";
    case "queued":
      return `排队中 · 第 ${stage.position ?? 1} 位`;
    case "held_by_window":
      return `等待合并窗口：保护 ${stage.protecting_card_id}${stage.protecting_card_held ? "（已暂停）" : ""}`;
    case "batch_checking":
      return `${stage.batch_id} 批次检查中`;
    case "bisecting":
      return `${stage.batch_id} 二分定位中`;
    case "culprit":
      return `${stage.batch_id} 定位为失败原因`;
    case "merged_in_batch":
      return `${stage.batch_id} 已随批次合并`;
  }
}
export function MergeStageBadge({
  card,
  projectId,
}: {
  card: Pick<CardView, "merge_stage" | "merge_solo">;
  projectId: string;
}) {
  const stage = card.merge_stage;
  return (
    <>
      {stage &&
        (stage.batch_id ? (
          <MergeBatchStage
            color={stage.color ?? 0}
            culprit={stage.stage === "culprit"}
            href={routeHash({
              kind: "merge-batch",
              projectId,
              batchId: stage.batch_id,
            })}
          >
            {mergeStageLabel(stage)}
          </MergeBatchStage>
        ) : (
          <MergeBatchStage
            {...(stage.protecting_files?.length
              ? { title: stage.protecting_files.join("\n") }
              : {})}
          >
            {mergeStageLabel(stage)}
          </MergeBatchStage>
        ))}
      {card.merge_solo && <MergeBatchStage>单独批次</MergeBatchStage>}
    </>
  );
}

/** Preserve first appearance and every other card's relative order. */
export function groupBatchCards(cards: readonly CardListItem[]) {
  const seen = new Set<string>();
  return cards.flatMap((card) => {
    const id = card.merge_stage?.batch_id;
    if (!id) return [card];
    if (seen.has(id)) return [];
    seen.add(id);
    return cards.filter((c) => c.merge_stage?.batch_id === id);
  });
}
export function highlightBatch(element: HTMLElement, enabled: boolean) {
  const id = element.dataset.batchId;
  if (!id) return;
  for (const peer of element
    .closest(".board-list")
    ?.querySelectorAll<HTMLElement>("[data-batch-id]") ?? [])
    if (peer.dataset.batchId === id)
      peer.toggleAttribute("data-batch-highlight", enabled);
}

export function CardBatchChecks({
  card,
  projectId,
  client,
  done,
}: {
  card: CardView;
  projectId: string;
  client: CardiganClient;
  done: () => void;
}) {
  const soloId = useId();
  const [pending, setPending] = useState(false),
    [error, setError] = useState("");
  if (!card.merge_stage) return null;
  return (
    <section className="card-section" aria-label="批次合并">
      <MergeStageBadge card={card} projectId={projectId} />
      {!["done", "cancelled"].includes(card.status) && (
        <MergeBatchSoloLabel htmlFor={soloId}>
          <Checkbox
            id={soloId}
            checked={!!card.merge_solo}
            disabled={pending}
            onCheckedChange={async (checked) => {
              setPending(true);
              setError("");
              try {
                await client.setMergeSolo(projectId, card.id, checked === true);
                done();
              } catch (cause) {
                setError(describeWriteError(cause));
              } finally {
                setPending(false);
              }
            }}
          />
          单独批次
        </MergeBatchSoloLabel>
      )}
      {error && <p role="alert">{error}</p>}
      <h3>卡级快速检查</h3>
      {card.merge_stage.card_check ? (
        <MergeCheck check={card.merge_stage.card_check} projectId={projectId} />
      ) : (
        <p>尚无结果</p>
      )}
      {card.merge_stage.batch_check && (
        <>
          <h3>批次全量检查 · {card.merge_stage.batch_id} 最终提交</h3>
          <p>本卡合并提交未单独检查，检查覆盖的是批次最终 tree。</p>
          <MergeCheck
            check={card.merge_stage.batch_check}
            projectId={projectId}
          />
        </>
      )}
    </section>
  );
}

export function MergeBatchPage({
  projectId,
  batchId,
  client,
  revision = 0,
}: {
  projectId: string;
  batchId: string;
  client: CardiganClient;
  revision?: number;
}) {
  const resource = useResource(
    useCallback(
      () => client.mergeBatch(projectId, batchId),
      [client, projectId, batchId],
    ),
    revision,
  );
  const close = () => {
    window.location.hash = routeHash({ kind: "cards", projectId });
  };
  const batch = resource.data?.batch;
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <MergeBatchDrawer>
          <Dialog.Title>{batchId}</Dialog.Title>
          <MergeBatchAction>
            <Dialog.Close asChild>
              <Button size="stretch">关闭</Button>
            </Dialog.Close>
          </MergeBatchAction>
          {resource.error && <p role="alert">{resource.error}</p>}
          {!batch && !resource.error && <p>加载中</p>}
          {batch && (
            <>
              <p>
                {{
                  checking: "检查中",
                  passed: "检查通过",
                  failed: "检查失败",
                  bisecting: "二分定位中",
                  resolved: "定位完成",
                  publishing: "正在合并",
                  published: "已合并",
                  aborted: "已中止",
                }[batch.status] ?? "等待检查"}
                {batch.solo ? " · 单独批次" : ""}
              </p>
              <MergeBatchMembers>
                {batch.members.map((m) => (
                  <li key={m.card_id}>
                    <a
                      href={routeHash({
                        kind: "card",
                        projectId,
                        cardId: m.card_id,
                      })}
                    >
                      {m.card_id}
                    </a>{" "}
                    {batch.culprit === m.card_id && (
                      <span className="status-tag">失败原因</span>
                    )}
                    {resource.data?.probes.some(
                      (probe) =>
                        probe.id === batch.published_prefix &&
                        probe.status === "published" &&
                        probe.members.some(
                          (member) => member.card_id === m.card_id,
                        ),
                    ) && <span className="status-tag">已合并前缀</span>}
                    <code>{m.merge_sha}</code>
                  </li>
                ))}
              </MergeBatchMembers>
              <dl>
                <dt>批次前</dt>
                <dd>
                  <code>{batch.base_sha}</code>
                </dd>
                <dt>批次后</dt>
                <dd>
                  <code>{batch.final_sha}</code>
                </dd>
              </dl>
              <MergeCheck check={batch.check ?? null} projectId={projectId} />
              {!!resource.data?.probes.length && (
                <section aria-label="二分过程">
                  <h3>二分过程</h3>
                  {resource.data.probes.map((probe) => (
                    <section key={probe.id}>
                      <h4>
                        {probe.id} · 前 {probe.members.length} 张
                        {probe.status === "published" ? " · 已合并" : ""}
                      </h4>
                      <MergeCheck
                        check={probe.check ?? null}
                        projectId={projectId}
                      />
                    </section>
                  ))}
                </section>
              )}
            </>
          )}
        </MergeBatchDrawer>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
