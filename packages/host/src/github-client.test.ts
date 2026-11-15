import { generateKeyPairSync, verify } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { GithubClient } from "./github-client.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "cg-github-auth-"));
  roots.push(root);
  await chmod(root, 0o700);
  const keys = join(root, "keys");
  await mkdir(keys, { mode: 0o700 });
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const file = join(keys, "synthetic.pem");
  await writeFile(file, pem, { mode: 0o600 });
  let now = Date.parse("2026-11-15T00:00:00Z");
  let issued = 0;
  const jwt: string[] = [];
  const fetcher = vi.fn(
    async (_url: string | URL | Request, init?: RequestInit) => {
      jwt.push(
        (init!.headers as Record<string, string>).Authorization!.slice(7),
      );
      return new Response(
        JSON.stringify({
          token: `ghs_synthetic_${++issued}`,
          expires_at: new Date(now + 3600_000).toISOString(),
        }),
      );
    },
  );
  const client = new GithubClient({
    config: {
      name: "github",
      type: "github",
      repo: "fixture/project",
      workflow: ".github/workflows/check.yml",
      appId: 1,
      installationId: 2,
      privateKeyFile: file,
      botLogin: "fixture[bot]",
      maxConcurrent: 1,
    },
    dataDir: root,
    fetch: fetcher as typeof fetch,
    now: () => now,
  });
  return {
    root,
    keys,
    file,
    pem,
    publicKey,
    jwt,
    fetcher,
    client,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
test("D3: App RS256 JWT exchanges for a memory-only token; concurrent refresh is coalesced and happens before expiry", async () => {
  const f = await setup();
  expect(await Promise.all([f.client.token(), f.client.token()])).toEqual([
    "ghs_synthetic_1",
    "ghs_synthetic_1",
  ]);
  expect(f.fetcher).toHaveBeenCalledOnce();
  const parts = f.jwt[0]!.split(".");
  expect(JSON.parse(Buffer.from(parts[0]!, "base64url").toString())).toEqual({
    alg: "RS256",
    typ: "JWT",
  });
  expect(
    JSON.parse(Buffer.from(parts[1]!, "base64url").toString()),
  ).toMatchObject({ iss: "1" });
  expect(
    verify(
      "RSA-SHA256",
      Buffer.from(`${parts[0]}.${parts[1]}`),
      f.publicKey,
      Buffer.from(parts[2]!, "base64url"),
    ),
  ).toBe(true);
  expect(f.fetcher.mock.calls[0]![0]).toBe(
    "https://api.github.com/app/installations/2/access_tokens",
  );
  expect(f.fetcher.mock.calls[0]![1]).toMatchObject({
    redirect: "error",
    method: "POST",
  });
  expect(JSON.parse(f.fetcher.mock.calls[0]![1]!.body as string)).toMatchObject(
    {
      repositories: ["project"],
      permissions: { contents: "write", actions: "write", metadata: "read" },
    },
  );
  f.advance(3539_000);
  expect(await f.client.token()).toBe("ghs_synthetic_1");
  f.advance(1000);
  expect(await f.client.token()).toBe("ghs_synthetic_2");
  expect(f.fetcher).toHaveBeenCalledTimes(2);
  expect(await readdir(f.keys)).toEqual(["synthetic.pem"]);
  expect(await readFile(f.file, "utf8")).toBe(f.pem);
  expect(JSON.stringify(f.client)).not.toContain("ghs_synthetic");
});
test("D3: key and network failures return fixed categories, without PEM/JWT/token or response text", async () => {
  const f = await setup();
  f.fetcher.mockRejectedValue(new Error(`${f.pem} JWT ghs_synthetic`));
  await expect(f.client.token()).rejects.toMatchObject({
    message: "Check executor unavailable: auth",
    category: "auth",
  });
  await chmod(f.file, 0o644);
  await expect(f.client.token()).rejects.toMatchObject({ category: "auth" });
  expect(f.fetcher).toHaveBeenCalledOnce();
});
test("D3: REST dispatch uses baseline ref, rejects redirect/body errors and sanitizes transport errors", async () => {
  const f = await setup();
  await f.client.token();
  f.fetcher.mockImplementation(async () => new Response(null, { status: 204 }));
  expect(await f.client.dispatch("main", { attempt: "a" })).toBeUndefined();
  expect(f.fetcher.mock.calls.at(-1)?.[0]).toBe(
    "https://api.github.com/repos/fixture/project/actions/workflows/check.yml/dispatches",
  );
  expect(f.fetcher.mock.calls.at(-1)![1]).toMatchObject({
    method: "POST",
    redirect: "error",
    body: JSON.stringify({ ref: "main", inputs: { attempt: "a" } }),
  });
  f.fetcher.mockImplementation(
    async () => new Response("ghs_synthetic secret", { status: 403 }),
  );
  await expect(f.client.run(1)).rejects.toMatchObject({
    category: "api",
    message: "Check executor unavailable: api",
  });
  f.fetcher.mockRejectedValue(new Error(f.pem));
  await expect(
    f.client.runs("main", "2026-11-15T00:00:00Z"),
  ).rejects.toMatchObject({ category: "api" });
});
