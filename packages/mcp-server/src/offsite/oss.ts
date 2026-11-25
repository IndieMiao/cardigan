import { createHash, createHmac } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Readable } from "node:stream";

/**
 * C-614: the smallest Aliyun OSS client the off-site copy needs, signed with
 * OSS V4 (`OSS4-HMAC-SHA256`) in-process. No SDK, no CLI subprocess, and the
 * secret never leaves this module: errors carry an HTTP status or a fixed
 * code, never a response body, URL or header.
 *
 * Only object reads, writes that refuse to overwrite, HEAD and pre-signed GET
 * URLs exist here. There is deliberately no delete.
 */
export interface OssCredentials {
  readonly bucket: string;
  /** Region id without the `oss-` prefix, e.g. `us-west-1`. */
  readonly region: string;
  readonly access_key_id: string;
  readonly access_key_secret: string;
  /**
   * Base URL that replaces the virtual-hosted bucket origin; tests point it at
   * a loopback fake. Production leaves it unset.
   */
  readonly endpoint?: string;
}

export class OssError extends Error {
  constructor(
    readonly code:
      | "network"
      | "timeout"
      | "not_found"
      | "exists"
      | "denied"
      | "rejected"
      | "integrity",
    readonly status?: number,
  ) {
    super(`OSS request failed: ${code}${status ? ` (${status})` : ""}`);
    this.name = "OssError";
  }
}

const UNRESERVED = /[!'()*]/gu;
/** RFC 3986 encoding as OSS V4 expects it (also used for the URL itself). */
export const ossEncode = (value: string) =>
  encodeURIComponent(value).replace(
    UNRESERVED,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
const encodeKey = (key: string) => ossEncode(key).replace(/%2F/gu, "/");
const hmac = (key: string | Buffer, data: string) =>
  createHmac("sha256", key).update(data).digest();
const hex = (data: string) => createHash("sha256").update(data).digest("hex");

/** `20261123T031500Z` */
export function ossTimestamp(at: Date) {
  return at
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}/u, "");
}

export function bucketOrigin(c: Pick<OssCredentials, "bucket" | "region">) {
  return `https://${c.bucket}.oss-${c.region}.aliyuncs.com`;
}

function validKey(key: string) {
  // C-685: `shared/<uuid>` holds one immutable version of a shared file.
  if (!/^(?:attachments|artifacts|shared)\/[a-z0-9-]{36,64}$/u.test(key))
    throw new OssError("rejected");
  return key;
}

export interface SignInput {
  readonly method: string;
  readonly key: string;
  readonly query: Readonly<Record<string, string>>;
  /** Lower-case names; values as sent. */
  readonly headers: Readonly<Record<string, string>>;
  readonly at: Date;
}

/**
 * Canonical request of OSS V4. Signed headers are `content-type`,
 * `content-md5` and every `x-oss-*` header; nothing is added through
 * `x-oss-additional-headers`.
 */
export function canonicalRequest(c: OssCredentials, input: SignInput) {
  const query = Object.keys(input.query)
    .sort()
    .map((k) => `${ossEncode(k)}=${ossEncode(input.query[k] ?? "")}`)
    .join("&");
  const headers = Object.keys(input.headers)
    .filter(
      (k) =>
        k === "content-type" || k === "content-md5" || k.startsWith("x-oss-"),
    )
    .sort()
    .map((k) => `${k}:${(input.headers[k] ?? "").trim()}\n`)
    .join("");
  return [
    input.method,
    `/${c.bucket}/${encodeKey(input.key)}`,
    query,
    headers,
    "",
    input.headers["x-oss-content-sha256"] ?? "UNSIGNED-PAYLOAD",
  ].join("\n");
}

export function signature(c: OssCredentials, input: SignInput) {
  const stamp = ossTimestamp(input.at),
    day = stamp.slice(0, 8);
  const scope = `${day}/${c.region}/oss/aliyun_v4_request`;
  const toSign = [
    "OSS4-HMAC-SHA256",
    stamp,
    scope,
    hex(canonicalRequest(c, input)),
  ].join("\n");
  let key = hmac(`aliyun_v4${c.access_key_secret}`, day);
  for (const part of [c.region, "oss", "aliyun_v4_request"])
    key = hmac(key, part);
  return createHmac("sha256", key).update(toSign).digest("hex");
}

function objectUrl(c: OssCredentials, key: string, query: string) {
  const base = (c.endpoint ?? bucketOrigin(c)).replace(/\/$/u, "");
  return `${base}/${encodeKey(key)}${query ? `?${query}` : ""}`;
}

export interface PresignOptions {
  /** Seconds the URL stays valid after `at`. */
  readonly expires: number;
  readonly at: Date;
  /** Extra signed query, e.g. `x-oss-process` or `response-*` overrides. */
  readonly query?: Readonly<Record<string, string>>;
}

/** A query-signed GET URL; every parameter, including image processing, is signed. */
export function presignGet(
  c: OssCredentials,
  key: string,
  options: PresignOptions,
) {
  return presignRequest(c, "GET", key, options, {});
}

/**
 * C-685: a query-signed PUT URL for a direct upload. `headers` (lower-case;
 * `content-type` and `x-oss-*`) are part of the signature, so the uploader
 * must send exactly these values; `x-oss-forbid-overwrite: true` makes a
 * replayed URL unable to replace the object once it exists.
 */
export function presignPut(
  c: OssCredentials,
  key: string,
  options: PresignOptions,
  headers: Readonly<Record<string, string>>,
) {
  return presignRequest(c, "PUT", key, options, headers);
}

