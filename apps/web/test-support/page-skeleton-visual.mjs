import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL("./", import.meta.url));
const approvals = resolve(here, "page-skeleton-approvals");
const output = resolve(here, "page-skeleton-snapshots");
export const scenes = [
  "board",
  "list",
  "grouped",
  "minimal",
  "detail",
  "filter",
  "capacity",
  "reference",
  "reference-filter",
  "reference-refresh",
  "reference-focus",
]
  .flatMap((mode) =>
    [1440, 390].flatMap((width) =>
      ["light", "dark"].map((theme) => `${mode}-${width}-${theme}.png`),
    ),
  )
  .sort();

const isHash = (hash) =>
  typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash);

// A receipt retires only the records that were present when its image was
// reviewed. Include the card and ancestry so that a revert (or another card
// producing identical pixels) is not mistaken for an earlier approval.
function approvalId(card, scene, hash, replaces) {
  return createHash("sha256")
    .update(JSON.stringify([card, scene, hash, replaces]))
    .digest("hex");
}

export function compare({ seed, ...cards }, actual) {
  assert.deepEqual(Object.keys(actual).sort(), scenes, "Incomplete capture");
  assert.deepEqual(Object.keys(seed ?? {}).sort(), scenes, "Incomplete seed");
  const history = new Map();
  for (const scene of scenes) {
    assert(
      isHash(seed[scene]) && isHash(actual[scene]),
      `Invalid PNG hash: ${scene}`,
    );
    const root = approvalId("seed", scene, seed[scene], []);
    history.set(scene, {
      records: new Map([[root, seed[scene]]]),
      retired: new Set(),
    });
  }
  for (const [card, receipt] of Object.entries(cards)) {
    assert(
      /^C-[1-9]\d*$/.test(card) &&
        receipt &&
        typeof receipt === "object" &&
        !Array.isArray(receipt),
      `Invalid receipt: ${card}`,
    );
    for (const [scene, entry] of Object.entries(receipt)) {
      const { hash, replaces } = entry ?? {};
      assert(
        history.has(scene) &&
          isHash(hash) &&
          Array.isArray(replaces) &&
          replaces.length > 0 &&
          replaces.every(isHash),
        `Invalid receipt: ${card}/${scene}`,
      );
      assert.deepEqual(
        replaces,
        [...new Set(replaces)].sort(),
        `Invalid parent list: ${card}/${scene}`,
      );
      const { records, retired } = history.get(scene);
      records.set(approvalId(card, scene, hash, replaces), hash);
      for (const parent of replaces) retired.add(parent);
    }
  }
  const changes = {};
  for (const [scene, { records, retired }] of history) {
    for (const id of retired)
      assert(records.has(id), `Missing parent approval: ${scene}`);
    const tips = [...records.keys()].filter((id) => !retired.has(id)).sort();
    assert(tips.length, `Missing active approval: ${scene}`);
    if (tips.some((id) => records.get(id) !== actual[scene]))
      changes[scene] = { hash: actual[scene], replaces: tips };
  }
  return changes;
}

async function capture(card) {
  const git = (...args) =>
    execFileSync("git", args, { cwd: here, encoding: "utf8" }).trim();
  assert(
    !git("ls-files", "--", "page-skeleton-snapshots"),
    "Generated screenshots must not be tracked",
  );
  await rm(output, { recursive: true, force: true });
  await mkdir(output);
  const pngs = {};
  for (const flags of [[], ["--reference"]])
    execFileSync(
      process.execPath,
      [resolve(here, "page-skeleton-screenshots.mjs"), ...flags],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          FONTCONFIG_FILE: resolve(here, "page-skeleton-fonts.conf"),
          TZ: "UTC",
          LANG: "C.UTF-8",
        },
      },
    );
  for (const scene of (await readdir(output))
    .filter((path) => path.endsWith(".png"))
    .sort())
    pngs[scene] = createHash("sha256")
      .update(await readFile(resolve(output, scene)))
      .digest("hex");
  await writeFile(
    resolve(output, "manifest.json"),
    `${JSON.stringify({ sha: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}"), dirty: !!git("status", "--porcelain"), pngs }, null, 2)}\n`,
  );
  const receipts = Object.create(null);
  for (const file of await readdir(approvals)) {
    assert(
      /^(?:seed|C-[1-9]\d*)\.json$/.test(file),
      `Unexpected approval file: ${file}`,
    );
    if (file === `${card}.json`) continue;
    receipts[file.slice(0, -5)] = JSON.parse(
      await readFile(resolve(approvals, file), "utf8"),
    );
  }
  const changes = compare(receipts, pngs);
  if (!card) {
    assert.deepEqual(
      Object.keys(changes),
      [],
      "Unreviewed or competing visual baseline. Inspect the rendered PNGs before recording a new receipt.",
    );
    console.log(`Verified ${scenes.length} PNGs against design approvals`);
  } else if (Object.keys(changes).length) {
    await writeFile(
      resolve(approvals, `${card}.json`),
      `${JSON.stringify(changes, null, 2)}\n`,
    );
  } else {
    // A reworked card may restore all original pixels.
    await rm(resolve(approvals, `${card}.json`), { force: true });
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  assert(
    !args.length ||
      (args.length === 2 &&
        args[0] === "--update" &&
        /^C-[1-9]\d*$/.test(args[1])),
    "Usage: test:ui-snapshots [--update C-N]",
  );
  await capture(args[1]);
}
