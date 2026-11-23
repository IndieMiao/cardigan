import {
  type Actor,
  type Assignment,
  type AssignmentId,
  type Attachment,
  approvedReleaseChain,
  approvesPublication,
  type CardId,
  cardReadAccess,
  type DecisionId,
  holdsPublicationTool,
  type ProjectId,
  RELEASE_CHAIN_OPTION,
  releaseChainSmoked,
  releaseChainUrl,
  type TransactionContext,
} from "@cardigan/domain";
import { z } from "zod";
import type { McpBackend, McpReadContext } from "../backend.js";
import { ToolError } from "../errors.js";
import { defineTool } from "./types.js";

const input = z
  .object({
    attachment_id: z.string().regex(/^attachment-[1-9][0-9]{0,15}$/u),
    decision_id: z.string().regex(/^Q-[1-9][0-9]{0,15}$/u),
    version: z
      .string()
      .max(80)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u),
    versionCode: z.number().int().positive().max(2100000000),
  })
  .strict();
export type PublishInput = z.infer<typeof input>;
export interface PublicationOptions {
  publishArtifact?: (
    project: string,
    a: Attachment,
    request: PublishInput,
    /**
     * Durably claim the decision for `url`. `existing` (C-609/C-612): the
     * prefix already holds only this release's own objects, which is accepted
     * only to continue this card's own earlier claim of the same URL and
     * artifact; otherwise it throws. Existing objects are then only read
     * back, never overwritten.
     */
    claim: (url: string, existing?: boolean) => void,
    current: () => void,
  ) => Promise<{ url: string; size: number; sha256: string }>;
}
/** Never put raw tool/SDK errors, paths or configuration into responses or audits. */
export class PublicationError extends Error {
  constructor(
    readonly category:
      | "not_enabled"
      | "scope"
      | "approval"
      | "already_claimed"
      | "in_progress"
      | "configuration"
      | "artifact"
      | "signature"
      | "manifest"
      | "immutable_prefix"
      | "upload"
      | "download"
      | "host_error"
      /** C-609: cut off by the server's shutdown; no outcome is recorded. */
      | "interrupted",
  ) {
    super(category);
  }
}
type Phase =
  | "requested"
  | "continued"
  | "claimed"
  | "resumed"
  | "failed"
  | "verified";
/** Host stages that fail before the first OSS write; the approval is not claimed by them. */
const BEFORE_WRITE = new Set<string>([
  "configuration",
  "artifact",
  "signature",
  "manifest",
  "immutable_prefix",
  "host_error",
]);
/**
 * C-612: a failure before the first OSS write consumes nothing, so the same
 * approval is retried as often as needed after a fix. A claimed attempt that
 * ended without verification may be continued with the same approval: the
 * host only writes into an empty prefix or resumes one holding only this
 * release's own files (APK, SHA256SUMS, release.json), writing just the gaps.
 * Only a verified publication or a live attempt in this process refuses.
 */
function verified(
  tx: McpReadContext,
  p: string,
  card: CardId,
  decision: string,
) {
  return tx.events
    .listAfter(p, card, 0)
    .some(
      (e) =>
        e.type === "artifact_publication_verified" &&
        (e.payload as { decision_id?: string })?.decision_id === decision,
    );
}
/**
 * A release chain publishes one APK to one place: once it claimed a URL and
 * digest, it only continues that same receipt (C-612).
 */
function chainClaimedElsewhere(
  tx: McpReadContext,
  p: string,
  card: CardId,
  decision: string,
  receipt: string | undefined,
  sha256: string,
) {
  return tx.events.listAfter(p, card, 0).some((e) => {
    const payload = e.payload as { decision_id?: string; result?: string };
    return (
      e.type === "artifact_publication_claimed" &&
      payload?.decision_id === decision &&
      (receipt === undefined
        ? !payload.result?.endsWith(` · ${sha256}`)
        : payload.result !== receipt)
    );
  });
}
/**
 * One executor per approval and per APK: a second concurrent call for either
 * is refused, never queued.
 */
