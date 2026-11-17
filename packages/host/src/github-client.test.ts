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
import { Store } from "@cardigan/store";
import { afterEach, expect, test, vi } from "vitest";
import { GithubBudgetJournal } from "./github-budget-journal.js";
import { GithubClient, GithubNotFoundError } from "./github-client.js";
import { GithubRateLimit, GithubRetryLater } from "./github-rate-limit.js";

const roots: string[] = [];
const syntheticToken = (issued: number) =>
  `ghs_${"a".repeat(190)}.${"b".repeat(194)}${issued}`;

test("run 404 responses preserve a fixed error and consume the shared REST budget", async () => {
  const f = await setup(new GithubRateLimit(1));
  vi.spyOn(f.client, "token").mockResolvedValue(syntheticToken(1));
  f.fetcher.mockResolvedValue(
    new Response("private provider body", { status: 404 }),
  );
  await expect(f.client.run(123)).rejects.toBeInstanceOf(GithubNotFoundError);
  await expect(f.client.run(123)).rejects.toBeInstanceOf(GithubRetryLater);
  expect(f.fetcher).toHaveBeenCalledOnce();
});
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function setup(rate?: GithubRateLimit) {
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
          token: syntheticToken(++issued),
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
    ...(rate ? { rate } : {}),
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
    syntheticToken(1),
    syntheticToken(1),
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
  expect(JSON.parse(f.fetcher.mock.calls[0]![1]!.body as string)).toEqual({
    repositories: ["project"],
    permissions: {
      contents: "write",
      actions: "write",
      workflows: "write",
      metadata: "read",
    },
  });
  f.advance(3539_000);
  expect(syntheticToken(1)).toHaveLength(390);
  expect(await f.client.token()).toBe(syntheticToken(1));
  f.advance(1000);
  expect(await Promise.all([f.client.token(), f.client.token()])).toEqual([
    syntheticToken(2),
    syntheticToken(2),
  ]);
  expect(f.fetcher).toHaveBeenCalledTimes(2);
  expect(f.fetcher.mock.calls[1]?.[1]?.body).toBe(
    f.fetcher.mock.calls[0]?.[1]?.body,
  );
  f.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ id: 123 })));
  await f.client.run(123);
  expect(f.fetcher.mock.calls.at(-1)?.[1]?.headers).toMatchObject({
    Authorization: `Bearer ${syntheticToken(2)}`,
  });
  expect(await readdir(f.keys)).toEqual(["synthetic.pem"]);
  expect(await readFile(f.file, "utf8")).toBe(f.pem);
  expect(JSON.stringify(f.client)).not.toContain(syntheticToken(1));
  expect(JSON.stringify(f.client)).not.toContain(syntheticToken(2));
});
test.each([403, 422])(
  "workflow permission denial (%i) during refresh blocks dispatch without reusing the old token or dropping permissions",
  async (status) => {
    const f = await setup();
    await f.client.token();
    f.advance(3540_000);
    f.fetcher.mockResolvedValueOnce(
      new Response("private permission denial", {
        status,
        headers: { "Retry-After": "60" },
      }),
    );
    const error = await f.client.dispatch("main", {}).catch((error) => error);
    const category = status === 403 ? "api" : "auth";
    expect(error).toMatchObject({
      category,
      message: `Check executor unavailable: ${category}`,
    });
    expect(error).not.toHaveProperty("cause");
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    // Respect 403 backoff before retrying; a failed refresh must be retryable.
    f.advance(60_000);
    expect(await f.client.token()).toBe(syntheticToken(2));
    expect(f.fetcher).toHaveBeenCalledTimes(3);
    for (const [url, init] of f.fetcher.mock.calls) {
      expect(url).toBe(f.fetcher.mock.calls[0]?.[0]);
      expect(init?.body).toBe(f.fetcher.mock.calls[0]?.[1]?.body);
    }
  },
);
test("candidate tokens allow workflow updates only in the configured repository", async () => {
  const f = await setup();
  await f.client.token();
  expect(JSON.parse(String(f.fetcher.mock.calls[0]?.[1]?.body))).toEqual({
    repositories: ["project"],
    permissions: {
      actions: "write",
      contents: "write",
      workflows: "write",
      metadata: "read",
    },
  });
});
test.each([1, 2048])(
  "C-349: accepts an installation token of length %i without a prefix requirement",
  async (length) => {
    const f = await setup();
    const token = ".".repeat(length);
    f.fetcher.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          token,
          expires_at: "2026-11-15T01:00:00Z",
        }),
      ),
    );
    expect(await f.client.token()).toBe(token);
  },
);
test.each([
  ["empty", ""],
  ["oversized", "a".repeat(2049)],
  ...[
    " ",
    "\t",
    "\r",
    "\n",
    "\0",
    "\x1b",
    "\x7f",
    "+",
    "/",
    "=",
    ":",
    "é",
    "\u2028",
  ].map((character, index) => [
    `unsafe-${index}`,
    `${syntheticToken(1)}${character}`,
  ]),
])(
  "C-349: rejects %s installation tokens without leaking or caching them",
  async (_label, token) => {
    const f = await setup();
    f.fetcher.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          token,
          expires_at: "2026-11-15T01:00:00Z",
        }),
      ),
    );
    const error = await f.client.dispatch("main", {}).catch((error) => error);
    expect(error).toMatchObject({
      category: "auth",
      message: "Check executor unavailable: auth",
    });
    expect(error).not.toHaveProperty("cause");
    expect(f.fetcher).toHaveBeenCalledOnce();
    // The invalid response cannot poison the cache or strand the shared refresh.
    expect(await f.client.token()).toBe(syntheticToken(1));
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  },
);
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
    body: JSON.stringify({
      ref: "main",
      inputs: { attempt: "a" },
      return_run_details: true,
    }),
    headers: { Authorization: `Bearer ${syntheticToken(1)}` },
  });
  expect(String(f.fetcher.mock.calls.at(-1)![0])).not.toContain(
    syntheticToken(1),
  );
  f.fetcher.mockImplementation(
    async () => new Response(syntheticToken(1), { status: 403 }),
  );
  await expect(f.client.run(1)).rejects.toMatchObject({
    category: "api",
    message: "Check executor unavailable: api",
  });
  f.fetcher.mockRejectedValue(new Error(`${f.pem} ${syntheticToken(1)}`));
  await expect(
    f.client.runs("main", "2026-11-15T00:00:00Z"),
  ).rejects.toMatchObject({ category: "api" });
});

