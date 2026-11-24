import type { IncomingMessage } from "node:http";
import {
  type Attachment,
  type AttachmentTarget,
  artifactUploadRun,
  type Clock,
  prepareStreamedAttachment,
  uploadAttachment,
} from "@cardigan/domain";
import {
  executeCommand,
  loadCommandState,
  unwrap,
} from "./commands/execute.js";
import { ToolError } from "./errors.js";
import type { ToolContext } from "./tools/types.js";
import {
  type UploadSessions,
  type UploadStatus,
  uploadSessionsFor,
} from "./upload-sessions.js";

type Manifest = AttachmentTarget & { artifact_size: number; sha256: string };

/**
 * C-683: Agents upload a video in chunks through the Card MCP endpoint.
 *
 * `upload_attachment` with a video type, `artifact_size` and `sha256` opens
 * (or, with the same idempotency key, resumes) an upload and says where to
 * send it. Each `PUT ?attachment_upload=<id>&offset=<n>` carries one chunk;
 * `GET ?attachment_upload=<id>` reports the offset to continue from. The
 * last chunk publishes the checked file as a durable attachment (not an
 * expiring artifact) under the same idempotency key, and its reply is the
 * attachment record.
 */
export class VideoUploads {
  constructor(
    private readonly dataDir: string,
    private readonly clock?: Clock,
    private readonly injected?: UploadSessions,
  ) {}

  private get sessions() {
    return this.injected ?? uploadSessionsFor(this.dataDir);
  }

  private owner(context: ToolContext) {
    return `assignment:${context.identity.actor.project_id}/${context.identity.assignment.id}`;
  }

  /** The published record when the key already produced one. */
  private replay(
    context: ToolContext,
    key: string,
    manifest: Manifest,
  ): Attachment | undefined {
    const miss = Symbol();
    try {
      const done = unwrap(
        context.store.runIdempotent<Attachment>(
          {
            project_id: context.identity.actor.project_id,
            assignment_id: context.identity.actor.assignment_id,
            key,
            request: { tool: "upload_attachment", params: manifest },
          },
          () => {
            throw miss;
          },
        ),
      ).value;
      return context.store.uow.read((tx) =>
        tx.attachments.get(context.identity.actor.project_id, done.id),
      );
    } catch (error) {
      if (error !== miss) throw error;
      return undefined;
    }
  }

  async reserve(
    context: ToolContext,
    key: string,
    manifest: Manifest,
  ): Promise<Attachment | Record<string, unknown>> {
    context.revalidateToken?.();
    // The target is checked before any byte is sent.
    context.store.uow.read((tx) =>
      unwrap(
        artifactUploadRun(
          loadCommandState(tx, context.identity.actor.project_id),
          context.identity.actor,
          manifest,
        ),
      ),
    );
    const done = this.replay(context, key, manifest);
    if (done) return done;
    const status = await this.sessions.create(this.owner(context), {
      size: manifest.artifact_size,
      mime: manifest.mime,
      sha256: manifest.sha256,
      key,
      target: { key, manifest },
    });
    // Every byte arrived but the record was not written (say the reply was
    // refused): asking again with the same key publishes it now.
    if (status.complete) return this.finish(status.upload_id, context);
    return {
      ...status,
      method: "PUT",
      upload_query: `?attachment_upload=${status.upload_id}&offset=${status.received}`,
      content_type: "application/octet-stream",
      instructions: `Append upload_query to the configured MCP URL and PUT raw bytes with this session Bearer, at most chunk_bytes per request, offset being the bytes already sent. Each reply gives the new received offset; after a failure GET ?attachment_upload=${status.upload_id} (or call upload_attachment again with the same idempotency key) and continue from received. The last chunk's reply is the attachment.`,
    };
  }

  async status(id: string, context: ToolContext) {
    context.revalidateToken?.();
    return this.sessions.status(this.owner(context), id);
  }

  async accept(
    id: string,
    offset: number,
    req: IncomingMessage,
    context: ToolContext,
    noteProgress: () => void,
  ): Promise<
    | { complete: false; status: UploadStatus }
    | { complete: true; attachment: Attachment }
  > {
    context.revalidateToken?.();
    if (req.headers["content-type"] !== "application/octet-stream")
      throw ToolError.validation("Send chunks as application/octet-stream");
    const owner = this.owner(context);
    const status = await this.sessions.append(
      owner,
      id,
      offset,
      req,
      noteProgress,
    );
    if (!status.complete) return { complete: false as const, status };
    return {
      complete: true as const,
      attachment: await this.finish(id, context),
    };
  }

  /** Publish a complete upload under the key it was opened with. */
  private async finish(id: string, context: ToolContext): Promise<Attachment> {
    const owner = this.owner(context);
    const { key, manifest } = (await this.sessions.target(owner, id)) as {
      key: string;
      manifest: Manifest;
    };
    const done = this.replay(context, key, manifest);
    if (done) {
      await this.sessions.remove(owner, id);
      return done;
    }
    const receipt = unwrap(
      await prepareStreamedAttachment(
        manifest.sha256,
        manifest.artifact_size,
        async () => this.sessions.publish(owner, id),
      ),
    );
    const { artifact_size: _size, sha256: _digest, ...target } = manifest;
    const attachment = executeCommand(
      context,
      "upload_attachment",
      key,
      manifest,
      (state, actor, _params, ports) =>
        uploadAttachment(state, actor, target, receipt, ports),
      this.clock,
    );
    await this.sessions.remove(owner, id);
    return attachment;
  }
}