function presignRequest(
  c: OssCredentials,
  method: "GET" | "PUT",
  key: string,
  options: PresignOptions,
  headers: Readonly<Record<string, string>>,
) {
  validKey(key);
  const stamp = ossTimestamp(options.at);
  const query: Record<string, string> = {
    ...options.query,
    "x-oss-credential": `${c.access_key_id}/${stamp.slice(0, 8)}/${c.region}/oss/aliyun_v4_request`,
    "x-oss-date": stamp,
    "x-oss-expires": String(options.expires),
    "x-oss-signature-version": "OSS4-HMAC-SHA256",
  };
  query["x-oss-signature"] = signature(c, {
    method,
    key,
    query,
    headers,
    at: options.at,
  });
  return objectUrl(
    c,
    key,
    Object.keys(query)
      .sort()
      .map((k) => `${ossEncode(k)}=${ossEncode(query[k] ?? "")}`)
      .join("&"),
  );
}

export interface ObjectHead {
  readonly size: number;
  readonly sha256: string | undefined;
}

export type OssTransport = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: Buffer | Readable;
    signal?: AbortSignal;
    timeoutMs: number;
  },
) => Promise<IncomingMessage>;

/** Node http(s) without redirects, proxies, cookies or connection reuse. */
export const nodeTransport: OssTransport = (url, init) =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(target, {
      method: init.method,
      headers: init.headers,
      agent: false,
      ...(init.signal ? { signal: init.signal } : {}),
    });
    req.setTimeout(init.timeoutMs, () => req.destroy(new OssError("timeout")));
    req.once("response", resolve);
    req.once("error", (error) =>
      reject(error instanceof OssError ? error : new OssError("network")),
    );
    if (init.body === undefined) req.end();
    else if (Buffer.isBuffer(init.body)) req.end(init.body);
    else {
      init.body.once("error", () => req.destroy(new OssError("network")));
      init.body.pipe(req);
    }
  });

const drain = (res: IncomingMessage) => {
  res.resume();
  res.once("error", () => undefined);
};

export class OssClient {
  constructor(
    readonly credentials: OssCredentials,
    private readonly transport: OssTransport = nodeTransport,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async send(
    method: string,
    key: string,
    headers: Record<string, string>,
    body: Buffer | Readable | undefined,
    timeoutMs: number,
    signal?: AbortSignal,
  ) {
    validKey(key);
    const at = this.now();
    const signed: Record<string, string> = {
      ...headers,
      "x-oss-content-sha256": "UNSIGNED-PAYLOAD",
      "x-oss-date": ossTimestamp(at),
    };
    const c = this.credentials;
    const auth = `OSS4-HMAC-SHA256 Credential=${c.access_key_id}/${ossTimestamp(at).slice(0, 8)}/${c.region}/oss/aliyun_v4_request,Signature=${signature(
      c,
      { method, key, query: {}, headers: signed, at },
    )}`;
    try {
      return await this.transport(objectUrl(c, key, ""), {
        method,
        headers: { ...signed, authorization: auth },
        ...(body === undefined ? {} : { body }),
        ...(signal ? { signal } : {}),
        timeoutMs,
      });
    } catch (error) {
      throw error instanceof OssError ? error : new OssError("network");
    }
  }

  /**
   * Upload one object without ever replacing an existing one. `md5` (base64)
   * lets OSS reject bytes that changed after they were verified locally.
   */
  async put(
    key: string,
    body: Buffer | Readable,
    meta: { size: number; sha256: string; md5: string },
    signal?: AbortSignal,
  ): Promise<"created" | "exists"> {
    const res = await this.send(
      "PUT",
      key,
      {
        "content-length": String(meta.size),
        "content-md5": meta.md5,
        "content-type": "application/octet-stream",
        "x-oss-forbid-overwrite": "true",
        "x-oss-meta-sha256": meta.sha256,
      },
      body,
      // Large artifacts: allow about 1 MiB/s plus headroom.
      Math.max(120_000, Math.ceil(meta.size / 1024)),
      signal,
    );
    drain(res);
    if (res.statusCode === 200) return "created";
    if (res.statusCode === 409) return "exists";
    throw new OssError(
      res.statusCode === 403 ? "denied" : "rejected",
      res.statusCode,
    );
  }

  async head(
    key: string,
    signal?: AbortSignal,
  ): Promise<ObjectHead | undefined> {
    const res = await this.send("HEAD", key, {}, undefined, 30_000, signal);
    drain(res);
    if (res.statusCode === 404) return undefined;
    if (res.statusCode !== 200)
      throw new OssError(
        res.statusCode === 403 ? "denied" : "rejected",
        res.statusCode,
      );
    const size = Number(res.headers["content-length"]);
    const sha = res.headers["x-oss-meta-sha256"];
    if (!Number.isSafeInteger(size)) throw new OssError("integrity");
    return {
      size,
      sha256:
        typeof sha === "string" && /^[a-f0-9]{64}$/u.test(sha)
          ? sha
          : undefined,
    };
  }

  /** The object body; the caller verifies size and digest before using it. */
  async get(key: string, timeoutMs: number, signal?: AbortSignal) {
    const res = await this.send("GET", key, {}, undefined, timeoutMs, signal);
    if (res.statusCode === 200) return res;
    drain(res);
    throw new OssError(
      res.statusCode === 404
        ? "not_found"
        : res.statusCode === 403
          ? "denied"
          : "rejected",
      res.statusCode,
    );
  }

  presign(key: string, options: PresignOptions) {
    return presignGet(this.credentials, key, options);
  }

  presignPut(
    key: string,
    options: PresignOptions,
    headers: Readonly<Record<string, string>>,
  ) {
    return presignPut(this.credentials, key, options, headers);
  }
}