test.each([true, false])(
  "D3 rework: retrieves all 101 runs with a fixed window, Link present=%s",
  async (withLink) => {
    const f = await setup();
    vi.spyOn(f.client, "token").mockResolvedValue("ghs_synthetic");
    const visited: URL[] = [];
    f.fetcher.mockImplementation(async (input) => {
      const url = new URL(String(input));
      visited.push(url);
      const page = Number(url.searchParams.get("page"));
      const next = new URL(url);
      next.searchParams.set("page", "2");
      return new Response(
        JSON.stringify({
          total_count: 101,
          workflow_runs:
            page === 1
              ? Array.from({ length: 100 }, (_, i) => ({
                  id: i + 1,
                  created_at: "2026-11-15T00:00:00Z",
                }))
              : [{ id: 101, created_at: "2026-11-15T00:00:00Z" }],
        }),
        {
          headers:
            withLink && page === 1 ? { link: `<${next}>; rel="next"` } : {},
        },
      );
    });
    const runs = await f.client.runs("main", "2026-11-14T23:00:00Z");
    expect(runs.map((run) => run.id)).toEqual(
      Array.from({ length: 101 }, (_, i) => i + 1),
    );
    expect(visited.map((url) => url.searchParams.get("page"))).toEqual([
      "1",
      "2",
    ]);
    for (const url of visited) {
      expect(url.origin).toBe("https://api.github.com");
      expect(url.searchParams.get("created")).toBe(
        "2026-11-14T23:00:00.000Z..2026-11-15T00:00:00.000Z",
      );
      expect(url.searchParams.get("branch")).toBe("main");
      expect(url.searchParams.get("event")).toBe("workflow_dispatch");
    }
  },
);

