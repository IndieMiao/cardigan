import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { CpuProfileDirectory } from "./cpu-profile-files.js";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
});
const roots: string[] = [];
afterEach(() => {
  vi.mocked(writeFileSync).mockClear();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test("ENOSPC after a partial write cleans only its exclusive temporary inode", () => {
  const root = mkdtempSync(join(tmpdir(), "cpu-enospc-"));
  roots.push(root);
  const directory = new CpuProfileDirectory(root);
  try {
    writeFileSync(join(root, "old.cpuprofile"), "old-evidence", {
      mode: 0o600,
    });
    vi.mocked(writeFileSync).mockImplementationOnce((fd) => {
      writeSync(fd as number, "partial-data");
      throw Object.assign(new Error("synthetic-private-path"), {
        code: "ENOSPC",
      });
    });
    expect(() =>
      directory.publish("new.cpuprofile", Buffer.from("complete")),
    ).toThrow();
    expect(readdirSync(root)).toEqual(["old.cpuprofile"]);
    expect(readFileSync(join(root, "old.cpuprofile"), "utf8")).toBe(
      "old-evidence",
    );
    directory.publish("new.cpuprofile", Buffer.from("complete"));
    expect(readFileSync(join(root, "new.cpuprofile"), "utf8")).toBe("complete");
  } finally {
    directory.close();
  }
});
