import type {
  Card,
  Delivery,
  Event,
  PreMergeCheckedVersion,
  WorkItem,
} from "../entities.js";
import { appendEvents, eventsOfType } from "../event-index.js";
import type { CardId, DeliveryId } from "../ids.js";
import { officeOnDuty } from "../office-changes.js";
import type { CommandDraft } from "./core.js";
import {
  currentPreMergeVersions,
  type EffectivePreMergeCheck,
  effectivePreMergeChecks,
  reservedPreMergeCheckLabels,
} from "./pre-merge-check-view.js";
import { screenshotCheckEnforced } from "./screenshot-check.js";

/**
 * C-744: the persisted prompt asking the project's PM Office on duty to record
 * the pre-merge checks it owns. Only a prompt: it changes no check, gate or
 * merge decision. The Router turns it into one PM Office bell.
 */
export const PRE_MERGE_CHECK_OFFICE_PROMPTED =
  "pre_merge_check_office_prompted";

/**
 * - `accepted`: the current delivery's reviews and PM acceptance passed (the
 *   card awaits merge), so the Office should finish its checks this turn.
 * - `merge_check_passed`: the merge check passed and the automatic merge waits
 *   only on checks the Office owns; this is the fallback, ahead of the
 *   30-minute `merge_blocked_reminded`.
 */
export type OfficePreMergeMoment = "accepted" | "merge_check_passed";

export interface OfficePreMergePrompt {
  readonly card_id: CardId;
  readonly moment: OfficePreMergeMoment;
  readonly completion_id?: DeliveryId;
  readonly versions: readonly PreMergeCheckedVersion[];
  /** Labels prompted by this event; earlier prompts of the same key excluded. */
  readonly checks: readonly string[];
  readonly text: string;
}

/**
 * Checks whose conclusion PM Office (or the human) records through
 * `update_card`: every label except those projected from a verifier's
 * `submit_review` (独立复核, and 截图核对 while the reviewer-browser switch is
 * on). Only those still awaiting a conclusion on the current versions count:
 * pending, or a conclusion reached on an older version. A `failed` check is a
 * conclusion already recorded, not one waiting for the Office.
 */
export function officePendingPreMergeChecks(
  card: Pick<Card, "id" | "pre_merge_checks">,
  workItems: readonly WorkItem[],
  deliveries: readonly Delivery[],
  screenshotEnforced = false,
): readonly EffectivePreMergeCheck[] {
  const reserved = reservedPreMergeCheckLabels(screenshotEnforced);
  return effectivePreMergeChecks(
    card,
    workItems,
    deliveries,
    screenshotEnforced,
  ).filter((c) => c.status === "pending" && !reserved.includes(c.label));
}

const sameDeliveries = (
  a: unknown,
  b: readonly PreMergeCheckedVersion[],
): boolean =>
  Array.isArray(a) &&
  a.length === b.length &&
  b.every((v, i) => {
    const x = a[i] as Partial<PreMergeCheckedVersion> | undefined;
    return (
      x?.work_item_id === v.work_item_id &&
      x.delivery_id === v.delivery_id &&
      x.subject === v.subject
    );
  });

/** Labels already prompted for this card, moment and exact delivery set. */
function promptedLabels(
  events: readonly Event[],
  card: CardId,
  moment: OfficePreMergeMoment,
  versions: readonly PreMergeCheckedVersion[],
): ReadonlySet<string> {
  const seen = new Set<string>();
  for (const e of eventsOfType(events, PRE_MERGE_CHECK_OFFICE_PROMPTED)) {
    if (e.card_id !== card || e.actor.kind !== "system") continue;
    const p = e.payload as Partial<
      Record<keyof OfficePreMergePrompt, unknown>
    > | null;
    if (p?.moment !== moment || !sameDeliveries(p.versions, versions)) continue;
    if (Array.isArray(p.checks))
      for (const label of p.checks)
        if (typeof label === "string") seen.add(label);
  }
  return seen;
}

const versionText = (versions: readonly PreMergeCheckedVersion[]) =>
  versions.map((v) => `${v.delivery_id}@${v.subject}`).join("、");

export function officePreMergePromptText(
  card: CardId,
  moment: OfficePreMergeMoment,
  checks: readonly string[],
  versions: readonly PreMergeCheckedVersion[],
): string {
  const labels = checks.map((l) => `「${l}」`).join("");
  const at =
    moment === "accepted"
      ? "审核和 PM 验收都已通过"
      : "合并检查已通过，自动合并只差这些核对项";
  return `${card} ${at}：请 PM Office 当轮核完合并前核对项${labels}（当前交付 ${versionText(versions)}），用 update_card 的 pre_merge_check 记录结论，不要等合并检查结果。`;
}

/**
 * C-744: prompt the PM Office on duty about the checks it owns that still wait
 * on the current versions. Deduplicated per card, moment, exact delivery set
 * (ID and SHA) and label against persisted prompts, so restarts and repeated
 * scans stay silent; a new delivery (for example after resolving a conflict)
 * is a new key. Nothing is written without an Office on duty: the scan will
 * prompt once one is. Never changes a check, gate or merge decision.
 */
export function promptOfficePreMergeChecks(
  d: CommandDraft,
  card: Card,
  moment: OfficePreMergeMoment,
  completion_id?: DeliveryId,
): OfficePreMergePrompt | undefined {
  if (card.status === "done" || card.status === "cancelled") return undefined;
  if (!officeOnDuty(d.list("assignments"))) return undefined;
  const workItems = d.list("work_items");
  const deliveries = d.list("deliveries");
  const pending = officePendingPreMergeChecks(
    card,
    workItems,
    deliveries,
    screenshotCheckEnforced({
      project_id: d.state.project_id,
      project_preferences: d.list("project_preferences"),
    }),
  );
  if (!pending.length) return undefined;
  const versions = currentPreMergeVersions(card, workItems, deliveries);
  if (!versions.length) return undefined;
  const seen = promptedLabels(
    appendEvents(d.state.events, d.events),
    card.id,
    moment,
    versions,
  );
  const checks = pending.map((c) => c.label).filter((l) => !seen.has(l));
  if (!checks.length) return undefined;
  const text = officePreMergePromptText(card.id, moment, checks, versions);
  const prompt: OfficePreMergePrompt = {
    card_id: card.id,
    moment,
    ...(completion_id ? { completion_id } : {}),
    versions,
    checks,
    text,
  };
  d.emit(
    PRE_MERGE_CHECK_OFFICE_PROMPTED,
    card.id,
    {
      ...prompt,
      versions: versions.map((v) => ({
        work_item_id: v.work_item_id,
        delivery_id: v.delivery_id,
        subject: v.subject,
      })),
      checks: [...checks],
    },
    { type: "system", author: "system", body: text },
    { kind: "system", project_id: d.state.project_id },
  );
  return prompt;
}