test.each([
  "origin",
  "credentials",
  "path",
  "branch",
  "window",
  "skip",
  "repeat",
])(
  "D3 rework: refuses an unsafe pagination link (%s) before another credentialed request",
  async (change) => {
    const f = await setup();
    vi.spyOn(f.client, "token").mockResolvedValue("ghs_synthetic");
    f.fetcher.mockImplementation(async (input) => {
      const next = new URL(String(input));
      next.searchParams.set("page", "2");
      if (change === "origin") next.hostname = "untrusted.invalid";
      if (change === "credentials") next.username = "synthetic";
      if (change === "path") next.pathname = "/other";
      if (change === "branch") next.searchParams.set("branch", "other");
      if (change === "window") next.searchParams.set("created", ">=2020-01-01");
      if (change === "skip") next.searchParams.set("page", "3");
      if (change === "repeat") next.searchParams.set("page", "1");
      return new Response(
        JSON.stringify({
          total_count: 2,
          workflow_runs: [{ id: 1, created_at: "2026-11-15T00:00:00Z" }],
        }),
        { headers: { link: `<${next}>; rel="next"` } },
      );
    });
    await expect(
      f.client.runs("main", "2026-11-14T23:00:00Z"),
    ).rejects.toMatchObject({ category: "security" });
    expect(f.fetcher).toHaveBeenCalledOnce();
  },
);

test("D3 rework: an incomplete later page cannot yield a partial list", async () => {
  const f = await setup();
  vi.spyOn(f.client, "token").mockResolvedValue("ghs_synthetic");
  f.fetcher.mockImplementation(
    async (input) =>
      new Response(
        JSON.stringify({
          total_count: 2,
          workflow_runs:
            new URL(String(input)).searchParams.get("page") === "1"
              ? [{ id: 1, created_at: "2026-11-15T00:00:00Z" }]
              : [],
        }),
      ),
  );
  await expect(
    f.client.runs("main", "2026-11-14T23:00:00Z"),
  ).rejects.toMatchObject({ category: "recovery_incomplete" });
  expect(f.fetcher).toHaveBeenCalledTimes(2);
});

test.each(["stable", "identity", "count", "repeat"] as const)(
  "C-334: paged discovery deduplicates unordered stable IDs and rejects %s drift",
  async (mode) => {
    const f = await setup();
    vi.spyOn(f.client, "token").mockResolvedValue("ghs_synthetic");
    const item = (id: number) => ({
      id,
      created_at: "2026-11-15T00:00:00Z",
      run_attempt: 1,
    });
    f.fetcher.mockImplementation(async (input) => {
      const first = new URL(String(input)).searchParams.get("page") === "1";
      return new Response(
        JSON.stringify({
          total_count: !first && mode === "count" ? 103 : 102,
          workflow_runs: first
            ? Array.from({ length: 100 }, (_, i) => item(100 - i))
            : mode === "repeat"
              ? [item(100)]
              : [
                  item(102),
                  { ...item(100), run_attempt: mode === "identity" ? 2 : 1 },
                  item(101),
                ],
        }),
      );
    });
    const recovery = f.client.runs("main", "2026-11-14T23:00:00Z");
    if (mode === "stable") {
      const result = await recovery;
      expect(result).toHaveLength(102);
      expect(new Set(result.map((r) => r.id)).size).toBe(102);
    } else
      await expect(recovery).rejects.toMatchObject({
        category: mode === "identity" ? "security" : "recovery_incomplete",
      });
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  },
);

