import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Attachment } from "@cardigan/domain";
import { fileAttachmentStore } from "@cardigan/mcp-server";
import { afterEach, expect, test, vi } from "vitest";
import { apkPublisher } from "./publish-artifact.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const apk = Buffer.from("synthetic apk bytes"),
  sha = hash(apk),
  cert = "b".repeat(64),
  project = "fixture";
const target = {
  type: "aliyun-oss",
  credential_file: "oss.conf",
  profile: "fixture",
  bucket: "fixture-test",
  region: "us-west-1",
  origin: "https://download.example.invalid",
  prefix_template: "fixture/test/<version>-<sha12>/",
  package_name: "org.example.test",
  test_certificate_sha256: cert,
  ossutil: "/tools/ossutil",
  apksigner: "/tools/apksigner",
  apkanalyzer: "/tools/apkanalyzer",
};
const a = {
  kind: "evidence",
  id: "attachment-1",
  sha256: sha,
  size: apk.length,
} as Attachment;
const request = {
  attachment_id: a.id,
  decision_id: "Q-1",
  version: "1.0.1",
  versionCode: 13,
};
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "apk-publish-")));
  roots.push(root);
  await writeFile(
    join(root, "oss.conf"),
    "[profile fixture]\nmode=Anonymous\n",
    { mode: 0o600 },
  );
  await writeFile(
    join(root, "publish-targets.json"),
    JSON.stringify({ [project]: target }),
    { mode: 0o600 },
  );
  await fileAttachmentStore(root).put(sha, apk);
  const objects = new Map<string, Buffer>();
  const prefix = `fixture/test/1.0.1-${sha.slice(0, 12)}/`;
  const flags = {
    signer: cert,
    manifest: target.package_name,
    range: 206,
    badHash: false,
    versioned: false,
  };
  const execute = vi.fn(async (tool: string, args: string[]) => {
    const arg = (name: string) => args[args.indexOf(name) + 1]!;
    if (tool === target.apksigner)
      return `Signer #1 certificate SHA-256 digest: ${flags.signer}\n`;
    if (tool === target.apkanalyzer)
      return `${({ "application-id": flags.manifest, "version-name": request.version, "version-code": "13" } as Record<string, string>)[args[1]!]}\n`;
    expect(arg("--config-file")).toBe(join(root, "oss.conf"));
    expect(arg("--profile")).toBe(target.profile);
    switch (args[1]) {
      case "get-bucket-versioning":
        return flags.versioned
          ? "<VersioningConfiguration><Status>Suspended</Status></VersioningConfiguration>"
          : "<VersioningConfiguration/>\n0.123456(s) elapsed\n";
      case "list-objects-v2":
        expect(arg("--prefix")).toBe(prefix);
        return JSON.stringify({
          KeyCount: String(objects.size),
          IsTruncated: "false",
        });
      case "put-object": {
        const key = arg("--key");
        expect(args).toContain("--forbid-overwrite=true");
        if (objects.has(key)) throw Error("private details");
        objects.set(key, await readFile(arg("--body").slice(7)));
        return "";
      }
      default:
        throw Error();
    }
  });
  const get: typeof fetch = async (url, init) => {
    expect(init?.redirect).toBe("error");
    expect(init?.credentials).toBe("omit");
    const path = String(url).slice(target.origin.length + 1);
    const b = objects.get(path);
    if (!b) return new Response(null, { status: 404 });
    if (new Headers(init?.headers).has("range"))
      return new Response(new Uint8Array(b.subarray(0, 1)), {
        status: flags.range,
        headers: { "content-range": `bytes 0-0/${b.length}` },
      });
    return new Response(
      new Uint8Array(flags.badHash ? Buffer.alloc(b.length) : b),
    );
  };
  const claim = vi.fn(),
    current = vi.fn();
  const call = () =>
    apkPublisher(root, root, execute, get)(project, a, request, claim, current);
  return { root, objects, prefix, flags, execute, get, claim, current, call };
}