const running = new Set<string>();
function audit(
  tx: TransactionContext,
  actor: Actor,
  card: CardId,
  request: PublishInput,
  phase: Phase,
  result: string,
  note = "",
) {
  const p = actor.project_id,
    at = new Date().toISOString(),
    seq = tx.ids.nextEventSequence(p, card);
  tx.events.append(p, {
    id: tx.ids.nextEventId(),
    seq,
    card_id: card,
    type: `artifact_publication_${phase}`,
    actor,
    created_at: at,
    payload: { ...request, result },
  });
  const id = tx.ids.nextTimelineEntryId(p, card);
  tx.timeline.put(p, {
    id,
    short_id: id,
    card_id: card,
    event_seq: seq,
    type: "system",
    author: "system",
    body: `测试包外发 ${phase} · ${request.attachment_id} · ${request.decision_id} · ${result}${note}`,
    refs: [],
    mentions: [],
    retracted: false,
    created_at: at,
  });
}
/**
 * C-609: decisions whose publication runs in this process. A claim with no
 * verified result that is not in flight here was cut off (e.g. by a server
 * restart) and may be continued under the same approval.
 */
const inFlight = new Set<string>();

/** The assignment's own scope on the attachment's card, then the approval. */
function authorize(
  tx: McpReadContext,
  p: ProjectId,
  owner: Assignment | undefined,
  request: PublishInput,
  extra: boolean,
  onCard: (card: CardId) => void,
): Attachment {
  const a = tx.attachments.get(p, request.attachment_id);
  if (
    owner?.status !== "active" ||
    !holdsPublicationTool(owner) ||
    !a ||
    !extra
  )
    throw new PublicationError("scope");
  const work =
    owner.scope === "work_item"
      ? tx.work_items.get(p, owner.work_item_id)
      : undefined;
  if (
    (owner.scope === "work_item" && work?.card_id !== a.card_id) ||
    cardReadAccess({
      project_id: p,
      assignment: owner,
      card: tx.cards.get(p, a.card_id),
      work_items: work ? [work] : [],
    }) !== "full"
  )
    throw new PublicationError("scope");
  onCard(a.card_id);
  const q = tx.decisions.get(p, request.decision_id as DecisionId);
  if (
    !approvesPublication(
      p,
      a,
      q,
      tx.project_preferences?.get(p, p),
      q?.resolution?.via === "delegated"
        ? tx.events.listAfter(p, undefined, 0)
        : [],
      q?.resolution?.option === RELEASE_CHAIN_OPTION
        ? tx.events.listAfter(p, a.card_id, 0)
        : [],
    )
  )
    throw new PublicationError("approval");
  // C-612: under a chain, only the signed APK the card's smoke step
  // accepted; checked again at the claim, before any write.
  if (
    q?.resolution?.option === RELEASE_CHAIN_OPTION &&
    !releaseChainSmoked(
      a.card_id,
      a.sha256,
      tx.work_items.list(p),
      tx.deliveries.list(p),
    )
  )
    throw new PublicationError("approval");
  return a;
}

/**
 * One publication run, by the tool or by the host continuing an interrupted
 * one (C-609). Every check is the same; only who is audited differs.
 */
