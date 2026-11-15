import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Store } from "./store.js";
import {
  beginUpstreamProbeSample,
  cancelUpstreamProbeSample,
  readUpstreamProbeSample,
  writeUpstreamProbeSample,
} from "./upstream-probe-samples.js";

test("publication ownership crosses connections, rejects stale completion/cancellation, and survives rollback/reopen", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cg-probe-ownership-"));
  const writer = Store.open({ dataDir });
  let reader = Store.open({ dataDir });
  const sample = {
    provider: "fixture",
    group: "fixture",
    status: "reachable" as const,
    checked_at: "2026-01-01T00:00:00Z",
  };
  const read = () =>
    readUpstreamProbeSample(reader, "fixture", "configuration");
  try {
    writeUpstreamProbeSample(writer, "configuration", sample);
    expect(
      beginUpstreamProbeSample(
        writer,
        "configuration",
        "fixture",
        "fixture",
        "first",
      ),
    ).toBe(false);
    expect(read()?.publication_id).toBe("first");
    expect(
      beginUpstreamProbeSample(
        writer,
        "configuration",
        "fixture",
        "fixture",
        "second",
      ),
    ).toBe(true);
    cancelUpstreamProbeSample(writer, "configuration", "fixture", "first");
    expect(() =>
      writeUpstreamProbeSample(writer, "configuration", sample, "first"),
    ).toThrow("no longer owned");
    expect(read()?.publication_id).toBe("second");
    const failed = {
      ...sample,
      status: "unreachable" as const,
      last_failure_at: sample.checked_at,
      failure: "connection_error" as const,
    };
    writeUpstreamProbeSample(writer, "configuration", failed, "second");
    expect(read()).toEqual(failed);
    beginUpstreamProbeSample(
      writer,
      "configuration",
      "fixture",
      "fixture",
      "third",
    );
    expect(() =>
      writer.uow.run(() => {
        cancelUpstreamProbeSample(writer, "configuration", "fixture", "third");
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(read()?.publication_id).toBe("third");
    reader.close();
    reader = Store.open({ dataDir });
    expect(read()?.publication_id).toBe("third");
    cancelUpstreamProbeSample(writer, "configuration", "fixture", "third");
    expect(read()).toEqual(failed);
    expect(writer.migrate()).toEqual([]);
  } finally {
    reader.close();
    writer.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
