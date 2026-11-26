import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { Store } from "./store.js";
import {
  readToolCatalogSnapshot,
  recordToolCatalogSnapshot,
  TOOL_CATALOG_SNAPSHOT_RETENTION_MS,
} from "./tool-catalog-snapshots.js";

// C-797: the structure behind a tool catalog fingerprint, kept so a later
// deploy can judge whether a live session's tools are still compatible.

let dataDir: string, store: Store;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cardigan-catalog-snapshots-"));
  store = Store.open({ dataDir });
});
afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const structure = (n: number) =>
  JSON.stringify({ revision: 1, tools: [{ name: `tool_${n}` }] });
const fingerprint = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const at = (ms: number) => new Date(Date.UTC(2026, 10, 1) + ms).toISOString();

test("a recorded structure reads back by its fingerprint", () => {
  const text = structure(1);
  recordToolCatalogSnapshot(store, fingerprint(text), text, at(0));
  recordToolCatalogSnapshot(store, fingerprint(text), text, at(1));
  expect(readToolCatalogSnapshot(store, fingerprint(text))).toBe(text);
  expect(readToolCatalogSnapshot(store, fingerprint(structure(2)))).toBe(
    undefined,
  );
});

test("a structure that does not hash to its fingerprint is refused", () => {
  expect(() =>
    recordToolCatalogSnapshot(
      store,
      fingerprint(structure(1)),
      structure(2),
      at(0),
    ),
  ).toThrow(/fingerprint/);
  expect(readToolCatalogSnapshot(store, fingerprint(structure(1)))).toBe(
    undefined,
  );
});

test("a stored row that no longer matches its fingerprint reads as missing", () => {
  const text = structure(1);
  recordToolCatalogSnapshot(store, fingerprint(text), text, at(0));
  store.database
    .prepare("UPDATE tool_catalog_snapshots SET structure = ?")
    .run(Buffer.from("not gzip"));
  expect(readToolCatalogSnapshot(store, fingerprint(text))).toBe(undefined);
});

test("snapshots not refreshed within the retention are pruned on the next record", () => {
  const old = structure(1);
  const kept = structure(2);
  recordToolCatalogSnapshot(store, fingerprint(old), old, at(0));
  recordToolCatalogSnapshot(store, fingerprint(kept), kept, at(0));
  // Refreshing keeps a snapshot alive.
  recordToolCatalogSnapshot(
    store,
    fingerprint(kept),
    kept,
    at(TOOL_CATALOG_SNAPSHOT_RETENTION_MS),
  );
  const fresh = structure(3);
  recordToolCatalogSnapshot(
    store,
    fingerprint(fresh),
    fresh,
    at(TOOL_CATALOG_SNAPSHOT_RETENTION_MS + 1),
  );
  expect(readToolCatalogSnapshot(store, fingerprint(old))).toBe(undefined);
  expect(readToolCatalogSnapshot(store, fingerprint(kept))).toBe(kept);
  expect(readToolCatalogSnapshot(store, fingerprint(fresh))).toBe(fresh);
});
