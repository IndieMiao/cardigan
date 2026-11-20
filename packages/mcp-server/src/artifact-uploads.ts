import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import {
  type Attachment,
  type AttachmentTarget,
  artifactUploadRun,
  type Clock,
  prepareStreamedArtifact,
  type RunId,
  uploadAttachment,
} from "@cardigan/domain";
import { artifactPath, receiveArtifact } from "./artifact-files.js";
import {
  executeCommand,
  loadCommandState,
  unwrap,
} from "./commands/execute.js";
import { ToolError } from "./errors.js";
import type { ToolContext } from "./tools/types.js";

type Manifest = AttachmentTarget & { artifact_size: number; sha256: string };
interface Grant {
  id: string;
  token: string;
  key: string;
  run: RunId;
  manifest: Manifest;
  expires: number;
  busy: boolean;
}
const missing = () =>
  ToolError.notFound("No usable artifact upload; request a new upload address");
/** Endpoints are locators, not credentials. No bytes or bearer secrets in the grant table. */
export class ArtifactUploads {
  private grants = new Map<string, Grant>();
  constructor(
    private dir?: string,
    private clock?: Clock,
  ) {}
  private currentRun(context: ToolContext, p: Manifest) {
    context.revalidateToken?.();
    return context.store.uow.read(
      (tx) =>
        unwrap(
          artifactUploadRun(
            loadCommandState(tx, context.identity.actor.project_id),
            context.identity.actor,
            p,
          ),
        ).data,
    );
  }
  reserve(
    ctx: ToolContext,
    key: string,
    manifest: Manifest,
  ):
    | Attachment
    | {
        method: string;
        upload_query: string;
        content_type: string;
        instructions: string;
      } {
    if (
      manifest.mime.length > 255 ||
      !/^[\w.+-]+\/[\w.+-]+$/u.test(manifest.mime)
    )
      throw ToolError.validation("Provide a MIME type without parameters");
    const run = this.currentRun(ctx, manifest);
    const miss = Symbol();
    try {
      // Return the published receipt if the worker lost the final HTTP response.
      const replay = unwrap(
        ctx.store.runIdempotent<Attachment>(
          {
            project_id: ctx.identity.actor.project_id,
            assignment_id: ctx.identity.actor.assignment_id,
            key,
            request: { tool: "upload_attachment", params: manifest },
          },
          () => {
            throw miss;
          },
        ),
      ).value;
      const current = ctx.store.uow.read((tx) =>
        tx.attachments.get(ctx.identity.actor.project_id, replay.id),
      );
      if (!current || current.streamed_artifact?.expired)
        throw ToolError.notFound(
          "Artifact expired; upload again using a new idempotency key",
        );
      return current;
    } catch (err) {
      if (err !== miss) throw err;
    }
    let grant: Grant | undefined;
    for (const [id, g] of this.grants) {
      if (!g.busy && g.expires <= Date.now()) this.grants.delete(id);
      else if (g.token === ctx.identity.token.id) {
        if (
          g.key !== key ||
          g.run !== run ||
          JSON.stringify(g.manifest) !== JSON.stringify(manifest) ||
          g.busy
        )
          throw ToolError.validation("Another artifact upload is pending");
        grant = g;
      }
    }
    if (!grant) {
      if (this.grants.size >= 64)
        throw ToolError.validation("Artifact uploads are busy");
      grant = {
        id: randomUUID(),
        token: ctx.identity.token.id,
        key,
        run,
        manifest,
        expires: Date.now() + 10 * 60_000,
        busy: false,
      };
      this.grants.set(grant.id, grant);
    }
    return {
      method: "POST",
      upload_query: `?artifact_upload=${grant.id}`,
      content_type: "application/octet-stream",
      instructions:
        "Append upload_query to the configured MCP URL. Send raw bytes with this session Bearer, no redirects. Use the returned attachment id and sha256 as evidence.",
    };
  }
  async accept(id: string, req: IncomingMessage, ctx: ToolContext) {
    const g = this.grants.get(id);
    if (
      !g ||
      g.busy ||
      g.expires <= Date.now() ||
      g.token !== ctx.identity.token.id
    )
      throw missing();
    g.busy = true;
    try {
      const p = g.manifest;
      if (this.currentRun(ctx, p) !== g.run) throw missing();
      if (
        req.headers["content-type"] !== "application/octet-stream" ||
        (req.headers["content-length"] !== undefined &&
          req.headers["content-length"] !== String(p.artifact_size))
      )
        throw ToolError.validation("Invalid artifact content type or length");
      const receipt = await prepareStreamedArtifact(g.run, () =>
        receiveArtifact(req, this.dir, p.artifact_size, p.sha256),
      );
      let published = false;
      try {
        const result = executeCommand(
          ctx,
          "upload_attachment",
          g.key,
          p,
          (state, actor, params, ports) =>
            uploadAttachment(state, actor, params, receipt, ports),
          this.clock,
        );
        published =
          result.streamed_artifact?.blob_id === receipt.stream.blob_id;
        return result;
      } finally {
        if (!published)
          await rm(artifactPath(this.dir, receipt.stream.blob_id), {
            force: true,
          });
      }
    } finally {
      this.grants.delete(id);
    }
  }
}