async function runPublication(
  options: PublicationOptions,
  store: McpBackend,
  run: {
    readonly project: ProjectId;
    readonly request: PublishInput;
    /** Audited actor: the calling assignment, or the system continuing. */
    readonly actor: Actor;
    /** Throws `scope`/`approval`; reports the card as soon as it is known. */
    readonly authorized: (
      tx: McpReadContext,
      onCard: (card: CardId) => void,
    ) => Attachment;
    readonly revalidate: () => void;
    readonly start: "requested" | "continued";
  },
) {
  const { project: p, request } = run;
  let card: CardId | undefined;
  const onCard = (id: CardId) => {
    card = id;
  };
  const flight = JSON.stringify([p, request.decision_id]);
  let flying = false;
  try {
    const revalidate = () => {
      try {
        run.revalidate();
      } catch {
        throw new PublicationError("scope");
      }
    };
    revalidate();
    const a = store.uow.read((tx) => run.authorized(tx, onCard));
    if (!options.publishArtifact) throw new PublicationError("not_enabled");
    const publish = options.publishArtifact;
    const slot = `${p}/${request.decision_id}`,
      bytes = `${p}/sha256/${a.sha256}`;
    if (running.has(slot) || running.has(bytes)) {
      // Another executor holds this approval or APK: refuse without any
      // audit row, so its own outcome stays the last word on the card.
      card = undefined;
      throw new PublicationError("in_progress");
    }
    running.add(slot);
    running.add(bytes);
    try {
      // C-609: durable before any wait, so a restart can pick it up again.
      store.uow.run((tx) =>
        audit(tx, run.actor, a.card_id, request, run.start, a.sha256),
      );
      // C-612: refused before any host IO; the claim below re-checks
      // atomically.
      store.uow.read((tx) => {
        if (verified(tx, p, a.card_id, request.decision_id))
          throw new PublicationError("already_claimed");
        if (
          tx.decisions.get(p, request.decision_id as DecisionId)?.resolution
            ?.option === RELEASE_CHAIN_OPTION &&
          chainClaimedElsewhere(
            tx,
            p,
            a.card_id,
            request.decision_id,
            undefined,
            a.sha256,
          )
        )
          throw new PublicationError("already_claimed");
      });
      const fresh = (tx: McpReadContext) => {
        const now = run.authorized(tx, onCard);
        if (
          now.card_id !== a.card_id ||
          now.sha256 !== a.sha256 ||
          now.size !== a.size ||
          now.streamed_artifact?.expired
        )
          throw new PublicationError("artifact");
      };
      const claim = (url: string, existing = false) => {
        revalidate();
        store.uow.run((tx) => {
          fresh(tx);
          const decision = tx.decisions.get(
            p,
            request.decision_id as DecisionId,
          );
          const chain =
            decision?.resolution?.option === RELEASE_CHAIN_OPTION
              ? approvedReleaseChain(
                  p,
                  decision,
                  tx.project_preferences?.get(p, p),
                  decision.resolution.via === "delegated"
                    ? tx.events.listAfter(p, undefined, 0)
                    : [],
                )
              : undefined;
          if (
            chain
              ? releaseChainUrl(chain, request.version, a.sha256) !== url
              : !decision?.options.some(
                  (o) =>
                    o.key === "publish" && o.description === `发布到 ${url}`,
                )
          )
            throw new PublicationError("approval");
          const events = tx.events.listAfter(p, a.card_id, 0);
          const mine = events.filter(
            (e) =>
              (e.payload as { decision_id?: string })?.decision_id ===
              request.decision_id,
          );
          const target = `${url} · ${a.sha256}`;
          if (
            mine.some((e) => e.type === "artifact_publication_verified") ||
            (chain &&
              chainClaimedElsewhere(
                tx,
                p,
                a.card_id,
                request.decision_id,
                target,
                a.sha256,
              ))
          )
            throw new PublicationError("already_claimed");
          const note = existing
            ? "（续做：目录中只有本次发布写入的文件，已有的只回读核验，只补写缺项）"
            : "";
          const claimed = mine.find(
            (e) => e.type === "artifact_publication_claimed",
          );
          if (claimed) {
            // Continue only the same URL and artifact, never a verified or
            // running publication; the objects are re-verified, never
            // overwritten.
            if (
              (claimed.payload as { result?: string }).result !== target ||
              inFlight.has(flight)
            )
              throw new PublicationError("already_claimed");
            audit(tx, run.actor, a.card_id, request, "resumed", target, note);
          } else {
            // C-612: under a new approval, only this card's own earlier
            // claim of the same URL and digest proves who wrote the
            // existing files.
            if (
              existing &&
              !events.some(
                (e) =>
                  e.type === "artifact_publication_claimed" &&
                  (e.payload as { result?: string })?.result === target,
              )
            )
              throw new PublicationError("immutable_prefix");
            audit(tx, run.actor, a.card_id, request, "claimed", target, note);
          }
          inFlight.add(flight);
          flying = true;
        });
      };
      const result = await publish(p, a, request, claim, () => {
        revalidate();
        store.uow.read(fresh);
      });
      revalidate();
      store.uow.run((tx) => {
        fresh(tx);
        audit(
          tx,
          run.actor,
          a.card_id,
          request,
          "verified",
          `${result.url} · ${result.size} bytes · SHA-256 ${result.sha256}`,
        );
      });
      return result;
    } finally {
      running.delete(slot);
      running.delete(bytes);
    }
  } catch (e) {
    const category = e instanceof PublicationError ? e.category : "host_error";
    // C-609: a run cut off by the server's own shutdown records no outcome;
    // the next server continues it.
    let note = "";
    if (card && category !== "interrupted") {
      const id = card;
      try {
        note = BEFORE_WRITE.has(category)
          ? "（未写入，修复后可用同一授权直接重试）"
          : category === "upload" || category === "download"
            ? "（可能已写入部分对象，可用同一授权再次调用续做）"
            : "";
        store.uow.run((tx) =>
          audit(tx, run.actor, id, request, "failed", category, note),
        );
      } catch {
        throw new ToolError("validation_failed", "测试包外发审计不可用");
      }
    }
    throw new ToolError(
      category === "scope" || category === "approval"
        ? "forbidden_tool"
        : "validation_failed",
      `测试包外发未放行：${category}${note}`,
    );
  } finally {
    if (flying) inFlight.delete(flight);
  }
}

