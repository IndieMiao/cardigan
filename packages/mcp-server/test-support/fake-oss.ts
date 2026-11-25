import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { type OssCredentials, signature } from "../src/offsite/oss.js";

/**
 * C-614 loopback stand-in for one private OSS bucket. It checks that every
 * request carries a V4 signature over exactly the headers and query it was
 * sent with, enforces `x-oss-forbid-overwrite`, `Content-MD5` and pre-signed
 * expiry, and never contacts the cloud. There is no delete.
 */
export interface FakeOss {
  readonly endpoint: string;
  readonly credentials: OssCredentials;
  readonly objects: Map<string, { body: Buffer; sha256?: string }>;
  readonly requests: {
    method: string;
    key: string;
    signed: "header" | "query";
  }[];
  /** `down` drops connections; `denied` answers 403; `corrupt` serves other bytes. */
  mode: "up" | "down" | "denied" | "corrupt";
  /** Awaited before answering a GET, to hold a read open mid-flight. */
  hold: (() => Promise<void>) | undefined;
  close(): Promise<void>;
}

const parseStamp = (s: string) =>
  new Date(
    `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`,
  );

export async function startFakeOss(
  now: () => Date = () => new Date(),
): Promise<FakeOss> {
  const base = {
    bucket: "cardigan-fixture",
    region: "us-west-1",
    access_key_id: "LTAIfixture",
    access_key_secret: "fixture-secret",
  };
  const objects = new Map<string, { body: Buffer; sha256?: string }>();
  const requests: FakeOss["requests"] = [];
  const state = {
    mode: "up" as FakeOss["mode"],
    hold: undefined as FakeOss["hold"],
  };
  let credentials: OssCredentials = base;
  const verify = (req: IncomingMessage, key: string, url: URL) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers))
      if (typeof value === "string") headers[name] = value;
    const query = Object.fromEntries(url.searchParams);
    const auth = headers.authorization;
    if (auth) {
      const match =
        /^OSS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/oss\/aliyun_v4_request,Signature=([a-f0-9]{64})$/u.exec(
          auth,
        );
      const stamp = headers["x-oss-date"] ?? "";
      if (!match || match[1] !== base.access_key_id) return false;
      const { authorization: _, ...signed } = headers;
      return (
        match[4] ===
          signature(credentials, {
            method: req.method ?? "",
            key,
            query,
            headers: signed,
            at: parseStamp(stamp),
          }) && "header"
      );
    }
    const given = query["x-oss-signature"];
    const stamp = query["x-oss-date"] ?? "";
    const expires = Number(query["x-oss-expires"]);
    if (!given || query["x-oss-signature-version"] !== "OSS4-HMAC-SHA256")
      return false;
    const { "x-oss-signature": __, ...rest } = query;
    // C-685: a signed PUT also covers the content-type and x-oss-* headers
    // it is sent with (the canonical request picks them out).
    if (
      given !==
      signature(credentials, {
        method: req.method ?? "",
        key,
        query: rest,
        headers,
        at: parseStamp(stamp),
      })
    )
      return false;
    if (parseStamp(stamp).getTime() + expires * 1000 < now().getTime())
      return "expired";
    return "query";
  };
  const server = createServer((req, res) => {
    if (state.mode === "down") {
      req.socket.destroy();
      return;
    }
    const url = new URL(req.url ?? "/", "http://fake.invalid");
    const key = decodeURIComponent(url.pathname.slice(1));
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      if (req.method === "GET" && state.hold) await state.hold();
      const how = verify(req, key, url);
      if (state.mode === "denied" || !how || how === "expired") {
        res.writeHead(403).end();
        return;
      }
      requests.push({ method: req.method ?? "", key, signed: how });
      const body = Buffer.concat(chunks);
      if (req.method === "PUT") {
        if (
          (how === "header" || req.headers["content-md5"] !== undefined) &&
          req.headers["content-md5"] !==
            createHash("md5").update(body).digest("base64")
        ) {
          res.writeHead(400).end();
          return;
        }
        if (
          req.headers["x-oss-forbid-overwrite"] === "true" &&
          objects.has(key)
        ) {
          res.writeHead(409).end();
          return;
        }
        const sha = req.headers["x-oss-meta-sha256"];
        objects.set(key, {
          body,
          ...(typeof sha === "string" ? { sha256: sha } : {}),
        });
        res.writeHead(200).end();
        return;
      }
      const object = objects.get(key);
      if (!object) {
        res.writeHead(404).end();
        return;
      }
      const served =
        state.mode === "corrupt"
          ? Buffer.alloc(object.body.length, 1)
          : object.body;
      res.writeHead(200, {
        "content-length": served.length,
        ...(object.sha256 ? { "x-oss-meta-sha256": object.sha256 } : {}),
        "content-type":
          url.searchParams.get("response-content-type") ??
          "application/octet-stream",
      });
      res.end(req.method === "HEAD" ? undefined : served);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  credentials = { ...base, endpoint };
  return {
    endpoint,
    credentials,
    objects,
    requests,
    get mode() {
      return state.mode;
    },
    set mode(mode) {
      state.mode = mode;
    },
    get hold() {
      return state.hold;
    },
    set hold(hold) {
      state.hold = hold;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Write the host storage credential for `fake` into a new private directory. */
export async function writeStorageConfig(
  configDir: string,
  fake: Pick<FakeOss, "credentials">,
  extra: Record<string, unknown> = {},
) {
  const dir = join(configDir, "storage");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const c = fake.credentials;
  const file = join(dir, "aliyun-config.json");
  await writeFile(
    file,
    JSON.stringify({
      bucket: c.bucket,
      endpoint: c.endpoint,
      profiles: [
        {
          name: "cardigan-storage",
          mode: "AK",
          region_id: c.region,
          access_key_id: c.access_key_id,
          access_key_secret: c.access_key_secret,
        },
      ],
      ...extra,
    }),
    { mode: 0o600 },
  );
  await chmod(file, 0o600);
  return dir;
}
