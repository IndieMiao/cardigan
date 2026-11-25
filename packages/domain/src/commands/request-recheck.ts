import type { Actor, Delivery } from "../entities.js";
import { appendEvents } from "../event-index.js";
import { flowAtLeast } from "../flow.js";
import type { CardId } from "../ids.js";
import type { DeliveryVerifier } from "../ports.js";
import {
  attempt,
  CommandDraft,
  type CommandPorts,
  type CommandState,
  ensure,
  text,
  unwrap,
} from "./core.js";
import {
  deliverySubmission,
  prepareDelivery,
  type SubmitDeliveryParams,
  type VerifiedDelivery,
} from "./delivery.js";
import { deliveryTree, reusableReviews } from "./review-reuse.js";
import { systemCompleteCard } from "./system-completion.js";
import { commandWithReadyVerifiers as command } from "./system-rules.js";
import { resolveCardTemplate } from "./templates.js";

export interface RequestRecheckParams {
  readonly card_id: CardId;
  readonly reason: string;
}

function inspect(d: CommandDraft, p: RequestRecheckParams) {
  const card = d.card(p.card_id);
  const template = resolveCardTemplate(d, card);
  const a = d.assignment;
  ensure(
    a?.scope === "work_item",
    "unauthorized",
    "只有本卡主产出负责人可以重查",
  );
  const item = d.ownWork(a.work_item_id);
  ensure(
    item.kind === "produce" &&
      item.template_key === template.primary_work_item_key,
    "unauthorized",
    "只有本卡主产出负责人可以重查",
  );
  ensure(
    flowAtLeast(card, 2),
    "illegal_transition",
    "本卡流程版本不支持作者重查",
  );
  ensure(
    card.status === "in_progress" &&
      ["changes_requested", "in_progress"].includes(item.status),
    "illegal_transition",
    "仅系统退回后且尚未重新交付时可以重查",
  );
  text(p.reason, "reason");
  const events = d.state.events
    .filter((e) => e.card_id === card.id)
    .sort((a, b) => a.seq - b.seq);
  const returned = events
    .filter((e) =>
      ["merge_changes_requested", "merge_conflicted"].includes(e.type),
    )
    .at(-1);
  const payload = returned?.payload as Record<string, unknown> | undefined;
  const completion = d
    .list("deliveries")
    .filter((v) => v.work_item_id === item.id && v.kind === "card_completion")
    .sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)))
    .at(-1);
  ensure(
    returned?.type === "merge_changes_requested" &&
      returned.actor.kind === "system" &&
      payload?.via === "system_rule" &&
      payload.rule === "flow-v2/A1" &&
      completion &&
      completion.id === payload.completion_id &&
      completion.status === "superseded",
    "stale_target",
    "最近完成申请必须由 A1 系统退回",
  );
  ensure(
    !events.some(
      (e) => e.seq > returned.seq && e.type === "delivery_submitted",
    ),
    "stale_target",
    "系统退回后已有新交付，不能重查旧版本",
  );
  const products = d
    .list("deliveries")
    .filter(
      (v) =>
        v.kind !== "card_completion" &&
        v.status !== "superseded" &&
        d
          .list("work_items")
          .some((w) => w.card_id === card.id && w.id === v.work_item_id),
    );
  const snapshot = products.map((v) => ({
    delivery_id: v.id,
    sha: v.subject.value,
    tree_sha: deliveryTree(v) ?? null,
  }));
  const canonical = (values: typeof snapshot) =>
    JSON.stringify(
      [...values].sort((a, b) => a.delivery_id.localeCompare(b.delivery_id)),
    );
  ensure(
    Array.isArray(payload.product_deliveries) &&
      canonical(payload.product_deliveries as typeof snapshot) ===
        canonical(snapshot) &&
      products.length > 0 &&
      products.every((v) => v.status === "accepted" && deliveryTree(v)),
    "stale_target",
    "产出交付集合、完整 SHA 或受信树已变化，不能重查",
  );
  const sha_group = JSON.stringify(
    [...new Set(products.map((v) => v.subject.value))].sort(),
  );
  ensure(
    !events.some(
      (e) =>
        e.type === "recheck_requested" &&
        (e.payload as Record<string, unknown>).sha_group === sha_group,
    ),
    "illegal_transition",
    "这组产出 SHA 已使用过作者重查",
  );
  const product = products.find((v) => v.work_item_id === item.id);
  ensure(
    product &&
      product.subject.value === completion.subject.value &&
      deliveryTree(product) === deliveryTree(completion),
    "stale_target",
    "完成申请必须绑定当前主产出 SHA 和树",
  );
  d.currentRun();
  return { card, completion, product, products, sha_group, returned };
}

function params(v: Delivery): SubmitDeliveryParams {
  return {
    work_item_id: v.work_item_id,
    kind: v.kind,
    summary: v.summary,
    subject: v.subject,
    requested_verifiers: v.requested_verifiers,
    ...(v.branch ? { branch: v.branch } : {}),
    ...(v.pr_url ? { pr_url: v.pr_url } : {}),
    ...(v.test_results ? { test_results: v.test_results } : {}),
    attachments: v.attachments,
    known_gaps: v.known_gaps,
    ...(v.plain_summary ? { plain_summary: v.plain_summary } : {}),
  };
}