test.each([false, true])(
  "C-334: inclusive split boundaries deduplicate across windows; identity drift=%s fails closed",
  async (drift) => {
    const f = await setup();
    vi.spyOn(f.client, "token").mockResolvedValue("ghs_synthetic");
    const visited: string[] = [];
    const item = (id: number, second: string) => ({
      id,
      created_at: `2026-11-14T23:59:${second}Z`,
      run_attempt: 1,
    });
    f.fetcher.mockImplementation(async (input) => {
      const url = new URL(String(input));
      const page = Number(url.searchParams.get("page"));
      const window = url.searchParams.get("created")!;
      visited.push(window);
      const root =
        window.startsWith("2026-11-14T23:59:40.000Z") &&
        window.endsWith("00:00:00.000Z");
      const left = window.endsWith("23:59:50.000Z");
      const records = left
        ? [item(2, "50"), item(1, "40")]
        : [{ ...item(2, "50"), run_attempt: drift ? 2 : 1 }, item(3, "59")];
      return new Response(
        JSON.stringify({
          total_count: root ? 1000 : left ? 502 : 501,
          workflow_runs: root
            ? []
            : [
                ...records,
                ...Array.from({ length: left ? 500 : 499 }, (_, i) =>
                  item((left ? 100 : 1000) + i, left ? "49" : "51"),
                ),
              ].slice((page - 1) * 100, page * 100),
        }),
      );
    });
    const result = f.client.runs("main", "2026-11-14T23:59:40Z");
    if (drift)
      await expect(result).rejects.toMatchObject({ category: "security" });
    else {
      const runs = await result;
      expect(runs).toHaveLength(1002);
      expect(runs.filter((r) => r.id <= 3).map((r) => r.id)).toEqual([2, 1, 3]);
    }
    expect([...new Set(visited)]).toEqual([
      "2026-11-14T23:59:40.000Z..2026-11-15T00:00:00.000Z",
      "2026-11-14T23:59:40.000Z..2026-11-14T23:59:50.000Z",
      "2026-11-14T23:59:50.000Z..2026-11-15T00:00:00.000Z",
    ]);
  },
);

test.each([false, true])(
  "C-334: adjacent seconds split completely; parent count drift=%s fails closed",
  async (drift) => {
    const f = await setup();
    vi.spyOn(f.client, "token").mockResolvedValue("ghs_synthetic");
    const visited: string[] = [];
    f.fetcher.mockImplementation(async (input) => {
      const url = new URL(String(input));
      const page = Number(url.searchParams.get("page"));
      const window = url.searchParams.get("created")!;
      visited.push(window);
      const [from, to] = window.split("..");
      const last = from === "2026-11-15T00:00:00.000Z";
      const records = Array.from({ length: 500 }, (_, i) => ({
        id: (last ? 501 : 1) + i,
        created_at: from,
      }));
      return new Response(
        JSON.stringify({
          total_count: from !== to ? (drift ? 1001 : 1000) : 500,
          workflow_runs:
            from !== to ? [] : records.slice((page - 1) * 100, page * 100),
        }),
      );
    });
    const result = f.client.runs("main", "2026-11-14T23:59:59Z");
    if (drift)
      await expect(result).rejects.toMatchObject({
        category: "recovery_incomplete",
      });
    else expect(await result).toHaveLength(1000);
    expect([...new Set(visited)]).toEqual([
      "2026-11-14T23:59:59.000Z..2026-11-15T00:00:00.000Z",
      "2026-11-14T23:59:59.000Z..2026-11-14T23:59:59.000Z",
      "2026-11-15T00:00:00.000Z..2026-11-15T00:00:00.000Z",
    ]);
    f.fetcher.mockImplementation(
      async () =>
        new Response(JSON.stringify({ total_count: 1000, workflow_runs: [] })),
    );
    await expect(
      f.client.runs("main", "2026-11-15T00:00:00Z"),
    ).rejects.toMatchObject({ category: "recovery_incomplete" });
  },
);

