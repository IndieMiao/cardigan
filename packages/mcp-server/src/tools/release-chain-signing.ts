import { rm } from "node:fs/promises";
import { Readable } from "node:stream";
import {
  type Attachment,
  type AttachmentTarget,
  approvedReleaseChain,
  type CardId,
  type Event,
  prepareStreamedArtifact,
  RELEASE_CHAIN_SIGNED,
  RELEASE_CHAIN_SIGNING_APPROVED,
  type ReleaseChain,
  type TimelineEntryId,
  uploadAttachment,
} from "@cardigan/domain";
import {
  artifactPath,
  openArtifact,
  receiveArtifact,
} from "../artifact-files.js";
import { fileAttachmentStore } from "../attachments.js";
import type { McpReadContext } from "../backend.js";
import { executeCommand } from "../commands/execute.js";
import type { MobileSigningOptions, SigningScope } from "./mobile-signing.js";
import type { ToolContext } from "./types.js";

/** What the control service needs to register the chain's candidate for one Run. */
export interface ChainCandidate {
  readonly commit: string;
  readonly sha256: string;
  readonly size: number;
  /** Build reference recorded in the signing ledger: the unsigned attachment. */
  readonly build: string;
  readonly source: () => Promise<Readable>;
}
export interface ChainGrant {
  readonly request_id: string;
  /** `other`: this Run already holds a different or revoked grant; not this chain's. */
  readonly status: "new" | "existing" | "other";
}
interface Prepared {
  readonly chain: ReleaseChain;
  readonly request_id: string;
}

function record(
  tx: Parameters<Parameters<ToolContext["store"]["uow"]["run"]>[0]>[0],
  project: string,
  card: CardId,
  type: string,
  payload: Record<string, unknown>,
  body: string,
) {
  const at = new Date().toISOString(),
    seq = tx.ids.nextEventSequence(project, card);
  tx.events.append(project, {
    id: tx.ids.nextEventId(),
    seq,
    card_id: card,
    type,
    actor: { kind: "system", project_id: project },
    created_at: at,
    payload,
  } as Event);
  const id = tx.ids.nextTimelineEntryId(project, card);
  tx.timeline.put(project, {
    id,
    short_id: id,
    card_id: card,
    event_seq: seq,
    type: "system",
    author: "system",
    body,
    refs: [],
    mentions: [],
    retracted: false,
    created_at: at,
  });
  return id;
}
const payloadOf = (e: Event) =>
  (e.payload ?? {}) as Record<string, string | undefined>;

/** The newest approved chain on this card whose unsigned package is stored here. */
function chainCandidate(tx: McpReadContext, scope: SigningScope) {
  const p = scope.project,
    prefs = tx.project_preferences?.get(p, p),
    projectEvents = tx.events.listAfter(p, undefined, 0),
    cardEvents = tx.events.listAfter(p, scope.card as CardId, 0);
  const chains = tx.decisions
    .list(p)
    .filter((q) => q.card_id === scope.card)
    .sort((a, b) =>
      (b.resolution?.at ?? "").localeCompare(a.resolution?.at ?? ""),
    )
    .map((q) => approvedReleaseChain(p, q, prefs, projectEvents))
    .filter((c) => c !== undefined);
  const attachments = tx.attachments
    .list(p)
    .filter(
      (a) =>
        a.card_id === scope.card &&
        a.kind === "artifact" &&
        !a.streamed_artifact?.expired,
    );
  for (const chain of chains) {
    const known = cardEvents.find(
      (e) =>
        e.type === RELEASE_CHAIN_SIGNING_APPROVED &&
        payloadOf(e).decision_id === chain.decision_id &&
        payloadOf(e).run_id === scope.run,
    );
    if (known)
      return {
        chain,
        known: payloadOf(known).request_id ?? "",
        attachment: undefined,
      };
    const attachment = attachments
      .filter((a) => a.sha256 === chain.unsigned_sha256)
      .at(-1);
    if (attachment) return { chain, known: undefined, attachment };
  }
  return undefined;
}

async function bytes(
  options: MobileSigningOptions,
  a: Attachment,
): Promise<Readable> {
  if (a.streamed_artifact) {
    const file = await openArtifact(options.dataDir, a);
    return file.createReadStream({
      start: 0,
      end: a.size - 1,
      autoClose: true,
    });
  }
  const small = await (
    options.attachmentStore ?? fileAttachmentStore(options.dataDir)
  ).get(a.sha256);
  if (!small) throw new Error("Attachment content unavailable");
  return Readable.from([small]);
}

/**
 * C-612: an approved release chain stands in for the operator's register +
 * approve of this Run's Android test candidate. Never blocks signing: any
 * failure here leaves the ordinary path (an operator-approved grant, or a
 * refusal by the host) unchanged.
 */
