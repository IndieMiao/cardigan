import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SharedFileActor } from "@cardigan/domain";
import { afterEach, beforeEach, expect, test } from "vitest";
import { SharedFileStore } from "./shared-files.js";
import { Store } from "./store.js";

let dataDir: string;
let store: Store;
let files: SharedFileStore;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cg-shared-files-"));
  store = Store.open({ dataDir });
  files = new SharedFileStore(store);
});
afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const agentA: SharedFileActor = {
  kind: "assignment",
  project_id: "alpha",
  assignment_id: "A-1",
  role_id: "coder",
};
const human: SharedFileActor = { kind: "human", member_id: "M-1" };

function upload(id: string, path: string, at: string, by = agentA) {
  files.beginVersion({
    id,
    path,
    object_key: `shared/${id}`,
    size: id.length,
    sha256: null,
    content_type: "video/mp4",
    created_at: at,
    created_by: by,
    expires_at: "2026-12-01T00:00:00Z",
  });
  return files.commitVersion(id, at);
}

test("C-685: commit creates directories; same path keeps every version; listing shows only committed files", () => {
  upload(
    "00000000-0000-4000-8000-000000000001",
    "art/raw/a.mp4",
    "2026-11-24T01:00:00Z",
  );
  const second = upload(
    "00000000-0000-4000-8000-000000000002",
    "art/raw/a.mp4",
    "2026-11-24T02:00:00Z",
    human,
  );
  expect(second.current.id).toBe("00000000-0000-4000-8000-000000000002");
  expect(second.version_count).toBe(2);
  // A pending upload never shows in the listing.
  files.beginVersion({
    id: "00000000-0000-4000-8000-000000000003",
    path: "art/raw/b.mp4",
    object_key: "shared/00000000-0000-4000-8000-000000000003",
    size: 1,
    sha256: null,
    content_type: "video/mp4",
    created_at: "2026-11-24T03:00:00Z",
    created_by: agentA,
    expires_at: "2026-12-01T00:00:00Z",
  });
  expect(files.listing("").dirs.map((d) => d.path)).toEqual(["art"]);
  expect(files.listing("art").dirs.map((d) => d.path)).toEqual(["art/raw"]);
  const raw = files.listing("art/raw");
  expect(raw.files.map((f) => f.name)).toEqual(["a.mp4"]);
  const history = files.versions("art/raw/a.mp4");
  expect(history.map((v) => [v.id.slice(-1), v.created_by.kind])).toEqual([
    ["2", "human"],
    ["1", "assignment"],
  ]);
  expect(history[1]?.created_by).toEqual(agentA);
  // Committing twice is a no-op.
  expect(
    files.commitVersion(
      "00000000-0000-4000-8000-000000000002",
      "2026-11-24T05:00:00Z",
    ).version_count,
  ).toBe(2);
});

test("C-685: a path is a directory or a file, never both; expired uploads are refused", () => {
  files.createDir("docs/x", human, "2026-11-24T00:00:00Z");
  expect(() =>
    upload(
      "00000000-0000-4000-8000-000000000004",
      "docs/x",
      "2026-11-24T01:00:00Z",
    ),
  ).toThrow(/已是目录/u);
  upload(
    "00000000-0000-4000-8000-000000000005",
    "docs/y",
    "2026-11-24T01:00:00Z",
  );
  expect(() =>
    files.createDir("docs/y/z", human, "2026-11-24T02:00:00Z"),
  ).toThrow(/已是文件/u);
  files.beginVersion({
    id: "00000000-0000-4000-8000-000000000006",
    path: "docs/late",
    object_key: "shared/00000000-0000-4000-8000-000000000006",
    size: 1,
    sha256: null,
    content_type: "text/plain",
    created_at: "2026-11-24T00:00:00Z",
    created_by: agentA,
    expires_at: "2026-11-24T00:10:00Z",
  });
  expect(() =>
    files.commitVersion(
      "00000000-0000-4000-8000-000000000006",
      "2026-11-24T00:11:00Z",
    ),
  ).toThrow(/过期/u);
  expect(() => files.listing("nope")).toThrow(/目录不存在/u);
});

test("C-685: removal marks rows, keeps history, matches the exact prefix only", () => {
  upload(
    "00000000-0000-4000-8000-000000000007",
    "Set/a.png",
    "2026-11-24T01:00:00Z",
  );
  upload(
    "00000000-0000-4000-8000-000000000008",
    "set/b.png",
    "2026-11-24T01:00:00Z",
  );
  upload(
    "00000000-0000-4000-8000-000000000009",
    "set2/c.png",
    "2026-11-24T01:00:00Z",
  );
  files.removeDir("set", human, "2026-11-24T02:00:00Z");
  expect(files.listing("").dirs.map((d) => d.path)).toEqual(["Set", "set2"]);
  expect(files.file("Set/a.png")).toBeDefined();
  expect(files.file("set/b.png")).toBeUndefined();
  files.removeFile("Set/a.png", human, "2026-11-24T03:00:00Z");
  expect(files.listing("Set").files).toEqual([]);
  expect(() =>
    files.removeFile("Set/a.png", human, "2026-11-24T04:00:00Z"),
  ).toThrow(/不存在/u);
  // The version row (and its object) stays for the record.
  expect(files.version("00000000-0000-4000-8000-000000000007")?.status).toBe(
    "committed",
  );
  // Writing the same path again starts a new file.
  const again = upload(
    "00000000-0000-4000-8000-000000000010",
    "Set/a.png",
    "2026-11-24T05:00:00Z",
  );
  expect(again.version_count).toBe(1);
  expect(() => files.removeDir("", human, "2026-11-24T05:00:00Z")).toThrow();
});