test.each(["invalid", "2027-01-01T00:00:00Z"])(
  "C-334: rejects an invalid recovery interval %s before IO",
  async (since) => {
    const f = await setup();
    await expect(f.client.runs("main", since)).rejects.toMatchObject({
      category: "security",
    });
    expect(f.fetcher).not.toHaveBeenCalled();
  },
);

test("C-334: cancellation stops a split scan before another request and redacts its reason", async () => {
  const f = await setup();
  vi.spyOn(f.client, "token").mockResolvedValue("ghs_synthetic");
  const controller = new AbortController();
  f.fetcher.mockImplementation(async () => {
    controller.abort(new Error("ghs_synthetic private cancellation reason"));
    return new Response(
      JSON.stringify({ total_count: 1001, workflow_runs: [] }),
    );
  });
  await expect(
    f.client.runs("main", "2026-11-14T23:59:40Z", controller.signal),
  ).rejects.toMatchObject({
    category: "recovery_incomplete",
    message: "Check executor unavailable: recovery_incomplete",
  });
  expect(f.fetcher).toHaveBeenCalledOnce();
  expect(f.fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
});

test("D4: conditional list preserves ETag and 304; 429 Retry-After blocks details and cancellation too", async () => {
  const f = await setup();
  await f.client.token();
  f.fetcher.mockImplementationOnce(async (_url, init) => {
    expect(init?.headers).toMatchObject({ "If-None-Match": '"old"' });
    return new Response(null, { status: 304 });
  });
  expect(await f.client.pollRuns('"old"')).toEqual({ unchanged: true });
  f.fetcher.mockImplementationOnce(
    async () =>
      new Response("private response", {
        status: 429,
        headers: { "Retry-After": "60" },
      }),
  );
  await expect(f.client.pollRuns()).rejects.toMatchObject({
    category: "api",
    retryAt: expect.any(Number),
  });
  const calls = f.fetcher.mock.calls.length;
  await expect(f.client.jobs(1)).rejects.toMatchObject({ category: "api" });
  await expect(f.client.cancel(1)).rejects.toMatchObject({ category: "api" });
  expect(f.fetcher).toHaveBeenCalledTimes(calls);
  f.advance(60_000);
  f.fetcher.mockImplementationOnce(
    async () =>
      new Response(JSON.stringify({ workflow_runs: [] }), {
        headers: { ETag: '"new"' },
      }),
  );
  expect(await f.client.pollRuns()).toEqual({
    unchanged: false,
    runs: [],
    etag: '"new"',
  });
});

test("D4: signed job logs get no App credential; untrusted redirects and incomplete job pages fail closed", async () => {
  const f = await setup();
  await f.client.token();
  f.fetcher.mockImplementationOnce(
    async () =>
      new Response(null, {
        status: 302,
        headers: {
          location:
            "https://fixture.blob.core.windows.net/log?signature=synthetic",
        },
      }),
  );
  f.fetcher.mockImplementationOnce(async (_url, init) => {
    expect(init?.headers).toBeUndefined();
    expect(init?.redirect).toBe("error");
    return new Response("FAIL synthetic\n");
  });
  expect(await f.client.jobLog(11)).toBe("FAIL synthetic\n");
  f.fetcher.mockImplementationOnce(
    async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.invalid/log" },
      }),
  );
  await expect(f.client.jobLog(11)).rejects.toMatchObject({ category: "api" });
  f.fetcher.mockImplementationOnce(
    async () => new Response(JSON.stringify({ jobs: [], total_count: 2 })),
  );
  await expect(f.client.jobs(1)).rejects.toMatchObject({
    category: "security",
  });
});

test("D4: cancellation stops recovery before the next page without cancelling shared token refresh", async () => {
  const f = await setup();
  await f.client.token();
  const abort = new AbortController();
  f.fetcher.mockImplementationOnce(async () => {
    abort.abort();
    return new Response(
      JSON.stringify({ workflow_runs: [{ id: 1 }], total_count: 2 }),
    );
  });
  await expect(
    f.client.runs("main", "2026-11-15T00:00:00Z", abort.signal),
  ).rejects.toMatchObject({ category: "recovery_incomplete" });
  expect(f.fetcher).toHaveBeenCalledTimes(2);
  expect(await f.client.token()).toBe(syntheticToken(1));
});

