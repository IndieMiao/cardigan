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
    /** CDN fill race: answer this many reads per URL with 404 / ignored Range / bad Content-Range / cut stream. */
    missing: 0,
    rangeIgnored: 0,
    wrongContentRange: 0,
    cut: 0,
  };
  const reads = new Map<string, number>();
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
          expect(arg("--max-keys")).toBe("4");
          {
            const listed = [...objects]
              .filter(([k]) => k.startsWith(prefix))
              .map(([Key, b]) => ({ Key, Size: String(b.length) }));
            const page = listed.slice(0, 4);
            return JSON.stringify({
              KeyCount: String(page.length),
              IsTruncated: String(listed.length > 4),
              ...(page.length
                ? { Contents: page.length === 1 ? page[0] : page }
                : {}),
            });
          }
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
    const ranged = new Headers(init?.headers).has("range");
    const n = (reads.get(`${ranged}${path}`) ?? 0) + 1;
    reads.set(`${ranged}${path}`, n);
    const b = objects.get(path);
    if (!b || n <= flags.missing) return new Response(null, { status: 404 });
    if (n <= flags.cut)
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(b.subarray(0, 1)));
            c.error(Error("reset"));
          },
        }),
      );
    if (ranged && n <= flags.rangeIgnored)
      return new Response(new Uint8Array(b));
    if (ranged)
      return new Response(new Uint8Array(b.subarray(0, 1)), {
        status: flags.range,
        headers: {
          "content-range": `bytes 0-0/${n <= flags.wrongContentRange ? b.length + 1 : b.length}`,
        },
      });
    return new Response(
      new Uint8Array(flags.badHash ? Buffer.alloc(b.length) : b),
    );
  };
  const claim = vi.fn(),
    current = vi.fn();
  const delays = [0, 0, 0, 0];
  const call = () =>
    apkPublisher(root, root, execute, get, delays)(
      project,
      a,
      request,
      claim,
      current,
    );
  return {
    root,
    objects,
    prefix,
    flags,
    reads,
    execute,
    get,
    claim,
    current,
    call,
  };
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
  expect(f.claim).toHaveBeenLastCalledWith(
    `${target.origin}/${f.prefix}app.apk`,
    false,
  );
  expect(
    (await readdir(f.root)).filter((v) => v.startsWith("publish-apk-")),
  ).toEqual([]);
});
test.each([
  ["404 until the CDN fills", "missing", 4],
  ["Range answered with a full 200", "rangeIgnored", 4],
  ["wrong Content-Range", "wrongContentRange", 4],
  ["connection cut mid-body", "cut", 4],
] as const)("read-back retries a %s, bounded", async (_, flag, limit) => {
  const ok = await setup();
  ok.flags[flag] = limit;
  await expect(ok.call()).resolves.toMatchObject({ sha256: sha });
  expect(ok.objects.size).toBe(3);
  const fail = await setup();
  fail.flags[flag] = limit + 1;
  await expect(fail.call()).rejects.toThrow("download");
  expect(fail.objects.size).toBe(1);
  expect(Math.max(...fail.reads.values())).toBe(limit + 1);
});
test("wrong bytes are not retried", async () => {
  const f = await setup();
  f.flags.badHash = true;
  await expect(f.call()).rejects.toThrow("download");
  expect(f.reads.get(`false${f.prefix}app.apk`)).toBe(1);
});
test("after a post-write read-back failure, a new approval resumes the lone APK and writes the sidecars", async () => {
  const f = await setup();
  f.flags.missing = 99;
  await expect(f.call()).rejects.toThrow("download");
  expect([...f.objects.keys()]).toEqual([`${f.prefix}app.apk`]);
  expect(f.claim).toHaveBeenLastCalledWith(
    `${target.origin}/${f.prefix}app.apk`,
    false,
  );
  f.flags.missing = 0;
  f.reads.clear();
  const puts = () =>
    f.execute.mock.calls.filter(([, args]) => args[1] === "put-object").length;
  const before = puts();
  await expect(f.call()).resolves.toMatchObject({ sha256: sha });
  expect(f.claim).toHaveBeenLastCalledWith(
    `${target.origin}/${f.prefix}app.apk`,
    true,
  );
  expect(puts() - before).toBe(2);
  expect(f.objects.size).toBe(3);
});
test("C-612: resumes from this release's own manifests, writing only the gaps", async () => {
  const f = await setup();
  await expect(f.call()).resolves.toMatchObject({ sha256: sha });
  const puts = () =>
    f.execute.mock.calls.filter(([, args]) => args[1] === "put-object").length;
  // SHA256SUMS written, its read-back failed: release.json never written.
  const release = f.objects.get(`${f.prefix}release.json`);
  expect(release).toBeDefined();
  f.objects.delete(`${f.prefix}release.json`);
  let before = puts();
  await expect(f.call()).resolves.toMatchObject({ sha256: sha });
  expect(f.claim).toHaveBeenLastCalledWith(
    `${target.origin}/${f.prefix}app.apk`,
    true,
  );
  expect(puts() - before).toBe(1);
  expect(f.objects.get(`${f.prefix}release.json`)).toEqual(release);
  // Everything written, the final receipt lost: verify only, write nothing.
  before = puts();
  await expect(f.call()).resolves.toMatchObject({ sha256: sha });
  expect(puts()).toBe(before);
});
test.each([
  "a manifest with other bytes of the same size",
  "a manifest without the APK",
  "a stranger next to them",
] as const)(
  "C-612: resume still refuses %s and never overwrites",
  async (issue) => {
    const f = await setup();
    await expect(f.call()).resolves.toMatchObject({ sha256: sha });
    const sums = `${f.prefix}SHA256SUMS`;
    if (issue === "a manifest with other bytes of the same size")
      f.objects.set(sums, Buffer.alloc(f.objects.get(sums)?.length ?? 0, 0x61));
    if (issue === "a manifest without the APK")
      f.objects.delete(`${f.prefix}app.apk`);
    if (issue === "a stranger next to them")
      f.objects.set(`${f.prefix}notes.txt`, Buffer.from("x"));
    const kept = new Map(f.objects);
    const before = f.execute.mock.calls.filter(
      ([, args]) => args[1] === "put-object",
    ).length;
    await expect(f.call()).rejects.toThrow(
      issue === "a manifest with other bytes of the same size"
        ? "download"
        : "immutable_prefix",
    );
    expect(
      f.execute.mock.calls.filter(([, args]) => args[1] === "put-object")
        .length,
    ).toBe(before);
    expect(f.objects).toEqual(kept);
  },
);
test.each([
  "different size",
  "same size, different bytes",
  "another object",
  "claim refused",
] as const)("resume refuses: %s", async (issue) => {
  const f = await setup();
  const key = `${f.prefix}app.apk`;
  f.objects.set(
    key,
    issue === "different size"
      ? Buffer.concat([apk, Buffer.from("x")])
      : issue === "same size, different bytes"
        ? Buffer.alloc(apk.length)
        : apk,
  );
  if (issue === "another object") f.objects.set(`${f.prefix}SHA256SUMS`, apk);
  if (issue === "claim refused")
    f.claim.mockImplementation(() => {
      throw Error("immutable_prefix");
    });
  const failure =
    issue === "same size, different bytes" ? "download" : "immutable_prefix";
  await expect(f.call()).rejects.toThrow(failure);
  expect(
    f.execute.mock.calls.some(([, args]) => args[1] === "put-object"),
  ).toBe(false);
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

// Verbatim `apksigner verify --verbose --print-certs` stdout from Android SDK Build Tools
// 37.0.0 (apksigner 0.9) on disposable test keys, recorded in review evidence attachment-8965.
const real = "39bf69c178a6e7dac6876b53ed69e341dcd9bb63cb7b6d0cdf29ac3071027f4f";
const verified = (schemes: string) =>
  [
    "Verifies",
    ...[
      "v1 scheme (JAR signing)",
      "v2 scheme (APK Signature Scheme v2)",
      "v3 scheme (APK Signature Scheme v3)",
      "v3.1 scheme (APK Signature Scheme v3.1)",
      "v3.2 scheme (APK Signature Scheme v3.2)",
    ].map(
      (name, i) =>
        `Verified using ${name}: ${schemes.split(",").includes(["1", "2", "3", "3.1", "3.2"][i]!)}`,
    ),
    "Number of signers: 1",
  ].join("\n");
const apksigner37 = {
  v1: `${verified("1")}\nV1 Signer: certificate SHA-256 digest: ${real}\n`,
  v2: `${verified("2")}\nV2 Signer: certificate SHA-256 digest: ${real}\n`,
  v3: `${verified("3")}\nV3.0 Signer: certificate SHA-256 digest: ${real}\n`,
  "v2+v3": `${verified("2,3")}\nV3.0 Signer: certificate SHA-256 digest: ${real}\n`,
  "v3.1 rotation": `${verified("2,3,3.1")}\nV3.1 Signer: (minSdkVersion=33, maxSdkVersion=2147483647) certificate SHA-256 digest: ac5d9b5eea035317d6352d949dfbdddd760d6d10048b7d53a6f509dfc048cf4a\nV3.0 Signer: (minSdkVersion=24, maxSdkVersion=32) certificate SHA-256 digest: 16930e5b8c757beb8a1f8bf27f5c7bd197deac3dbab18c090645c84ceac97f21\n`,
};
test("the recorded verbose output matches attachment-8965", () => {
  expect(apksigner37.v1).toBe(
    `Verifies\nVerified using v1 scheme (JAR signing): true\nVerified using v2 scheme (APK Signature Scheme v2): false\nVerified using v3 scheme (APK Signature Scheme v3): false\nVerified using v3.1 scheme (APK Signature Scheme v3.1): false\nVerified using v3.2 scheme (APK Signature Scheme v3.2): false\nNumber of signers: 1\nV1 Signer: certificate SHA-256 digest: ${real}\n`,
  );
});
test.each(["v1", "v2", "v3", "v2+v3"] as const)(
  "Build Tools 37 %s with the registered certificate passes",
  (scheme) => {
    expect(signedOnlyBy(apksigner37[scheme], real)).toBe(true);
    expect(signedOnlyBy(apksigner37[scheme], cert)).toBe(false);
    expect(
      signedOnlyBy(
        apksigner37[scheme]
          .replaceAll("\n", "\r\n")
          .replace(real, real.toUpperCase()),
        real,
      ),
    ).toBe(true);
  },
);
test("Build Tools 37 v3.1 labels parse, but a rotated second certificate is refused", () => {
  const rotation = apksigner37["v3.1 rotation"];
  for (const digest of [
    "ac5d9b5eea035317d6352d949dfbdddd760d6d10048b7d53a6f509dfc048cf4a",
    "16930e5b8c757beb8a1f8bf27f5c7bd197deac3dbab18c090645c84ceac97f21",
  ])
    expect(signedOnlyBy(rotation, digest)).toBe(false);
  const single = rotation.replace(/digest: [a-f0-9]{64}/gu, `digest: ${real}`);
  expect(signedOnlyBy(single, real)).toBe(true);
});
// Same certificate for SDK 28–32 and 33+, verbatim excerpts from independent review
// evidence attachment-8967 (Build Tools 36.1.0 and 37.0.0).
const targeted =
  "ad707196e1a70d68523e7e9d10f2fdc7b5b67c672e998605ad13726f967925fb";
const sdkTargeted = {
  "36.1.0": `Verifies\nVerified using v3 scheme (APK Signature Scheme v3): true\nVerified using v3.1 scheme (APK Signature Scheme v3.1): true\nNumber of signers: 1\nSigner (minSdkVersion=33, maxSdkVersion=2147483647) certificate SHA-256 digest: ${targeted}\nSigner (minSdkVersion=28, maxSdkVersion=32) certificate SHA-256 digest: ${targeted}\n`,
  "37.0.0": `Verifies\nVerified using v3 scheme (APK Signature Scheme v3): true\nVerified using v3.1 scheme (APK Signature Scheme v3.1): true\nVerified using v3.2 scheme (APK Signature Scheme v3.2): false\nNumber of signers: 1\nV3.1 Signer: (minSdkVersion=33, maxSdkVersion=2147483647) certificate SHA-256 digest: ${targeted}\nV3.0 Signer: (minSdkVersion=28, maxSdkVersion=32) certificate SHA-256 digest: ${targeted}\n`,
};
test.each(["36.1.0", "37.0.0"] as const)(
  "Build Tools %s v3.1 with one certificate for both SDK ranges passes",
  (version) => {
    const output = sdkTargeted[version];
    expect(signedOnlyBy(output, targeted)).toBe(true);
    expect(signedOnlyBy(output, cert)).toBe(false);
    // One range rotated to another certificate is still refused.
    const rotated = output.replace(
      `maxSdkVersion=32) certificate SHA-256 digest: ${targeted}`,
      `maxSdkVersion=32) certificate SHA-256 digest: ${"0".repeat(64)}`,
    );
    expect(rotated).not.toBe(output);
    expect(signedOnlyBy(rotated, targeted)).toBe(false);
  },
);
const legacy = (signers: string[], count = signers.length) =>
  `Verifies\nVerified using v1 scheme (JAR signing): true\nVerified using v2 scheme (APK Signature Scheme v2): true\nNumber of signers: ${count}\n${signers.map((d, i) => `Signer #${i + 1} certificate DN: CN=test\nSigner #${i + 1} certificate SHA-256 digest: ${d}\nSigner #${i + 1} certificate SHA-1 digest: ${"c".repeat(40)}\n`).join("")}`;
test("older apksigner `Signer #1` output still passes", () => {
  expect(signedOnlyBy(legacy([cert]), cert)).toBe(true);
});
test.each([
  ["multiple signers", legacy([cert, cert])],
  ["a second signer under a count of one", legacy([cert, cert], 1)],
  ["a wrong certificate", legacy(["0".repeat(64)])],
  [
    "v2 and v3 disagreeing",
    apksigner37["v2+v3"].replace(
      "Number of signers: 1\n",
      `Number of signers: 1\nV2 Signer: certificate SHA-256 digest: ${"0".repeat(64)}\n`,
    ),
  ],
  [
    "an unrecognised certificate line",
    `${apksigner37.v3}Source Stamp Signer certificate SHA-256 digest: ${real}\n`,
  ],
  [
    "a label without the colon",
    apksigner37.v3.replace("V3.0 Signer:", "V3.0 Signer"),
  ],
  ["a missing Verifies line", apksigner37.v3.replace("Verifies\n", "")],
  [
    "a missing signer count",
    apksigner37.v3.replace("Number of signers: 1\n", ""),
  ],
  ["no certificate line", apksigner37.v3.replace(/V3\.0 Signer: .*\n/u, "")],
])("signature refuses %s", (_, output) => {
  expect(signedOnlyBy(output, output.includes(real) ? real : cert)).toBe(false);
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