export async function prepareReleaseChain(
  options: MobileSigningOptions,
  ctx: ToolContext,
  scope: SigningScope,
  current: () => void,
): Promise<Prepared | undefined> {
  if (scope.platform !== "android" || !options.chainSigning) return undefined;
  try {
    const found = ctx.store.uow.read((tx) => chainCandidate(tx, scope));
    if (!found) return undefined;
    if (found.known) return { chain: found.chain, request_id: found.known };
    const a = found.attachment;
    if (!a) return undefined;
    const grant = await options.chainSigning(
      scope,
      {
        commit: found.chain.source_commit,
        sha256: a.sha256,
        size: a.size,
        build: a.id,
        source: () => bytes(options, a),
      },
      current,
    );
    if (grant.status === "other") return undefined;
    current();
    ctx.store.uow.run((tx) => {
      if (
        tx.events
          .listAfter(scope.project, scope.card as CardId, 0)
          .some(
            (e) =>
              e.type === RELEASE_CHAIN_SIGNING_APPROVED &&
              payloadOf(e).request_id === grant.request_id,
          )
      )
        return;
      record(
        tx,
        scope.project,
        scope.card as CardId,
        RELEASE_CHAIN_SIGNING_APPROVED,
        {
          decision_id: found.chain.decision_id,
          attachment_id: a.id,
          unsigned_sha256: a.sha256,
          request_id: grant.request_id,
          run_id: scope.run,
        },
        `发布链 ${found.chain.decision_id} 已自动登记并批准送签 · ${a.id} · ${a.sha256} · 请求号 ${grant.request_id} · ${scope.run}`,
      );
    });
    return { chain: found.chain, request_id: grant.request_id };
  } catch {
    return undefined;
  }
}

/**
 * Bind the signed digest from the host-verified receipt to the chain, then
 * store the signed output as this card's artifact straight from the control
 * host (signed intake): no download and re-upload, and the digest is the
 * server's own. A failed intake is reported and retried on the next poll.
 */
export async function signedIntake(
  options: MobileSigningOptions,
  ctx: ToolContext,
  scope: SigningScope,
  current: () => void,
  prepared: Prepared,
  receipt: { request_id: string; sha256: string },
): Promise<Record<string, unknown>> {
  const p = scope.project,
    card = scope.card as CardId,
    decision_id = prepared.chain.decision_id;
  const entry = ctx.store.uow.run((tx): TimelineEntryId => {
    const done = tx.events
      .listAfter(p, card, 0)
      .find(
        (e) =>
          e.type === RELEASE_CHAIN_SIGNED &&
          payloadOf(e).decision_id === decision_id &&
          payloadOf(e).request_id === receipt.request_id,
      );
    const existing =
      done &&
      tx.timeline
        .list(p)
        .find((t) => t.card_id === card && t.event_seq === done.seq);
    if (existing) return existing.id;
    return record(
      tx,
      p,
      card,
      RELEASE_CHAIN_SIGNED,
      { decision_id, request_id: receipt.request_id, sha256: receipt.sha256 },
      `发布链 ${decision_id} 签名回执已绑定 · 请求号 ${receipt.request_id} · 签后 SHA-256 ${receipt.sha256}`,
    );
  });
  const stored = () =>
    ctx.store.uow.read((tx) =>
      tx.attachments
        .list(p)
        .find(
          (a) =>
            a.card_id === card &&
            a.kind === "artifact" &&
            a.basis === decision_id &&
            a.sha256 === receipt.sha256 &&
            !a.streamed_artifact?.expired,
        ),
    );
  const base = { decision_id, signed_sha256: receipt.sha256 };
  const earlier = stored();
  if (earlier) return { ...base, signed_attachment_id: earlier.id };
  if (!options.openMobileArtifact)
    return { ...base, signed_intake: "unavailable" };
  try {
    const file = await options.openMobileArtifact(
      scope,
      receipt.request_id,
      current,
    );
    if (file.sha256 !== receipt.sha256) {
      file.stream.destroy();
      throw new Error("digest");
    }
    const target: AttachmentTarget = {
      card_id: card,
      mime: "application/vnd.android.package-archive",
      kind: "artifact",
      basis: decision_id as AttachmentTarget["basis"] & string,
      attach_to: { kind: "timeline_entry", id: entry },
      original_filename: `${receipt.request_id}.apk`,
      note: `发布链 ${decision_id} 签后入库`,
    } as AttachmentTarget;
    const receiptStored = await prepareStreamedArtifact(
      scope.run as never,
      () =>
        receiveArtifact(
          file.stream,
          options.dataDir,
          file.size,
          receipt.sha256,
          () => {},
        ),
    );
    let published = false;
    try {
      current();
      const result = executeCommand(
        ctx,
        "upload_attachment",
        `release-chain-signed-${receipt.request_id}`,
        { ...target, sha256: receipt.sha256, artifact_size: file.size },
        (state, actor, { sha256: _s, artifact_size: _n, ...params }, ports) =>
          uploadAttachment(state, actor, params, receiptStored, ports),
      ) as Attachment;
      published =
        result.streamed_artifact?.blob_id === receiptStored.stream.blob_id;
      return { ...base, signed_attachment_id: result.id };
    } finally {
      if (!published)
        await rm(artifactPath(options.dataDir, receiptStored.stream.blob_id), {
          force: true,
        });
    }
  } catch {
    const later = stored();
    return later
      ? { ...base, signed_attachment_id: later.id }
      : { ...base, signed_intake: "retry" };
  }
}
