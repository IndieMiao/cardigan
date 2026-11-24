import {
  type SharedFileActor,
  SharedFilesError,
  sharedFilesAccess,
  sharedFilesAllows,
} from "@cardigan/domain";
import { z } from "zod";
import { ToolError } from "../errors.js";
import {
  SHARED_FILES_NOTICE,
  type SharedFileLibrary,
} from "../shared-files/library.js";
import { defineTool, type ToolContext } from "./types.js";

/**
 * C-685: Agent tools of the shared file library. Every project's Agents see
 * the same library; the project's `shared_files_access` preference narrows a
 * role to read-only or none. Contents move only between the Agent and OSS
 * through the signed URLs these tools return. There is no delete tool.
 */
export interface SharedFileToolOptions {
  readonly sharedFiles?: SharedFileLibrary;
}

const NOTICE = `${SHARED_FILES_NOTICE}文件内容通过签名链接直接与私有存储收发，不经过主机。`;

function library(options: SharedFileToolOptions): SharedFileLibrary {
  if (!options.sharedFiles)
    throw new ToolError("illegal_transition", "共享文件库未在此主机启用");
  return options.sharedFiles;
}

function authorize(
  context: ToolContext,
  needed: "read" | "read_write",
): SharedFileActor {
  try {
    context.revalidateToken?.();
  } catch {
    throw new ToolError("unauthorized", "Token 已失效。");
  }
  const { actor } = context.identity;
  const preferences = context.store.uow.read((tx) =>
    tx.project_preferences?.get(actor.project_id, actor.project_id),
  );
  if (!sharedFilesAllows(sharedFilesAccess(preferences, actor.role_id), needed))
    throw new ToolError(
      "unauthorized",
      needed === "read"
        ? "本项目未允许此角色读取共享文件库"
        : "本项目只允许此角色读取共享文件库",
    );
  return {
    kind: "assignment",
    project_id: actor.project_id,
    assignment_id: actor.assignment_id,
    role_id: actor.role_id,
  };
}

async function run<T>(operation: () => T | Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof SharedFilesError)
      throw new ToolError(
        error.code === "not_found"
          ? "not_found"
          : error.code === "conflict"
            ? "stale_target"
            : error.code === "invalid"
              ? "validation_failed"
              : error.code === "forbidden"
                ? "unauthorized"
                : "illegal_transition",
        error.message,
      );
    throw error;
  }
}

const sharedPath = z.string().min(1).max(1024);

export function sharedFileTools(options: SharedFileToolOptions) {
  return [
    defineTool({
      name: "list_shared_files",
      description: `List one directory of the cross-project shared file library (root when path is omitted): subdirectories and files with size, type, current version, who wrote it and when. ${NOTICE}`,
      input: z.object({ path: z.string().max(1024).optional() }).strict(),
      handler: async (input, context) => {
        authorize(context, "read");
        return run(() => ({
          ...library(options).list(input.path ?? ""),
          notice: SHARED_FILES_NOTICE,
        }));
      },
    }),
    defineTool({
      name: "get_shared_file",
      description: `Get a short-lived signed download URL for a shared file (current version, or version_id from its history) plus its version history. Download it directly, e.g. \`curl -fL -o <local file> '<url>'\`; no Cardigan credential is needed or sent. ${NOTICE}`,
      input: z
        .object({
          path: sharedPath,
          version_id: z.string().min(1).max(64).optional(),
        })
        .strict(),
      handler: async (input, context) => {
        authorize(context, "read");
        return run(() => {
          const shared = library(options);
          const download = shared.download(input.path, input.version_id);
          return {
            ...download,
            versions: shared.history(input.path).versions,
            notice: SHARED_FILES_NOTICE,
          };
        });
      },
    }),
    defineTool({
      name: "upload_shared_file",
      description: `Start uploading a new shared file, or a new version of an existing path (older versions are kept). Returns a signed PUT URL: send the bytes straight to storage with exactly the returned headers, e.g. \`curl -fsS -X PUT -T <local file> -H 'content-type: <type>' -H 'x-oss-forbid-overwrite: true' '<url>'\`, then call commit_shared_file with upload_id. Missing directories are created. Agents can add and update but never delete. ${NOTICE}`,
      input: z
        .object({
          path: sharedPath,
          size: z.number().int().min(0),
          content_type: z.string().max(200).optional(),
          sha256: z
            .string()
            .regex(/^[a-f0-9]{64}$/u)
            .optional(),
        })
        .strict(),
      handler: async (input, context) => {
        const by = authorize(context, "read_write");
        return run(() => ({
          ...library(options).beginUpload(by, input),
          notice: SHARED_FILES_NOTICE,
        }));
      },
    }),
    defineTool({
      name: "commit_shared_file",
      description:
        "Finish an upload started with upload_shared_file after the PUT succeeded: the host checks the stored object's size and makes it the file's current version, recording this Assignment as the writer.",
      input: z.object({ upload_id: z.string().min(1).max(64) }).strict(),
      handler: async (input, context) => {
        const by = authorize(context, "read_write");
        return run(() => library(options).commitUpload(by, input.upload_id));
      },
    }),
  ];
}
