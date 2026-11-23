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
 * A chain publishes only the signed APK its card's smoke step accepted: the
 * smoke work item is accepted and an accepted delivery of it names exactly
 * these bytes (`artifact_sha256`). A card without a smoke step (an older
 * packaging card) is unchanged.
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
      w.kind === "produce" &&
      w.status !== "cancelled",
  );
  return smoke.every(
    (w) =>
      w.status === "accepted" &&
      deliveries.some(
        (d) =>
          d.work_item_id === w.id &&
          d.status === "accepted" &&
          d.subject.kind === "artifact_sha256" &&
          d.subject.value.toLowerCase() === sha256,
      ),
  );
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
  if (q?.resolution?.option === RELEASE_CHAIN_OPTION) {
    const chain = approvedReleaseChain(project, q, preferences, events);
    return (
      chain !== undefined &&
      chain.card_id === a.card_id &&
      a.kind === "artifact" &&
      releaseChainSigned(chain, cardEvents).some((s) => s.sha256 === a.sha256)
    );
  }
  if (
    q?.category !== "publish" ||
    q.trigger ||
    q.superseded_by ||
    q.status !== "resolved" ||
    q.resolution?.option !== "publish" ||
    q.card_id !== a.card_id ||
    q.attachment_ids?.length !== 1 ||
    q.attachment_ids[0] !== a.id ||
    q.kind !== "approve" ||
    !("subject" in q.target) ||
    q.target.subject.kind !== "artifact_sha256" ||
    q.target.subject.value !== a.sha256
  )
    return false;
  return publishAuthority(project, q, preferences, events);
}
