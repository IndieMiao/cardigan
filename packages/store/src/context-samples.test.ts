import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContextObservation } from "@cardigan/domain";
import { expect, test } from "vitest";
import { readContextSamples, writeContextSamples } from "./context-samples.js";
import { Store } from "./store.js";

test("completed samples cross connections atomically, clear missing observations and survive restart", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cg-context-samples-"));
  const writer = Store.open({ dataDir });
  let reader = Store.open({ dataDir });
  const sample: ContextObservation = {
    assignment_id: "A-1",
    runtime_key: "null",
    source: "fixture",
    agent: "codex",
    session_id: "fixture",
    transcript_path: null,
    cwd: "/fixture",
    model: null,
    context_tokens: 100,
    context_window_size: 1000,
    used_percentage: 10,
    updated_at: "2026-01-01T00:00:00Z",
  };
  try {
    expect(readContextSamples(reader, "fixture")).toEqual([]);
    writeContextSamples(writer, "fixture", [sample]);
    expect(readContextSamples(reader, "fixture")).toEqual([sample]);
    expect(readContextSamples(reader, "other")).toEqual([]);
    reader.close();
    reader = Store.open({ dataDir });
    expect(readContextSamples(reader, "fixture")).toEqual([sample]);
    writer.database.exec("BEGIN IMMEDIATE");
    writer.database.prepare("UPDATE context_samples SET doc = '[]'").run();
    expect(readContextSamples(reader, "fixture")).toEqual([sample]);
    writer.database.exec("ROLLBACK");
    expect(readContextSamples(reader, "fixture")).toEqual([sample]);
    writeContextSamples(writer, "fixture", []);
    expect(readContextSamples(reader, "fixture")).toEqual([]);
  } finally {
    reader.close();
    writer.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
