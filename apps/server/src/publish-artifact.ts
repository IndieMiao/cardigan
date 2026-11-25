import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import type { Attachment } from "@cardigan/domain";
import {
  fileAttachmentStore,
  openArtifact,
  PublicationError,
  type PublicationOptions,
} from "@cardigan/mcp-server";
import {
  ossEnvironment,
  type PublishTarget,
  publicationTarget,
} from "./publication-target.js";

const digest = (b: Buffer) => createHash("sha256").update(b).digest("hex");
async function stageApk(data: string, a: Attachment, dest: string) {
  try {
    if (
      !Number.isSafeInteger(a.size) ||
      a.size <= 0 ||
      !/^[a-f0-9]{64}$/u.test(a.sha256)
    )
      throw Error();
    const hash = createHash("sha256");
    let bytes = 0,
      first = -1;
    const file = a.streamed_artifact ? await openArtifact(data, a) : undefined;
    try {
      const small = file
        ? undefined
        : await fileAttachmentStore(data).get(a.sha256);
      const stream =
        file?.createReadStream({ end: a.size }) ??
        (small ? Readable.from([small]) : undefined);
      if (!stream) throw Error();
      await pipeline(
        stream,
        new Transform({
          transform(b: Buffer, _enc, cb) {
            bytes += b.length;
            if (bytes > a.size) return cb(Error());
            if (first < 0) first = b[0] ?? -1;
            hash.update(b);
            cb(null, b);
          },
        }),
        createWriteStream(dest, { flags: "wx", mode: 0o600 }),
      );
    } finally {
      await file?.close();
    }
    if (bytes !== a.size || hash.digest("hex") !== a.sha256) throw Error();
    return first;
  } catch {
    throw new PublicationError("artifact");
  }
}
/**
 * `apksigner verify --verbose --print-certs` labels each scheme's signer. Build Tools 37
 * (apksigner 0.9) prints `V1 Signer:`, `V2 Signer:`, `V3.0 Signer:` and, for SDK-targeted
 * signing, `V3.1 Signer: (minSdkVersion=…, maxSdkVersion=…)`; Build Tools 36.1 prints
 * `Signer (minSdkVersion=…, maxSdkVersion=…)` there, and older releases `Signer #n`.
 * Require a verified APK with exactly one signer whose every reported certificate equals
 * the registered one; any other certificate digest line fails closed.
 */
export function signedOnlyBy(output: string, certificate: string) {
  const lines = output.split(/\r?\n/u);
  const digests = lines.filter((l) =>
    l.includes("certificate SHA-256 digest:"),
  );
  const seen = digests.map((l) =>
    /^(?:Signer #(\d+)|Signer \(minSdkVersion=\d+, maxSdkVersion=\d+\)|V[1-9](?:\.\d)? Signer:(?: \(minSdkVersion=\d+, maxSdkVersion=\d+\))?) certificate SHA-256 digest: ([a-fA-F0-9]{64})$/u.exec(
      l,
    ),
  );
  return (
    lines.includes("Verifies") &&
    lines.filter((l) => l.startsWith("Number of signers:")).join() ===
      "Number of signers: 1" &&
    seen.length > 0 &&
    seen.every(
      (m) =>
        m !== null &&
        (m[1] === undefined || m[1] === "1") &&
        m[2]?.toLowerCase() === certificate,
    )
  );
}

/** OSS reports an empty configuration only when versioning was never enabled. */
export const versioningOff = (xml: string) =>
  /^(?:<\?xml [^?]*\?>\s*)?<VersioningConfiguration(?: xmlns="[^"]+")?\s*(?:\/>|>\s*<\/VersioningConfiguration>)$/u.test(
    xml.trim(),
  );

export type Execute = (
  tool: string,
  args: string[],
  cwd: string,
  environment?: Record<string, string>,
) => Promise<string>;

