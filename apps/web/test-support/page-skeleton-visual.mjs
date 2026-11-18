import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
export const visualManifestPath = resolve(
  root,
  "test-support/page-skeleton-snapshots/manifest.json",
);
// A source change requires a visual run even when it happens to preserve pixels.
const sources = [
  "src/views/CardListPage.tsx",
  "src/components/Capacity.tsx",
  "src/components/CardsViewSwitch.tsx",
  "src/components/DisplayMenu.tsx",
  "src/components/FilterSelect.tsx",
  "src/components/PageSummary.tsx",
  "src/components/PageToolbar.tsx",
  "src/components/RefreshGroup.tsx",
  "src/components/FilterBar.tsx",
  "src/components/ViewSwitch.tsx",
  "src/components/layout/PageHeader.tsx",
  "src/components/layout/FilterBar.tsx",
  "src/components/layout/layout.css",
  "src/components/ui/theme.css",
  "src/components/ui/icons.tsx",
  "src/components/ui/button.tsx",
  "src/components/ui/select-control.tsx",
  "src/components/ui/select.tsx",
  "src/components/ui/toggle-group.tsx",
  "src/components/ui/input.tsx",
  "src/styles.css",
  "test-support/page-skeleton-fixture.tsx",
  "test-support/chromium.mjs",
  "test-support/style-reference-fixture.tsx",
  "test-support/page-skeleton-screenshots.mjs",
];
export async function visualManifest() {
  const directory = "test-support/page-skeleton-snapshots";
  const screenshots = (await readdir(resolve(root, directory)))
    .filter((name) => name.endsWith(".png") && !name.endsWith(".actual.png"))
    .map((name) => `${directory}/${name}`);
  const hashes = {};
  for (const path of [...sources, ...screenshots].sort())
    hashes[path] = createHash("sha256")
      .update(await readFile(resolve(root, path)))
      .digest("hex");
  return hashes;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const runner = resolve(root, "test-support/page-skeleton-screenshots.mjs");
  const update = process.argv.includes("--update") ? ["--update"] : [];
  for (const flags of [[], ["--reference"]])
    execFileSync(process.execPath, [runner, ...flags, ...update], {
      stdio: "inherit",
    });
  await writeFile(
    visualManifestPath,
    `${JSON.stringify(await visualManifest(), null, 2)}\n`,
  );
}
