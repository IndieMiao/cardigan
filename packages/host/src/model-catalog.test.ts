import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  loadModelLaunchConfig,
  parseCachedLaunchConfig,
} from "./model-catalog.js";

const fixture = {
  native: {
    env: ["not-metadata"],
    models: {
      v1: {
        limit: { context: 8000, output: 500 },
        reasoning_options: [{ type: "effort", values: ["low", "high"] }],
        extra: "not-metadata",
      },
    },
  },
  other: { models: { v1: { limit: { context: 1000, output: 100 } } } },
};
const config = {
  providers: {
    relay: { harness: "codex", secret_env: { RELAY_KEY: "private-ref" } },
  },
  models: {
    active: { id: "v1", provider: "relay", catalog_provider: "native" },
  },
  profiles: { coder: { harness: "codex", model: "active" } },
};
const now = () => new Date("2026-01-01T00:00:00Z");
const stale = () => new Date("2026-01-03T00:00:00Z");
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "model-catalog-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("fetches only the public catalog, caches a dated projection, and reuses it offline", async () => {
  const fetch = vi.fn(async () => Response.json(fixture));
  const online = await loadModelLaunchConfig(config, dir, { now, fetch });
  expect(fetch).toHaveBeenCalledWith("https://models.dev/api.json", {
    signal: expect.any(AbortSignal),
    redirect: "error",
    credentials: "omit",
  });
  expect(online.models?.active).toMatchObject({
    context_window: 8000,
    max_output_tokens: 500,
    reasoning_efforts: ["low", "high"],
  });
  const cache = join(dir, "models-dev.json");
  const text = await readFile(cache, "utf8");
  expect(JSON.parse(text).fetched_at).toBe(now().toISOString());
  expect(text).not.toMatch(/not-metadata|private-ref|RELAY_KEY|active/);
  expect((await stat(cache)).mode & 0o777).toBe(0o600);
  const offline = vi.fn(async () => {
    throw new Error("offline");
  });
  await expect(
    loadModelLaunchConfig(config, dir, { now, fetch: offline }),
  ).resolves.toEqual(online);
  expect(offline).not.toHaveBeenCalled();
  await expect(
    loadModelLaunchConfig(config, dir, { now: stale, fetch: offline }),
  ).resolves.toEqual(online);
  expect(offline).toHaveBeenCalledOnce();
  for (const bad of [
    new Response("invalid"),
    Response.json({ error: "bad catalog" }),
    new Response(null, { status: 503 }),
  ]) {
    await expect(
      loadModelLaunchConfig(config, dir, {
        now: stale,
        fetch: async () => bad,
      }),
    ).resolves.toEqual(online);
  }
  const limited = await loadModelLaunchConfig(
    { ...config, model_catalog: { max_bytes: 1 } },
    dir,
    { now: stale, fetch: async () => Response.json(fixture) },
  );
  expect(limited.models).toEqual(online.models);
  expect(await readFile(cache, "utf8")).toBe(text);
  expect(parseCachedLaunchConfig(config, dir)).toEqual(online);
});

test("local fields win independently; cold/offline relay models need their own window", async () => {
  const active = {
    ...config.models.active,
    context_window: 12000,
    reasoning_efforts: ["low"],
  };
  const local = { ...config, models: { active } };
  const loaded = await loadModelLaunchConfig(local, dir, {
    fetch: async () => Response.json(fixture),
  });
  expect(loaded.models?.active).toMatchObject({
    context_window: 12000,
    max_output_tokens: 500,
    reasoning_efforts: ["low"],
  });
  // A model from another upstream must not supply a relay's window by name alone.
  expect(() =>
    parseCachedLaunchConfig(
      { ...config, models: { active: { id: "v1", provider: "relay" } } },
      dir,
    ),
  ).toThrow();
  await writeFile(join(dir, "models-dev.json"), "broken cache");
  const fetch = vi.fn(async () => new Response(null, { status: 503 }));
  await expect(
    loadModelLaunchConfig(config, dir, { fetch }),
  ).rejects.toMatchObject({
    details: [expect.stringContaining("models.active.context_window")],
  });
  expect(
    (await loadModelLaunchConfig(local, dir, { fetch })).models?.active,
  ).toMatchObject(active);
});

test("legacy profiles need neither a model catalog nor a network request", async () => {
  const fetch = vi.fn();
  await loadModelLaunchConfig(
    { profiles: { p: { harness: "pi", model: "raw-id" } } },
    dir,
    { fetch },
  );
  expect(fetch).not.toHaveBeenCalled();
});