/** Credentials only reach the ossutil child through its environment, never argv or a config file. */
export const ossApi =
  (
    execute: Execute,
    t: PublishTarget,
    dir: string,
    credentials: Record<string, string>,
  ) =>
  (api: string, ...args: string[]) =>
    execute(
      t.ossutil,
      [
        "api",
        api,
        "--bucket",
        t.bucket,
        "--region",
        t.region,
        "--endpoint",
        `https://oss-${t.region}.aliyuncs.com`,
        "--config-file",
        "/dev/null",
        "--mode",
        "AK",
        "--retry-times",
        "0",
        "--loglevel",
        "off",
        ...args,
      ],
      dir,
      credentials,
    ).then((stdout) =>
      stdout.replace(/\n[0-9]+(?:\.[0-9]+)?\(s\) elapsed\s*$/u, ""),
    );

export const run: Execute = async (
  tool: string,
  args: string[],
  cwd: string,
  environment?: Record<string, string>,
) =>
  (
    await promisify(execFile)(tool, args, {
      cwd,
      env: { PATH: "/usr/bin:/bin", HOME: cwd, LANG: "C", ...environment },
      timeout: 600000,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    })
  ).stdout;

/** Seconds between public read-back attempts: a CDN may briefly miss a just-written object. */
export const READBACK_DELAYS = [5000, 15000, 30000, 60000] as const;
const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
/** A CDN fill race (missing object, Range ignored, wrong Content-Range, cut connection). */
class Transient extends Error {}

/** No redirects, cookies or OSS credentials on the public download path. */
async function readOnce(
  get: typeof fetch,
  url: string,
  size: number,
  sha256: string,
  range?: { total: number; first: number },
) {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 600000).unref();
  try {
    let res: Response;
    try {
      res = await get(url, {
        redirect: "error",
        credentials: "omit",
        signal: abort.signal,
        headers: {
          "Accept-Encoding": "identity",
          ...(range ? { Range: "bytes=0-0" } : {}),
        },
      });
    } catch {
      throw new Transient();
    }
    if (res.status === 404 || (range && res.status === 200)) {
      await res.body?.cancel().catch(() => undefined);
      throw new Transient();
    }
    if (res.status !== (range ? 206 : 200) || !res.body) throw Error();
    if (
      range &&
      res.headers.get("content-range") !== `bytes 0-0/${range.total}`
    ) {
      await res.body.cancel().catch(() => undefined);
      throw new Transient();
    }
    const hash = createHash("sha256");
    let bytes = 0;
    const reader = res.body.getReader();
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch {
        throw new Transient();
      }
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > size) throw Error();
      hash.update(chunk.value);
    }
    if (bytes < size) throw new Transient();
    if (
      hash.digest("hex") !==
      (range ? digest(Buffer.from([range.first])) : sha256)
    )
      throw Error();
  } finally {
    abort.abort();
    clearTimeout(timeout);
  }
}
/** Retries only the transient cases, with a bounded backoff; wrong bytes fail at once. */
async function readBack(
  get: typeof fetch,
  delays: readonly number[],
  url: string,
  size: number,
  sha256: string,
  range?: { total: number; first: number },
) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await readOnce(get, url, size, sha256, range);
    } catch (e) {
      const wait = delays[attempt];
      if (!(e instanceof Transient) || wait === undefined)
        throw new PublicationError("download");
      await pause(wait);
    }
  }
}

/**
 * The release objects already under `prefix`, or a refusal when the listing
 * holds anything else or cannot be read with certainty. Fails closed.
 */
function presentObjects(
  listed: {
    KeyCount?: unknown;
    IsTruncated?: unknown;
    Contents?: unknown;
  },
  prefix: string,
  names: readonly string[],
): Set<string> {
  if (![false, "false"].includes(listed.IsTruncated as never)) throw Error();
  const count = Number(listed.KeyCount);
  const contents =
    listed.Contents === undefined
      ? []
      : Array.isArray(listed.Contents)
        ? listed.Contents
        : [listed.Contents];
  if (!Number.isSafeInteger(count) || count !== contents.length) throw Error();
  const present = new Set<string>();
  for (const entry of contents) {
    const key = (entry as { Key?: unknown } | null)?.Key;
    const name = typeof key === "string" ? key.slice(prefix.length) : "";
    if (
      typeof key !== "string" ||
      !key.startsWith(prefix) ||
      !names.includes(name) ||
      present.has(name)
    )
      throw Error();
    present.add(name);
  }
  return present;
}

