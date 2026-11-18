import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import {
  visualManifest,
  visualManifestPath,
} from "../../test-support/page-skeleton-visual.mjs";

test("shared skeleton changes and screenshot updates require a matching visual baseline", async () => {
  const recorded = JSON.parse(await readFile(visualManifestPath, "utf8"));
  expect(
    await visualManifest(),
    "Run pnpm --filter @cardigan/web test:ui-snapshots with the documented Chromium; review pixel differences before --update",
  ).toEqual(recorded);
  expect(
    Object.keys(recorded).filter((path) => path.endsWith(".png")),
  ).toHaveLength(44);
});
