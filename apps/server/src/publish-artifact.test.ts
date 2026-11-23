import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
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
import { apkPublisher, signedOnlyBy } from "./publish-artifact.js";

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
  credential_file: "publish/fixture/aliyun-config.json",
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
  await mkdir(join(root, "publish", "fixture"), {
    recursive: true,
    mode: 0o700,
  });
  const testId = randomUUID(),
    testKey = randomUUID();
  await writeFile(
    join(root, target.credential_file),
    JSON.stringify({
      profiles: [
        {
          name: target.profile,
          mode: "AK",
          region_id: target.region,
          access_key_id: testId,
          access_key_secret: testKey,
        },
      ],
    }),
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
  const execute = vi.fn(
    async (
      tool: string,
      args: string[],
      _cwd?: string,
      environment?: Record<string, string>,
    ) => {
      expect(args.join(" ")).not.toContain(testKey);
      if (tool === target.ossutil)
        expect(environment?.OSS_ACCESS_KEY_SECRET === testKey).toBe(true);
      else expect(environment).toBeUndefined();
      const arg = (name: string) => args[args.indexOf(name) + 1]!;
      if (tool === target.apksigner)
        return `Verifies\nVerified using v3 scheme (APK Signature Scheme v3): true\nNumber of signers: 1\nV3.0 Signer: certificate SHA-256 digest: ${flags.signer}\n`;
      if (tool === target.apkanalyzer)
        return `${({ "application-id": flags.manifest, "version-name": request.version, "version-code": "13" } as Record<string, string>)[args[1]!]}\n`;
      expect(arg("--config-file")).toBe("/dev/null");
      expect(arg("--mode")).toBe("AK");
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
    },
  );
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
      await chmod(join(f.root, target.credential_file), 0o644);
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

const head = (scheme: string) =>
  `Verifies\nVerified using v1 scheme (JAR signing): ${scheme.includes("1")}\nVerified using v2 scheme (APK Signature Scheme v2): ${scheme.includes("2")}\nVerified using v3 scheme (APK Signature Scheme v3): ${scheme.includes("3")}\n`;
const line = (name: string, digest = cert) =>
  `${name} certificate DN: CN=test\n${name} certificate SHA-256 digest: ${digest}\n${name} certificate SHA-1 digest: ${"c".repeat(40)}\n${name} public key SHA-256 digest: ${"d".repeat(64)}\n`;
test.each([
  ["v1/v2 only", `${head("12")}Number of signers: 1\n${line("Signer #1")}`],
  ["v3-only", `${head("3")}Number of signers: 1\n${line("V3.0 Signer:")}`],
  [
    "v3-only, CRLF and upper-case digest",
    `${head("3")}Number of signers: 1\n${line("V3.0 Signer:", cert.toUpperCase())}`.replaceAll(
      "\n",
      "\r\n",
    ),
  ],
  [
    "v2+v3",
    `${head("23")}Number of signers: 1\n${line("Signer #1")}${line("V3.0 Signer:")}`,
  ],
  [
    "v3+v3.1 with SDK ranges",
    `${head("3")}Number of signers: 1\n${line("V3.1 Signer (minSdkVersion=33, maxSdkVersion=2147483647)")}${line("V3 Signer (minSdkVersion=24, maxSdkVersion=32)")}`,
  ],
])("signature accepts the registered single signer: %s", (_, output) => {
  expect(signedOnlyBy(output, cert)).toBe(true);
});
test.each([
  [
    "multiple signers",
    `${head("2")}Number of signers: 2\n${line("Signer #1")}${line("Signer #2")}`,
  ],
  [
    "second signer without a count",
    `${head("2")}Number of signers: 1\n${line("Signer #1")}${line("Signer #2")}`,
  ],
  [
    "v3-only, wrong certificate",
    `${head("3")}Number of signers: 1\n${line("V3.0 Signer:", "0".repeat(64))}`,
  ],
  [
    "v2+v3 disagree",
    `${head("23")}Number of signers: 1\n${line("Signer #1")}${line("V3.0 Signer:", "0".repeat(64))}`,
  ],
  [
    "rotated v3.1 key",
    `${head("3")}Number of signers: 1\n${line("V3.1 Signer (minSdkVersion=33, maxSdkVersion=2147483647)", "0".repeat(64))}${line("V3 Signer (minSdkVersion=24, maxSdkVersion=32)")}`,
  ],
  [
    "unknown certificate line",
    `${head("3")}Number of signers: 1\n${line("V3.0 Signer:")}${line("Source Stamp Signer", "0".repeat(64))}`,
  ],
  ["not verified", `Number of signers: 1\n${line("V3.0 Signer:")}`],
  ["no signer count", `${head("3")}${line("V3.0 Signer:")}`],
  ["no certificate", `${head("3")}Number of signers: 1\n`],
])("signature refuses %s", (_, output) => {
  expect(signedOnlyBy(output, cert)).toBe(false);
});

test.each([
  "another-project",
  "multiple-profiles",
  "wrong-profile",
  "wrong-region",
])("refuses mismatched profile or credential path: %s", async (issue) => {
  const f = await setup();
  if (issue === "another-project")
    await writeFile(
      join(f.root, "publish-targets.json"),
      JSON.stringify({
        [project]: {
          ...target,
          credential_file: "publish/other/aliyun-config.json",
        },
      }),
    );
  else {
    const path = join(f.root, target.credential_file),
      registry = JSON.parse(await readFile(path, "utf8"));
    if (issue === "multiple-profiles")
      registry.profiles.push({ ...registry.profiles[0], name: "another" });
    if (issue === "wrong-profile") registry.profiles[0].name = "another";
    if (issue === "wrong-region") registry.profiles[0].region_id = "another";
    await writeFile(path, JSON.stringify(registry));
  }
  await expect(f.call()).rejects.toThrow("configuration");
  expect(f.execute.mock.calls.some(([tool]) => tool === target.ossutil)).toBe(
    false,
  );
  expect(f.claim).not.toHaveBeenCalled();
});

// Optional transport contract: a real ossutil 2.x binary, generated disposable profile, loopback-only fake OSS.
// No cloud account, real credentials, or external endpoint in this harness.
test.skipIf(!process.env.C585_TEST_OSSUTIL)(
  "real ossutil serializes the three conditional writes; no cloud contact",
  async () => {
    const f = await setup();
    const nonce = new Set<string>();
    const srv = createServer(async (req, res) => {
      if (!req.headers.authorization?.startsWith("OSS4-HMAC-SHA256 ")) {
        res.writeHead(403).end();
        return;
      }
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
        async (tool, args, cwd, environment) => {
          if (tool !== target.ossutil) return f.execute(tool, args);
          const safe = [...args, "--addressing-style", "path"];
          safe[safe.indexOf("--endpoint") + 1] =
            `http://127.0.0.1:${addr.port}`;
          return (
            await promisify(execFile)(process.env.C585_TEST_OSSUTIL!, safe, {
              cwd,
              env: { HOME: cwd, PATH: "/usr/bin:/bin", ...environment },
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
