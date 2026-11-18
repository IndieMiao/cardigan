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

// Each card writes its own sparse receipt. Compare generations per scene, not
// card numbers or timestamps: an older, long-running card may merge last.
export function compare(receipts, actual) {
  assert.deepEqual(Object.keys(actual).sort(), scenes, "Incomplete capture");
  const tips = new Map();
  for (const receipt of receipts) {
    for (const [scene, value] of Object.entries(receipt)) {
      assert(
        scenes.includes(scene) && Array.isArray(value) && value.length === 2,
        `Invalid receipt: ${scene}`,
      );
      const [generation, hash] = value;
      assert(
        Number.isSafeInteger(generation) &&
          generation >= 0 &&
          typeof hash === "string" &&
          /^[a-f0-9]{64}$/.test(hash),
        `Invalid receipt: ${scene}`,
      );
      if (!tips.has(scene) || generation > tips.get(scene).generation)
        tips.set(scene, { generation, hashes: new Set([hash]) });
      else if (generation === tips.get(scene).generation)
        tips.get(scene).hashes.add(hash);
    }
  }
  const changes = {};
  for (const scene of scenes) {
    const tip = tips.get(scene);
    assert(tip, `Missing approval: ${scene}`);
    if (tip.hashes.size !== 1 || !tip.hashes.has(actual[scene]))
      changes[scene] = [tip.generation + 1, actual[scene]];
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
  const receipts = [];
  for (const file of await readdir(approvals)) {
    if (file === `${card}.json`) continue;
    receipts.push(JSON.parse(await readFile(resolve(approvals, file), "utf8")));
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