test("D4: token exchange, dispatch and precise reads consume the same injected budget before fetch", async () => {
  const f = await setup(new GithubRateLimit(3));
  await f.client.token();
  f.fetcher.mockImplementationOnce(
    async () => new Response(null, { status: 204 }),
  );
  await f.client.dispatch("main", { sha: "a".repeat(40) });
  f.fetcher.mockImplementationOnce(
    async () => new Response(JSON.stringify({ id: 1 })),
  );
  await f.client.run(1);
  await expect(f.client.cancel(1)).rejects.toMatchObject({
    category: "api",
    retryAt: expect.any(Number),
  });
  expect(f.fetcher).toHaveBeenCalledTimes(3);
});

test("C-334 D4 integration: cancelling a window does not abort shared token refresh or refund its durable charge", async () => {
  const store = Store.open({ dbPath: ":memory:" });
  try {
    const journal = new GithubBudgetJournal(store, "github");
    const rate = new GithubRateLimit(
      2000,
      () => Date.parse("2026-11-15T00:00:00Z"),
      journal,
    );
    const f = await setup(rate);
    let release: (value: Response) => void = () => {
      throw new Error("uninitialized fixture");
    };
    const response = new Promise<Response>((resolve) => {
      release = resolve;
    });
    f.fetcher.mockImplementationOnce(async () => response);
    const abort = new AbortController();
    const recovery = f.client.runs(
      "main",
      "2026-11-14T23:59:40Z",
      abort.signal,
    );
    const sharedToken = f.client.token();
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
    abort.abort(new Error("ghs_synthetic private reason"));
    expect(f.fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    release(
      new Response(
        JSON.stringify({
          token: "ghs_shared_synthetic",
          expires_at: "2026-11-15T01:00:00Z",
        }),
      ),
    );
    expect(await sharedToken).toBe("ghs_shared_synthetic");
    await expect(recovery).rejects.toMatchObject({
      category: "recovery_incomplete",
    });
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(journal.update((state) => state.used)).toBe(1);
    f.fetcher.mockImplementationOnce(
      async () => new Response(JSON.stringify({ id: 123 })),
    );
    await f.client.run(123);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(journal.update((state) => state.used)).toBe(2);
    const audit = store.database.prepare("SELECT doc FROM global_events").all();
    expect(JSON.stringify(audit)).not.toContain("ghs_shared_synthetic");
  } finally {
    store.close();
  }
});

test.each([
  { workflow_run_id: 123 },
  { id: 123 },
  { workflow_run_id: 123, id: 456 },
])(
  "C-375: dispatch details return only the original run lookup id: %j",
  async (body) => {
    const f = await setup();
    await f.client.token();
    f.fetcher.mockImplementationOnce(
      async () => new Response(JSON.stringify(body)),
    );
    expect(await f.client.dispatch("main", { attempt: "a" })).toBe(123);
    expect(f.fetcher.mock.calls).toHaveLength(2); // One token exchange, one POST.
  },
);

test.each([0, -1, 1.5, "123", null])(
  "C-375: missing or malformed dispatch run id %s never causes another POST",
  async (workflow_run_id) => {
    const f = await setup();
    await f.client.token();
    f.fetcher.mockImplementationOnce(
      async () => new Response(JSON.stringify({ workflow_run_id })),
    );
    if (workflow_run_id === null) {
      // Absent details use the same conservative discovery path as a 204.
      expect(await f.client.dispatch("main", { attempt: "a" })).toBeUndefined();
    } else {
      await expect(
        f.client.dispatch("main", { attempt: "a" }),
      ).rejects.toMatchObject({ category: "security" });
    }
    expect(f.fetcher.mock.calls).toHaveLength(2);
  },
);