const recheckProof = Symbol("verified-recheck");
export interface VerifiedRecheck {
  readonly [recheckProof]: true;
  readonly completion_id: Delivery["id"];
  readonly product_id: Delivery["id"];
  readonly verified: VerifiedDelivery;
}

export async function prepareRecheck(
  state: CommandState,
  actor: Actor,
  p: RequestRecheckParams,
  verifier: DeliveryVerifier,
) {
  const checked = attempt(() =>
    inspect(new CommandDraft(state, actor, "request_recheck"), p),
  );
  if (!checked.ok) return checked;
  const { product, completion } = checked.value;
  const verified = await prepareDelivery(
    state,
    actor,
    params(product),
    verifier,
  );
  if (!verified.ok) return verified;
  return attempt(() => {
    const fresh = { ...product, evidence: verified.value.evidence };
    ensure(
      deliveryTree(fresh) === deliveryTree(product) &&
        fresh.evidence.some(
          (e) =>
            e.kind === "commit" &&
            e.details &&
            typeof e.details === "object" &&
            !Array.isArray(e.details) &&
            "branch_head_sha" in e.details &&
            e.details.branch_head_sha === product.subject.value,
        ),
      "stale_target",
      "分支顶端或受信树已变化，请正常提交新交付",
    );
    return {
      [recheckProof]: true as const,
      completion_id: completion.id,
      product_id: product.id,
      verified: verified.value,
    };
  });
}

export function requestRecheck(
  state: CommandState,
  actor: Actor,
  p: RequestRecheckParams,
  prepared: VerifiedRecheck,
  ports: CommandPorts,
) {
  return command(state, actor, "request_recheck", ports, (d) => {
    const { card, completion, product, products, sha_group, returned } =
      inspect(d, p);
    ensure(
      prepared?.[recheckProof] &&
        prepared.completion_id === completion.id &&
        prepared.product_id === product.id,
      "stale_target",
      "重查准备期间交付已变化",
    );
    const nextProduct = deliverySubmission(params(product), prepared.verified, {
      previous: product,
    })(d);
    // An invalid product pass requires ordinary redelivery/review, never a fabricated acceptance.
    ensure(
      nextProduct.status === "accepted",
      "stale_target",
      "产出审核已失效，请正常重新交付并审核",
    );
    let nextCompletion: Delivery;
    if (flowAtLeast(card, 5)) {
      const aggregated = unwrap(
        systemCompleteCard(
          {
            ...d.state,
            cards: d.list("cards"),
            work_items: d.list("work_items"),
            assignments: d.list("assignments"),
            deliveries: d.list("deliveries"),
            reviews: d.list("reviews"),
            decisions: d.list("decisions"),
            events: appendEvents(d.state.events, d.events),
            timeline: [...d.state.timeline, ...d.timeline],
          },
          { kind: "system", project_id: d.state.project_id },
          { card_id: card.id },
          ports,
        ),
      );
      ensure(
        aggregated.data,
        "stale_target",
        "系统汇总的前置条件已变化，请正常交付并审核",
      );
      for (const c of aggregated.changes) d.put(c.collection, c.entity);
      d.events.push(...aggregated.events);
      d.timeline.push(...aggregated.timeline);
      d.token_requests.push(...aggregated.token_requests);
      nextCompletion = { ...aggregated.data, recheck_of: completion.id };
      d.put("deliveries", nextCompletion);
    } else {
      const source = { ...completion, status: "accepted" as const };
      // A1 withdrew the completion target. Probe the original passes using all the
      // existing reuse conditions before restoring only their status projections.
      const probe = new CommandDraft(state, actor, "request_recheck", ports);
      for (const c of d.changes) probe.put(c.collection, c.entity);
      for (const id of completion.requested_verifiers) {
        const item = probe.work(id);
        if (item.kind === "verify" && item.status === "todo")
          probe.put("work_items", { ...item, status: "passed" });
      }
      const next = {
        ...source,
        evidence: completion.evidence,
        recheck_of: completion.id,
      };
      for (const review of reusableReviews(probe, source, next)) {
        const item = d.work(review.work_item_id);
        ensure(
          item.kind === "verify",
          "invariant_violation",
          "审核须绑定验证项",
        );
        d.put("work_items", { ...item, status: "passed" });
      }
      nextCompletion = deliverySubmission(
        params(completion),
        prepared.verified,
        { previous: source },
      )(d);
    }
    d.emit(
      "recheck_requested",
      card.id,
      {
        rule: "flow-v2/A1d",
        sha_group,
        reason: p.reason,
        recheck_of: completion.id,
        completion_id: nextCompletion.id,
        return_event_id: returned.id,
        work_item_id: product.work_item_id,
        product_deliveries: products.map((v) => v.id),
      },
      {
        type: "system",
        work_item_id: product.work_item_id,
        delivery_id: nextCompletion.id,
        body: `作者请求同一组 SHA 重新检查：${p.reason}；沿用仍有效的原审核，保留原合并授权审计。`,
      },
    );
    return { product: nextProduct, completion: nextCompletion };
  });
}