test("partial metadata complements local fields and enforces known effort", async () => {
  const local = {
    ...config,
    models: { active: { ...config.models.active, context_window: 12345 } },
  };
  for (const context of [undefined, 0]) {
    const fetch = async () =>
      Response.json({
        native: {
          models: {
            v1: {
              limit: { context, output: 1500 },
              reasoning_options: [{ type: "effort", values: ["low", "high"] }],
            },
          },
        },
      });
    expect(
      (await loadModelLaunchConfig(local, dir, { fetch })).models?.active,
    ).toMatchObject({
      context_window: 12345,
      max_output_tokens: 1500,
      reasoning_efforts: ["low", "high"],
    });
    expect(() =>
      parseCachedLaunchConfig(
        {
          ...local,
          profiles: { coder: { ...config.profiles.coder, effort: "other" } },
        },
        dir,
      ),
    ).toThrow();
  }
});

test("damaged fields recover only from the same row, preserving the good offline cache", async () => {
  const cache = join(dir, "models-dev.json");
  const good = await loadModelLaunchConfig(config, dir, {
    now,
    fetch: async () => Response.json(fixture),
  });
  const saved = await readFile(cache, "utf8");
  for (const v1 of [
    { limit: { context: 0, output: 501 } },
    {
      limit: { context: 8000, output: 501 },
      reasoning_options: [{ type: "effort", values: [] }],
    },
  ]) {
    const result = await loadModelLaunchConfig(config, dir, {
      now: stale,
      fetch: async () =>
        Response.json({
          native: { models: { v1, v2: { limit: { context: 9000 } } } },
        }),
    });
    expect(result.models?.active).toMatchObject({
      context_window: 8000,
      max_output_tokens: 501,
    });
    expect(await readFile(cache, "utf8")).toBe(saved);
    expect(parseCachedLaunchConfig(config, dir)).toEqual(good);
    expect(
      await loadModelLaunchConfig(config, dir, {
        now: stale,
        fetch: async () => new Response(null, { status: 503 }),
      }),
    ).toEqual(good);
  }
  // A healthy response without the model is not a transient damaged row.
  await expect(
    loadModelLaunchConfig(config, dir, {
      now: stale,
      fetch: async () =>
        Response.json({
          native: { models: { v2: { limit: { context: 9000 } } } },
        }),
    }),
  ).rejects.toMatchObject({
    details: [expect.stringContaining("models.active.context_window")],
  });
  expect(await readFile(cache, "utf8")).toBe(saved);
});

test("enforces exact cache bytes independently on projection, publication and both read paths", async () => {
  const online = async () => Response.json(fixture);
  const good = await loadModelLaunchConfig(config, dir, { now, fetch: online });
  const cache = join(dir, "models-dev.json");
  const saved = await readFile(cache, "utf8");
  const localized = {
    ...config,
    models: { active: { ...config.models.active, context_window: 321 } },
  };
  const bounded = (cache_max_bytes: number) => ({
    ...localized,
    model_catalog: { cache_max_bytes },
  });
  const exact = Buffer.byteLength(saved);
  await rm(cache);
  await loadModelLaunchConfig(bounded(exact), dir, { now, fetch: online });
  expect(await readFile(cache, "utf8")).toBe(saved);
  expect(
    parseCachedLaunchConfig(bounded(exact), dir).models?.active
      .max_output_tokens,
  ).toBe(500);
  const expanded = {
    ...fixture,
    ["中".repeat(20)]: {
      models: Object.fromEntries(
        Array.from({ length: 5 }, (_, i) => [i, { limit: { context: 1 } }]),
      ),
    },
  };
  await loadModelLaunchConfig(bounded(exact), dir, {
    now: stale,
    fetch: async () => Response.json(expanded),
  });
  expect(await readFile(cache, "utf8")).toBe(saved);
  expect(parseCachedLaunchConfig(config, dir)).toEqual(good);
  const offline = vi.fn(async () => new Response(null, { status: 503 }));
  for (const result of [
    parseCachedLaunchConfig(bounded(exact - 1), dir),
    await loadModelLaunchConfig(bounded(exact - 1), dir, {
      now,
      fetch: offline,
    }),
  ]) {
    expect(result.models?.active.context_window).toBe(321);
    expect(result.models?.active.max_output_tokens).toBeUndefined();
  }
  expect(offline).toHaveBeenCalledOnce();
  await rm(cache);
  await loadModelLaunchConfig(bounded(exact - 1), dir, { now, fetch: online });
  await expect(stat(cache)).rejects.toMatchObject({ code: "ENOENT" });
});
