// Run with Node: generate-standing-legacy.mjs <built checkout of 0531f0f^> <output.gz>
// Only old public CLI commands create the database. No SQL or repository writes.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const checkout = resolve(process.argv[2]),
  destination = resolve(process.argv[3]);
const { main, createProcessIo } = await import(
  pathToFileURL(join(checkout, "apps/cli/dist/index.js"))
);
const { Store, DEFAULT_DB_FILE } = await import(
  pathToFileURL(join(checkout, "packages/store/dist/index.js"))
);
const { loadCommandState } = await import(
  pathToFileURL(join(checkout, "packages/mcp-server/dist/index.js"))
);
const root = await mkdtemp(join(tmpdir(), "cardigan-standing-legacy-"));
try {
  const dataDir = join(root, "data"),
    role = join(root, "pm.json");
  const io = {
    ...createProcessIo(),
    cwd: root,
    env: { CARDIGAN_DATA_DIR: dataDir, CARDIGAN_PROJECT: "legacy" },
    stdout: () => {},
    stderr: () => {},
  };
  await writeFile(
    role,
    JSON.stringify({
      role_id: "pm",
      display_name: "PM",
      kind: "standing",
      core_prompt: "Legacy PM fixture",
      harness: "pi",
      launch_profile_ref: "fixture",
      allowed_tools: [
        "whoami",
        "get_card",
        "get_updates",
        "ack_events",
        "finish_run",
        "record_decision",
      ],
      worktree: "none",
    }),
  );
  for (const args of [
    ["project", "create", "legacy"],
    ["role", "add", "--file", role],
    ["pm", "create", "--office"],
    ["pm", "create", "--ops"],
    ["token", "issue", "A-2"],
  ]) {
    if (await main(args, io)) throw new Error(`Legacy CLI failed: ${args[0]}`);
  }
  const store = Store.open({ dataDir });
  const state = store.uow.read((tx) => loadCommandState(tx, "legacy"));
  if (
    state.assignments.length !== 2 ||
    state.assignments.some((a) => a.standing_mode !== undefined)
  )
    throw new Error("Expected two legacy PM Assignments without standing_mode");
  store.close();
  const bytes = await readFile(join(dataDir, DEFAULT_DB_FILE));
  if (
    bytes.includes(Buffer.from(root)) ||
    bytes.includes(Buffer.from(checkout))
  )
    throw new Error("Fixture contains temporary paths");
  await writeFile(destination, gzipSync(bytes));
} finally {
  await rm(root, { recursive: true, force: true });
}
