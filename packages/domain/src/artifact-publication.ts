import {
  categoryAuthorization,
  categoryDelegated,
} from "./decision-authorization.js";
import type {
  Attachment,
  Decision,
  Delivery,
  Event,
  WorkItem,
} from "./entities.js";
import type { ProjectPreferences } from "./preferences.js";

export function holdsPublicationTool(a: {
  role_id: string;
  scope: string;
  standing_mode?: string | undefined;
}) {
  return (
    a.role_id === "release_ops" ||
    (a.role_id === "pm" &&
      a.scope === "standing" &&
      a.standing_mode === "office")
  );
}

/** A human answer in Needs You, or PM Ops under the live publish delegation. */
function publishAuthority(
  project: string,
  q: Decision,
  preferences: ProjectPreferences | undefined,
  events: readonly Event[],
) {
  const r = q.resolution;
  if (!r) return false;
  if (r.resolved_by === "human" && r.via === "needs_you") return true;
  const grant = categoryAuthorization(events, "publish");
  return (
    !q.human_required_reason &&
    q.decider === "role:pm" &&
    r.via === "delegated" &&
    r.resolved_by.startsWith("assignment:") &&
    grant !== undefined &&
    preferences?.id === project &&
    categoryDelegated(preferences, events, "publish") &&
    r.proxy_authority ===
      `project:${project}/decision_delegation/publish/event:${grant.id}`
  );
}

/**
 * C-612 managed release chain: one publish approval for unsigned intake →
 * signing → signed intake → publication → release notes. The approval binds
 * the unsigned package digest (`target.subject`) and the source commit and
 * destination template (option `release_chain`, description exactly
 * `发布链 <40-hex commit> 发布到 <https URL template>`). The template may use
 * `<version>` and `<sha12>` (first 12 hex of the signed APK digest).
 */
export const RELEASE_CHAIN_OPTION = "release_chain";
const CHAIN_DESCRIPTION =
  /^发布链 ([0-9a-f]{40}) 发布到 (https:\/\/[^\s<>]+(?:<(?:version|sha12)>[^\s<>]*)*)$/u;
export interface ReleaseChain {
  readonly decision_id: Decision["id"];
  readonly card_id: NonNullable<Decision["card_id"]>;
  readonly source_commit: string;
  readonly unsigned_sha256: string;
  readonly url_template: string;
}
/** The chain binding a decision declares, whether or not it is approved yet. */
export function releaseChainOf(
  q: Decision | undefined,
): ReleaseChain | undefined {
  if (
    !q?.card_id ||
    q.category !== "publish" ||
    q.kind !== "approve" ||
    !("subject" in q.target) ||
    q.target.subject.kind !== "artifact_sha256" ||
    !/^[0-9a-f]{64}$/u.test(q.target.subject.value)
  )
    return undefined;
  const options = q.options.filter((o) => o.key === RELEASE_CHAIN_OPTION);
  const m =
    options.length === 1
      ? CHAIN_DESCRIPTION.exec(options[0]?.description ?? "")
      : null;
  if (!m?.[1] || !m[2]) return undefined;
  return {
    decision_id: q.id,
    card_id: q.card_id,
    source_commit: m[1],
    unsigned_sha256: q.target.subject.value,
    url_template: m[2],
  };
}
/** An approved, live chain: the one consent every step of the chain reuses. */
export function approvedReleaseChain(
  project: string,
  q: Decision | undefined,
  preferences: ProjectPreferences | undefined,
  events: readonly Event[],
): ReleaseChain | undefined {
  const chain = releaseChainOf(q);
  if (
    !q ||
    !chain ||
    q.trigger ||
    q.superseded_by ||
    q.status !== "resolved" ||
    q.resolution?.option !== RELEASE_CHAIN_OPTION ||
    !publishAuthority(project, q, preferences, events)
  )
    return undefined;
  return chain;
}
/** The final URL this chain approves for one signed APK and its versionName. */
export function releaseChainUrl(
  chain: ReleaseChain,
  version: string,
  signedSha256: string,
) {
  return chain.url_template
    .replaceAll("<version>", version)
    .replaceAll("<sha12>", signedSha256.slice(0, 12));
}

