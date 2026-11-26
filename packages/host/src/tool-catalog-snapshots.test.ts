import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogSnapshot } from "@cardigan/mcp-server";
import { Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ToolCatalogKeeper } from "./tool-catalog-snapshots.js";

// C-797: the host keeps each served catalog's structure and lets a live
// session keep running only when its tools merely lack new optional params.

let dataDir: string, store: Store;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cardigan-catalog-keeper-"));
  store = Store.open({ dataDir });
});
afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const clock = { now: () => "2026-11-27T00:00:00.000Z" as never };
const listing = (properties: Record<string, unknown>, required: string[]) => [
  {
    name: "get_updates",
    inputSchema: { type: "object", properties, required },
  },
];
const v1 = catalogSnapshot(listing({ card_id: { type: "string" } }, []));
const optional = catalogSnapshot(
  listing({ card_id: { type: "string" }, limit: { type: "number" } }, []),
);
const required = catalogSnapshot(
  listing({ card_id: { type: "string" }, limit: { type: "number" } }, [
    "limit",
  ]),
);

test("a new process judges a session from the previous one by its stored structure", () => {
  expect(new ToolCatalogKeeper(store, clock).record(v1)).toBe(v1.fingerprint);
  const keeper = new ToolCatalogKeeper(store, clock);
  keeper.record(optional);
  keeper.record(required);
  expect(keeper.compatible(v1.fingerprint, optional.fingerprint)).toBe(true);
  expect(keeper.compatible(v1.fingerprint, required.fingerprint)).toBe(false);
  // Losing a parameter the session listed is never compatible.
  expect(keeper.compatible(optional.fingerprint, v1.fingerprint)).toBe(false);
});

test("launch suffixes must match exactly", () => {
  const keeper = new ToolCatalogKeeper(store, clock);
  keeper.record(v1);
  keeper.record(optional);
  const old = `${v1.fingerprint}+build-env-1`;
  expect(keeper.compatible(old, `${optional.fingerprint}+build-env-1`)).toBe(
    true,
  );
  expect(keeper.compatible(old, optional.fingerprint)).toBe(false);
  expect(
    keeper.compatible(old, `${optional.fingerprint}+build-env-1+files-2`),
  ).toBe(false);
});

test("an unknown, legacy or tampered fingerprint is incompatible", () => {
  const keeper = new ToolCatalogKeeper(store, clock);
  keeper.record(optional);
  expect(keeper.compatible(v1.fingerprint, optional.fingerprint)).toBe(false);
  expect(keeper.compatible("catalog-v1", optional.fingerprint)).toBe(false);
  expect(keeper.compatible(optional.fingerprint, "catalog-v2")).toBe(false);
  // A row rewritten to another structure no longer hashes to its key.
  const before = new ToolCatalogKeeper(store, clock);
  before.record(v1);
  before.record(required);
  store.database
    .prepare(
      "UPDATE tool_catalog_snapshots SET structure = (SELECT structure FROM tool_catalog_snapshots WHERE fingerprint = ?) WHERE fingerprint = ?",
    )
    .run(required.fingerprint, v1.fingerprint);
  const fresh = new ToolCatalogKeeper(store, clock);
  fresh.record(optional);
  expect(fresh.compatible(v1.fingerprint, optional.fingerprint)).toBe(false);
});

test("a marked parameter takes effect at once", () => {
  new ToolCatalogKeeper(store, clock).record(v1);
  const keeper = new ToolCatalogKeeper(store, clock, undefined, {
    get_updates: ["limit"],
  });
  keeper.record(optional);
  expect(keeper.compatible(v1.fingerprint, optional.fingerprint)).toBe(false);
});

test("a failed record is reported and never throws", () => {
  const onError = vi.fn();
  const keeper = new ToolCatalogKeeper(store, clock, onError);
  store.close();
  expect(keeper.record(v1)).toBe(v1.fingerprint);
  expect(onError).toHaveBeenCalledWith(
    expect.objectContaining({
      message: expect.stringContaining("not recorded"),
    }),
  );
  store = Store.open({ dataDir });
});
