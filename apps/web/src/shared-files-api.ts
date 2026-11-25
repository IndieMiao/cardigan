import { ApiError } from "./api.js";

/**
 * C-685: the Workbench side of the shared file library. Listing, directories,
 * versions and deletion go to the host as JSON; file bytes go straight
 * between the browser and the private OSS bucket (a signed PUT to upload, a
 * redirect to a signed GET to download).
 */
export type SharedActor =
  | { readonly kind: "human"; readonly member_id: string | null }
  | {
      readonly kind: "assignment";
      readonly project_id: string;
      readonly assignment_id: string;
      readonly role_id: string;
    };

export interface SharedVersion {
  readonly id: string;
  readonly path: string;
  readonly size: number;
  readonly sha256: string | null;
  readonly content_type: string;
  readonly created_by: SharedActor;
  readonly committed_at: string | null;
}

export interface SharedFileEntry {
  readonly id: string;
  readonly path: string;
  readonly name: string;
  readonly current: SharedVersion;
  readonly version_count: number;
}

export interface SharedDirEntry {
  readonly path: string;
  readonly created_at: string;
  readonly created_by: SharedActor;
}

export interface SharedListingView {
  readonly availability: "ready" | "not_configured" | "unreachable";
  readonly notice: string;
  readonly path: string;
  readonly dirs: readonly SharedDirEntry[];
  readonly files: readonly SharedFileEntry[];
}

export interface SharedUploadTicket {
  readonly upload_id: string;
  readonly method: "PUT";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface SharedFilesClient {
  list(path: string): Promise<SharedListingView>;
  versions(path: string): Promise<{ versions: readonly SharedVersion[] }>;
  mkdir(path: string): Promise<void>;
  beginUpload(input: {
    path: string;
    size: number;
    content_type?: string;
  }): Promise<SharedUploadTicket>;
  /** Sends the bytes to OSS; never to the host. */
  put(
    ticket: SharedUploadTicket,
    file: Blob,
    progress: (fraction: number) => void,
  ): Promise<void>;
  commit(uploadId: string): Promise<void>;
  remove(path: string, kind: "file" | "dir"): Promise<void>;
  downloadHref(path: string, versionId?: string): string;
}

async function json<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    let error: { code?: string; message?: string } | undefined;
    try {
      error = ((await response.json()) as { error?: typeof error }).error;
    } catch {
      // A proxy error page still surfaces as a failure.
    }
    throw new ApiError(
      response.status,
      error?.code ?? `http_${response.status}`,
      error?.message ?? `请求失败（${response.status}）`,
    );
  }
  return (await response.json()) as T;
}

const query = (path: string) => `?${new URLSearchParams({ path })}`;

export const httpSharedFiles: SharedFilesClient = {
  list: (path) => json(`/api/shared-files${query(path)}`),
  versions: (path) => json(`/api/shared-files/versions${query(path)}`),
  mkdir: async (path) => {
    await json("/api/shared-files/dirs", { path });
  },
  beginUpload: (input) => json("/api/shared-files/uploads", input),
  put: (ticket, file, progress) =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(ticket.method, ticket.url);
      for (const [name, value] of Object.entries(ticket.headers))
        xhr.setRequestHeader(name, value);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0)
          progress(event.loaded / event.total);
      };
      xhr.onload = () =>
        xhr.status >= 200 && xhr.status < 300
          ? resolve()
          : reject(
              new ApiError(
                xhr.status,
                "storage_rejected",
                `存储拒绝了上传（${xhr.status}）`,
              ),
            );
      xhr.onerror = () =>
        reject(
          new ApiError(0, "storage_unreachable", "无法连接存储，上传未完成"),
        );
      xhr.send(file);
    }),
  commit: async (uploadId) => {
    await json("/api/shared-files/uploads/commit", { upload_id: uploadId });
  },
  remove: async (path, kind) => {
    await json("/api/shared-files/delete", { path, kind });
  },
  downloadHref: (path, versionId) =>
    `/api/shared-files/download?${new URLSearchParams({
      path,
      ...(versionId ? { version: versionId } : {}),
    })}`,
};

export function sharedActorLabel(actor: SharedActor): string {
  return actor.kind === "human"
    ? "人"
    : `${actor.assignment_id}（${actor.project_id} · ${actor.role_id}）`;
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