/** Card events recorded by the control plane as the chain advances. */
export const RELEASE_CHAIN_SIGNING_APPROVED = "release_chain_signing_approved";
export const RELEASE_CHAIN_SIGNED = "release_chain_signed";
export interface ReleaseChainSigned {
  readonly decision_id: string;
  readonly request_id: string;
  readonly sha256: string;
}
/** Signed digests bound to this chain from host-verified signing receipts. */
export function releaseChainSigned(
  chain: Pick<ReleaseChain, "decision_id" | "card_id">,
  cardEvents: readonly Event[],
): ReleaseChainSigned[] {
  const out: ReleaseChainSigned[] = [];
  for (const e of cardEvents) {
    const p = e.payload as Partial<ReleaseChainSigned> | undefined;
    if (
      e.type === RELEASE_CHAIN_SIGNED &&
      e.card_id === chain.card_id &&
      e.actor.kind === "system" &&
      p?.decision_id === chain.decision_id &&
      typeof p.request_id === "string" &&
      typeof p.sha256 === "string" &&
      /^[0-9a-f]{64}$/u.test(p.sha256)
    )
      out.push({
        decision_id: p.decision_id,
        request_id: p.request_id,
        sha256: p.sha256,
      });
  }
  return out;
}

/** The packaging template's smoke step (C-612). */
export const RELEASE_SMOKE_KEY = "smoke";
/**
 * A chain publishes only the signed APK its card's smoke step accepted: a
 * smoke work item is accepted and an accepted delivery of it names exactly
 * these bytes (`artifact_sha256`). A smoke step that was cancelled (for
 * example with its card) never passes. Only a card that never had a smoke
 * step (an older packaging card) is unchanged.
 */
export function releaseChainSmoked(
  card_id: string,
  sha256: string,
  work_items: readonly WorkItem[],
  deliveries: readonly Delivery[],
): boolean {
  const smoke = work_items.filter(
    (w) =>
      w.card_id === card_id &&
      w.template_key === RELEASE_SMOKE_KEY &&
      w.kind === "produce",
  );
  return (
    smoke.length === 0 ||
    smoke.some(
      (w) =>
        w.status === "accepted" &&
        deliveries.some(
          (d) =>
            d.work_item_id === w.id &&
            d.status === "accepted" &&
            d.subject.kind === "artifact_sha256" &&
            d.subject.value.toLowerCase() === sha256,
        ),
    )
  );
}

/** The option a publish approval resolves to; publish_artifact checks its description. */
export const PUBLISH_OPTION = "publish";
/** The publish option's description: exactly `发布到 <final HTTPS APK URL>`. */
const PUBLISH_DESCRIPTION = /^发布到 (https:\/\/[^\s/]+\/\S+)$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
/** How PM raises a publish approval; repeated in errors and the tool description. */
export const PUBLISH_APPROVAL_FORMAT =
  "外发拍板的正确格式：category=publish，kind=approve，card_id=附件所在卡片，attachment_ids=[要发布的唯一 APK 附件]，target={subject:{kind:artifact_sha256,value:该附件完整 SHA-256}}（只带一个附件时可省略，系统自动补齐），publish 选项说明=“发布到 <最终 HTTPS APK 地址>”";

/** The final APK URL a publish option names, or undefined when it is not in the required form. */
export function publishOptionUrl(description: string): string | undefined {
  return PUBLISH_DESCRIPTION.exec(description)?.[1];
}

/** A decision raised for publish_artifact: category publish with a publish option. */
export function isPublishApprovalRequest(p: {
  readonly category?: string | undefined;
  readonly options: readonly { readonly key: string }[];
}) {
  return (
    p.category === "publish" && p.options.some((o) => o.key === PUBLISH_OPTION)
  );
}

type ApprovalTarget = Extract<Decision, { kind: "approve" }>["target"];
export type PublishApprovalShape =
  | {
      readonly ok: true;
      readonly attachment: Attachment;
      readonly target: ApprovalTarget;
      readonly url: string;
    }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * C-754: what a publish approval request lacks before it may reach anyone, so
 * the owner never approves one publish_artifact will refuse. A missing target
 * is derived from the single attachment; anything else is listed, never guessed.
 */
