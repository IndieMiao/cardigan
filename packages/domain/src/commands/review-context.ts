import type { Delivery, WorkItem } from "../entities.js";
import type { AssignmentId } from "../ids.js";
import type { CommandDraft } from "./core.js";
import { employeeConflicts } from "./employee-assignment.js";

/** Canonical comparison of evidence, independent of JSON property order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** Only commit evidence returned by the trusted DeliveryVerifier counts. */
export function deliveryTree(delivery: Pick<Delivery, "subject" | "evidence">) {
  if (delivery.subject.kind !== "git_head") return undefined;
  const sha = delivery.subject.value;
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(sha)) return undefined;
  const trees = delivery.evidence.flatMap((e) => {
    if (
      e.kind !== "commit" ||
      !e.details ||
      typeof e.details !== "object" ||
      Array.isArray(e.details)
    )
      return [];
    if (!("sha" in e.details) || !("tree_sha" in e.details)) return [];
    const { sha: verifiedSha, tree_sha: tree } = e.details;
    return verifiedSha === sha &&
      typeof tree === "string" &&
      tree.length === sha.length &&
      /^[a-f0-9]+$/u.test(tree)
      ? [tree]
      : [];
  });
  return trees.length === 1 ? trees[0] : undefined;
}

/** Rechecks preserve the exact logical product set approved by completion review. */
function productOrigin(d: CommandDraft, value: Delivery): string {
  const seen = new Set<string>();
  let current = value;
  while (current.recheck_of && !seen.has(current.id)) {
    seen.add(current.id);
    const source = d
      .list("deliveries")
      .find((v) => v.id === current.recheck_of);
    if (
      !source ||
      source.work_item_id !== value.work_item_id ||
      source.kind !== value.kind ||
      source.subject.value !== value.subject.value ||
      !deliveryTree(source) ||
      deliveryTree(source) !== deliveryTree(value)
    )
      return value.id;
    current = source;
  }
  return seen.has(current.id) ? value.id : current.id;
}

/** Requirements and current/historical identity proof, not runtime or review progress. */
export function reviewReuseContext(
  d: CommandDraft,
  delivery: Delivery,
  item: WorkItem,
  assignmentId: AssignmentId,
): string | undefined {
  const producer = d.work(delivery.work_item_id);
  const card = d.card(producer.card_id);
  const owner = d.list("assignments").find((a) => a.id === assignmentId);
  if (
    owner?.scope !== "work_item" ||
    owner.work_item_id !== item.id ||
    item.assignment_id !== owner.id ||
    item.card_id !== card.id ||
    item.kind !== "verify" ||
    item.status === "cancelled" ||
    item.replaced_by_work_item_id ||
    owner.id === producer.assignment_id ||
    (owner.employee_id && employeeConflicts(d, item, owner.employee_id))
  )
    return undefined;
  const items = d.list("work_items").filter((w) => w.card_id === card.id);
  const identities = new Set([
    producer.id,
    item.id,
    ...items
      .filter(
        (w) =>
          w.kind === "verify" &&
          (item.role_id === "independent_reviewer" ||
            w.role_id === "independent_reviewer"),
      )
      .map((w) => w.id),
  ]);
  return canonical({
    version: 1,
    review_epoch: [...d.state.events, ...d.events]
      .filter(
        (e) =>
          e.card_id === card.id &&
          ["merge_conflicted", "merge_changes_requested"].includes(e.type) &&
          !(
            e.type === "merge_changes_requested" &&
            e.actor.kind === "system" &&
            (e.payload as Record<string, unknown>).via === "system_rule" &&
            (e.payload as Record<string, unknown>).rule === "flow-v2/A1"
          ),
      )
      .at(-1)?.id,
    card: {
      id: card.id,
      goal: card.goal,
      acceptance_criteria: card.acceptance_criteria,
      out_of_scope: card.out_of_scope,
      risk_tags: [...(card.risk_tags ?? [])].sort(),
      template: card.template,
      template_version: card.template_version,
    },
    requirements: items
      .filter((w) => w.required || w.id === item.id || w.id === producer.id)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((w) => ({
        id: w.id,
        kind: w.kind,
        role_id: w.role_id,
        required: w.required,
        target: w.kind === "verify" ? w.target_work_item_id : undefined,
        completion_criteria: w.completion_criteria,
        depends_on: w.depends_on,
        cancelled: w.status === "cancelled",
        replaced: w.replaced_by_work_item_id,
      })),
    assignments: d
      .list("assignments")
      .filter((a) => a.scope === "work_item" && identities.has(a.work_item_id))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((a) => ({
        id: a.id,
        work_item_id: a.scope === "work_item" ? a.work_item_id : undefined,
        employee_id: a.employee_id,
        role_id: a.role_id,
        role_version: a.role_version,
      })),
    // A completion's underlying accepted set is part of what PM actually approved.
    products:
      delivery.kind === "card_completion"
        ? d
            .list("deliveries")
            .filter(
              (v) =>
                v.kind !== "card_completion" &&
                v.status !== "superseded" &&
                items.some((w) => w.id === v.work_item_id),
            )
            .sort((a, b) =>
              productOrigin(d, a).localeCompare(productOrigin(d, b)),
            )
            .map((v) => ({
              id: productOrigin(d, v),
              subject: v.subject,
              status: v.status,
            }))
        : undefined,
  });
}