export function apkPublisher(
  dataDir: string,
  root = join(homedir(), ".config", "cardigan"),
  execute: Execute = run,
  get = fetch,
  delays: readonly number[] = READBACK_DELAYS,
): NonNullable<PublicationOptions["publishArtifact"]> {
  return async (project, a, request, claim, current) => {
    const t = await publicationTarget(root, project);
    const dir = await mkdtemp(join(dataDir, "publish-apk-"));
    let stage: PublicationError["category"] = "artifact";
    try {
      const filename = "app.apk",
        apk = join(dir, filename),
        first = await stageApk(dataDir, a, apk);
      stage = "signature";
      const certs = await execute(
        t.apksigner,
        ["verify", "--verbose", "--print-certs", apk],
        dir,
      );
      if (!signedOnlyBy(certs, t.test_certificate_sha256)) throw Error();
      stage = "manifest";
      for (const [field, value] of [
        ["application-id", t.package_name],
        ["version-name", request.version],
        ["version-code", String(request.versionCode)],
      ] as const) {
        if (
          (await execute(t.apkanalyzer, ["manifest", field, apk], dir)).replace(
            /\r?\n$/u,
            "",
          ) !== value
        )
          throw Error();
      }
      const prefix = t.prefix_template
        .replace("<version>", request.version)
        .replace("<sha12>", a.sha256.slice(0, 12));
      const base = `${t.origin}/${prefix}`,
        url = base + filename;
      const manifest = {
        package_name: t.package_name,
        version: request.version,
        versionCode: request.versionCode,
        url,
        size: a.size,
        sha256: a.sha256,
        certificate_sha256: t.test_certificate_sha256,
      };
      const release = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
      const sums = Buffer.from(
        `${a.sha256}  ${filename}\n${digest(release)}  release.json\n`,
      );
      await writeFile(join(dir, "release.json"), release, {
        flag: "wx",
        mode: 0o600,
      });
      await writeFile(join(dir, "SHA256SUMS"), sums, {
        flag: "wx",
        mode: 0o600,
      });
      current();
      const credentials = await ossEnvironment(root, t);
      const oss = ossApi(execute, t, dir, credentials);
      stage = "immutable_prefix";
      current();
      // OSS ignores forbid-overwrite on buckets with enabled/suspended versioning.
      if (
        !versioningOff(
          await oss("get-bucket-versioning", "--output-format", "raw"),
        )
      )
        throw Error();
      const listed = JSON.parse(
        await oss(
          "list-objects-v2",
          "--prefix",
          prefix,
          "--max-keys",
          "4",
          "--output-format",
          "json",
        ),
      );
      const names = [filename, "SHA256SUMS", "release.json"] as const;
      const existing = presentObjects(listed, prefix, names);
      // C-609: an empty prefix takes a fresh claim. A prefix holding only this
      // release's own objects is accepted solely to continue this decision's
      // interrupted claim (same URL and artifact); `claim` refuses otherwise.
      claim(url, existing.size > 0);
      // APK is the first conditional write for every contender. A partial
      // directory is never repaired by overwrite: an object already there is
      // only read back and must match this release byte for byte.
      const put = async (name: string) => {
        current();
        stage = "upload";
        if (existing.has(name)) return;
        await oss(
          "put-object",
          "--key",
          prefix + name,
          "--body",
          `file://${join(dir, name)}`,
          "--forbid-overwrite=true",
          "--content-type",
          name === filename
            ? "application/vnd.android.package-archive"
            : name === "release.json"
              ? "application/json"
              : "text/plain",
        );
      };
      await put(filename);
      await readBack(get, delays, url, a.size, a.sha256);
      await readBack(get, delays, url, 1, a.sha256, { total: a.size, first });
      for (const [name, body] of [
        ["SHA256SUMS", sums],
        ["release.json", release],
      ] as const) {
        await put(name);
        await readBack(get, delays, base + name, body.length, digest(body));
      }
      return { url, size: a.size, sha256: a.sha256 };
    } catch (e) {
      throw e instanceof PublicationError ? e : new PublicationError(stage);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}