export function publishApprovalShape(
  p: {
    readonly kind: string;
    readonly card_id?: string | undefined;
    readonly target?: ApprovalTarget | undefined;
    readonly attachment_ids?: readonly string[] | undefined;
    readonly options: readonly {
      readonly key: string;
      readonly description: string;
    }[];
  },
  attachment: (id: string) => Attachment | undefined,
): PublishApprovalShape {
  const problems: string[] = [];
  if (p.kind !== "approve")
    problems.push(`kind 须为 approve（当前为 ${p.kind}）`);
  if (!p.card_id) problems.push("须带 card_id（要发布的附件所在卡片）");
  const ids = p.attachment_ids ?? [];
  if (ids.length !== 1)
    problems.push(
      ids.length
        ? `attachment_ids 只能带要发布的一个附件（当前 ${ids.length} 个）`
        : "attachment_ids 须带要发布的那一个附件",
    );
  const a = ids.length === 1 ? attachment(ids[0] as string) : undefined;
  if (ids.length === 1 && !a) problems.push(`附件 ${ids[0]} 不存在或已过期`);
  if (a && p.card_id && a.card_id !== p.card_id)
    problems.push(`附件 ${a.id} 不在拍板所在卡片上`);
  if (a && !SHA256.test(a.sha256))
    problems.push(`附件 ${a.id} 没有完整 SHA-256`);
  const target: ApprovalTarget | undefined =
    p.target ??
    (a && SHA256.test(a.sha256)
      ? { subject: { kind: "artifact_sha256", value: a.sha256 } }
      : undefined);
  if (!target)
    problems.push(
      "缺 target：须为 {subject:{kind:artifact_sha256,value:附件完整 SHA-256}}",
    );
  else if (!("subject" in target))
    problems.push("target 须指向附件的 artifact_sha256，不能是交付");
  else if (target.subject.kind !== "artifact_sha256")
    problems.push(
      `target.subject.kind 须为 artifact_sha256（当前为 ${target.subject.kind}）`,
    );
  else if (a && target.subject.value !== a.sha256)
    problems.push(`target 的 SHA-256 与附件 ${a.id} 的完整 SHA-256 不符`);
  const option = p.options.find((o) => o.key === PUBLISH_OPTION);
  const url = option ? publishOptionUrl(option.description) : undefined;
  if (!url) problems.push("publish 选项说明须为“发布到 <最终 HTTPS APK 地址>”");
  return problems.length || !a || !target || !url
    ? { ok: false, problems }
    : { ok: true, attachment: a, target, url };
}

/**
 * C-754: why `q` is not consent to publish `a`, in fixed wording without
 * configuration or credentials; undefined when it is.
 */
export function publicationApprovalProblem(
  project: string,
  a: Attachment,
  q: Decision | undefined,
  preferences: ProjectPreferences | undefined,
  events: readonly Event[],
  /** C-612: this card's events, for the signed digest a release chain bound. */
  cardEvents: readonly Event[] = [],
): string | undefined {
  if (!q) return "拍板不存在";
  if (q.resolution?.option === RELEASE_CHAIN_OPTION) {
    const chain = approvedReleaseChain(project, q, preferences, events);
    if (!chain) return "发布链拍板未批准、已失效或没有有效授权";
    if (chain.card_id !== a.card_id) return "发布链拍板与附件不在同一张卡片";
    if (a.kind !== "artifact") return "附件不是受管产物";
    return releaseChainSigned(chain, cardEvents).some(
      (s) => s.sha256 === a.sha256,
    )
      ? undefined
      : "附件不是这条发布链签出的安装包";
  }
  if (q.category !== "publish") return "拍板类别不是 publish";
  if (q.trigger) return "系统生成的拍板不能作外发授权";
  if (q.superseded_by) return "拍板已被替代";
  if (q.status !== "resolved") return "拍板尚未批准";
  if (q.resolution?.option !== PUBLISH_OPTION) return "拍板没有选 publish";
  if (q.card_id !== a.card_id) return "拍板与附件不在同一张卡片";
  if (q.attachment_ids?.length !== 1 || q.attachment_ids[0] !== a.id)
    return "拍板须且只能带这一个附件";
  if (q.kind !== "approve") return `拍板 kind 须为 approve（当前为 ${q.kind}）`;
  if (!("subject" in q.target) || q.target.subject.kind !== "artifact_sha256")
    return "拍板 target 不是 artifact_sha256";
  if (q.target.subject.value !== a.sha256)
    return "拍板 target 的 SHA-256 与附件不符";
  return publishAuthority(project, q, preferences, events)
    ? undefined
    : "拍板不是所有者在 Needs You 批准，也没有有效的外发代批授权";
}

/** Consent is for these bytes, not a general project preference, merge, or signature. */
export function approvesPublication(
  project: string,
  a: Attachment,
  q: Decision | undefined,
  preferences: ProjectPreferences | undefined,
  events: readonly Event[],
  /** C-612: this card's events, for the signed digest a release chain bound. */
  cardEvents: readonly Event[] = [],
) {
  return (
    publicationApprovalProblem(
      project,
      a,
      q,
      preferences,
      events,
      cardEvents,
    ) === undefined
  );
}
