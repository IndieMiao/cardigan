import type { Assignment, Card, Delivery, WorkItem } from "../entities.js";
import type { ProjectId } from "../ids.js";
import {
  type ProjectPreferences,
  reviewerBrowserEnabled,
} from "../preferences.js";

/**
 * P2a-14 ⑧ / Q-336 (a): a card carrying a pre-merge check with this label is
 * a UI card. While the project's `enable_reviewer_browser` switch is on, its
 * passed/failed conclusion comes only from an independent reviewer's
 * `submit_review(screenshot_check)` projection, and PM Ops (or a timeout) may
 * confirm the merge only once that projection passed on the current
 * deliveries. With the switch off the label is an ordinary check (C-86).
 */
export const SCREENSHOT_CHECK_LABEL = "截图核对";

export interface ScreenshotCheckState {
  readonly project_id: ProjectId;
  readonly project_preferences?: readonly ProjectPreferences[];
  readonly assignments: readonly Assignment[];
  readonly work_items: readonly WorkItem[];
  readonly deliveries: readonly Delivery[];
}

const numericId = (id: string): number => Number(/(\d+)$/u.exec(id)?.[1] ?? 0);

export function screenshotCheckEnforced(
  state: Pick<ScreenshotCheckState, "project_id" | "project_preferences">,
): boolean {
  return reviewerBrowserEnabled(
    state.project_preferences?.find((p) => p.id === state.project_id),
  );
}

/** Same candidates as `currentPreMergeVersions`, bound to delivery IDs. */
function currentDeliveries(
  card: Pick<Card, "id">,
  workItems: readonly WorkItem[],
  deliveries: readonly Delivery[],
) {
  return workItems
    .filter((w) => w.card_id === card.id && w.kind === "produce")
    .sort((a, b) => numericId(a.id) - numericId(b.id))
    .flatMap((w) => {
      const latest = deliveries
        .filter(
          (d) =>
            d.work_item_id === w.id &&
            d.kind !== "card_completion" &&
            d.status !== "superseded",
        )
        .sort((a, b) => numericId(b.id) - numericId(a.id))[0];
      return latest ? [latest] : [];
    });
}

/**
 * Why a non-human merge confirmation may not proceed on this card, or
 * undefined. Only restricts: it never makes a human-only card delegable.
 * A conclusion written before the switch was turned on (by PM Office or the
 * human), on an older delivery (even with the same SHA), or by anyone but an
 * independent reviewer does not count.
 */
export function screenshotCheckBlocker(
  state: ScreenshotCheckState,
  card: Pick<Card, "id" | "pre_merge_checks">,
): string | undefined {
  if (!screenshotCheckEnforced(state)) return undefined;
  const check = card.pre_merge_checks?.find(
    (c) => c.label === SCREENSHOT_CHECK_LABEL,
  );
  if (!check) return undefined;
  const writer = check.updated_by.startsWith("assignment:")
    ? state.assignments.find((a) => `assignment:${a.id}` === check.updated_by)
    : undefined;
  const current = currentDeliveries(card, state.work_items, state.deliveries);
  const versions = check.checked_versions ?? [];
  const fresh =
    current.length > 0 &&
    versions.length === current.length &&
    versions.every(
      (v, i) =>
        v.work_item_id === current[i]?.work_item_id &&
        v.delivery_id === current[i]?.id &&
        v.subject === current[i]?.subject.value,
    );
  if (
    check.status === "passed" &&
    writer?.role_id === "independent_reviewer" &&
    fresh
  )
    return undefined;
  return check.status === "failed" &&
    writer?.role_id === "independent_reviewer" &&
    fresh
    ? `界面卡的“${SCREENSHOT_CHECK_LABEL}”未通过（独立复核员结论为有问题）`
    : `界面卡的“${SCREENSHOT_CHECK_LABEL}”须由独立复核员对当前交付提交审核并通过（项目已开启截图核对计入代确认）`;
}