export function publicationTool(options: PublicationOptions) {
  return defineTool({
    name: "publish_artifact",
    description:
      "Publish one signed test APK to this project's configured HTTPS destination. Approval is either a same-card resolved publish approval (option publish) targeting the full artifact_sha256 and attachment_id, with the publish option description exactly `发布到 <final HTTPS APK URL>`, or the card's approved release chain, which covers the signed APK the system bound from the signing receipt and, when the card has a smoke step, only the one whose accepted smoke delivery names it (subject artifact_sha256). A release chain is one publish approval for intake, signing, signed intake and publication: kind approve, target.subject artifact_sha256 = the unsigned APK digest, and one option `release_chain` described exactly `发布链 <40-hex source commit> 发布到 <https APK URL template>`, where the template may use `<version>` (versionName) and `<sha12>` (first 12 hex of the signed APK digest). Use the chain decision as the basis for the unsigned intake. A failure before any OSS write consumes nothing: fix it and call again with the same decision. After a failure once writing began, calling again with the same (or a new) approval resumes: the files this release already wrote are read back and verified, only the missing ones are written, and nothing is overwritten. Returns verified URL, size and SHA-256; never accepts credentials, commands or paths.",
    input,
    handler: async (request, ctx) => {
      const { actor, token } = ctx.identity,
        p = actor.project_id;
      if (!ctx.revalidateToken)
        throw new ToolError("forbidden_tool", "测试包外发未放行：scope");
      const revalidateToken = ctx.revalidateToken;
      return runPublication(options, ctx.store, {
        project: p,
        request,
        actor,
        start: "requested",
        revalidate: () => revalidateToken(),
        authorized: (tx, onCard) => {
          const owner = tx.assignments.get(p, actor.assignment_id);
          return authorize(
            tx,
            p,
            owner,
            request,
            actor.allowed_tools.includes("publish_artifact") &&
              owner?.role_id === actor.role_id &&
              owner.role_version === token.role_version,
            onCard,
          );
        },
      });
    },
  });
}

/** Most automatic continuations of one decision across server restarts. */
export const MAX_PUBLICATION_CONTINUATIONS = 3;

/**
 * C-609: continue a publication a server restart cut off, without waiting for
 * its caller to call again. It runs as the system but only within the
 * original assignment's current scope and the same approval, URL and
 * artifact; existing objects are re-verified and never overwritten.
 */
export function continuePublication(
  options: PublicationOptions,
  store: McpBackend,
  job: {
    readonly project: ProjectId;
    readonly assignment: AssignmentId;
    readonly request: PublishInput;
  },
) {
  const request = input.parse(job.request);
  const authorized = (tx: McpReadContext, onCard: (card: CardId) => void) =>
    authorize(
      tx,
      job.project,
      tx.assignments.get(job.project, job.assignment),
      request,
      true,
      onCard,
    );
  return runPublication(options, store, {
    project: job.project,
    request,
    actor: { kind: "system", project_id: job.project },
    start: "continued",
    revalidate: () => {
      store.uow.read((tx) => authorized(tx, () => {}));
    },
    authorized,
  });
}

/**
 * C-609: from one decision's publication events in order, whether a run was
 * cut off without an outcome and may still be continued automatically.
 */
export function interruptedPublication(
  events: readonly { readonly type: string; readonly actor: Actor }[],
): boolean {
  let starts = 0,
    ends = 0,
    continued = 0;
  for (const e of events) {
    if (e.type === "artifact_publication_verified") return false;
    if (e.type === "artifact_publication_requested") starts++;
    // A continuation takes over a cut-off run: its outcome is that run's.
    if (e.type === "artifact_publication_continued") continued++;
    if (e.type === "artifact_publication_failed") ends++;
  }
  return (
    starts > ends &&
    continued < MAX_PUBLICATION_CONTINUATIONS &&
    events.some((e) => e.type === "artifact_publication_requested")
  );
}