test("sealed test prefix, verified public bytes, Range and release sidecars", async () => {
  const f = await setup();
  await expect(f.call()).resolves.toEqual({
    url: `${target.origin}/${f.prefix}app.apk`,
    size: apk.length,
    sha256: sha,
  });
  expect(f.claim).toHaveBeenCalledOnce();
  expect(f.objects.get(`${f.prefix}SHA256SUMS`)?.toString()).toContain(
    `${sha}  app.apk`,
  );
  expect(
    JSON.parse(f.objects.get(`${f.prefix}release.json`)!.toString()),
  ).toMatchObject({ versionCode: 13, sha256: sha });
  await expect(f.call()).rejects.toThrow("immutable_prefix");
  expect(f.claim).toHaveBeenCalledOnce();
  expect(
    (await readdir(f.root)).filter((v) => v.startsWith("publish-apk-")),
  ).toEqual([]);
});
test.each([
  "configuration",
  "signature",
  "manifest",
  "immutable_prefix",
  "badHash",
  "range",
  "artifact",
] as const)("fails closed at %s", async (issue) => {
  const f = await setup();
  switch (issue) {
    case "configuration":
      await chmod(join(f.root, "oss.conf"), 0o644);
      break;
    case "signature":
      f.flags.signer = "0".repeat(64);
      break;
    case "manifest":
      f.flags.manifest = "wrong";
      break;
    case "immutable_prefix":
      f.flags.versioned = true;
      break;
    case "badHash":
      f.flags.badHash = true;
      break;
    case "range":
      f.flags.range = 200;
      break;
    case "artifact":
      await rm(join(f.root, "attachments"), { recursive: true });
      break;
  }
  const download = ["range", "badHash"].includes(issue);
  await expect(f.call()).rejects.toThrow(download ? "download" : issue);
  expect(f.objects.size).toBe(download ? 1 : 0);
  expect(f.claim).toHaveBeenCalledTimes(download ? 1 : 0);
});

// Optional transport contract: a real ossutil 2.x binary, anonymous profile, loopback-only fake OSS.
// No cloud account, real credentials, or external endpoint in this harness.
test.skipIf(!process.env.C585_TEST_OSSUTIL)(
  "real ossutil serializes the three conditional writes; no cloud contact",
  async () => {
    const f = await setup();
    const nonce = new Set<string>();
    const srv = createServer(async (req, res) => {
      const url = new URL(req.url!, "http://localhost");
      const key = url.pathname.slice(target.bucket.length + 2);
      if (req.method === "PUT") {
        if (
          req.headers["x-oss-forbid-overwrite"] !== "true" ||
          f.objects.has(key)
        ) {
          res.writeHead(409).end();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const b of req) chunks.push(b);
        f.objects.set(key, Buffer.concat(chunks));
        nonce.add(key);
        res.writeHead(200).end();
        return;
      }
      const body = url.searchParams.has("versioning")
        ? "<VersioningConfiguration/>"
        : `<ListBucketResult><Name>${target.bucket}</Name><Prefix>${f.prefix}</Prefix><MaxKeys>1</MaxKeys><IsTruncated>false</IsTruncated><KeyCount>${f.objects.size}</KeyCount></ListBucketResult>`;
      res.writeHead(200, { "content-type": "application/xml" }).end(body);
    });
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    try {
      const addr = srv.address();
      if (!addr || typeof addr === "string") throw Error();
      const publish = apkPublisher(
        f.root,
        f.root,
        async (tool, args, cwd) => {
          if (tool !== target.ossutil) return f.execute(tool, args);
          const safe = [
            ...args,
            "--addressing-style",
            "path",
            "--mode",
            "Anonymous",
          ];
          safe[safe.indexOf("--endpoint") + 1] =
            `http://127.0.0.1:${addr.port}`;
          return (
            await promisify(execFile)(process.env.C585_TEST_OSSUTIL!, safe, {
              cwd,
              env: { HOME: cwd, PATH: "/usr/bin:/bin" },
            })
          ).stdout;
        },
        f.get,
      );
      expect(
        await publish(project, a, request, f.claim, f.current),
      ).toMatchObject({ sha256: sha });
      expect(nonce.size).toBe(3);
      await expect(
        publish(project, a, request, f.claim, f.current),
      ).rejects.toThrow("immutable_prefix");
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  },
);
