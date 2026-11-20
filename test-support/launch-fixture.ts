import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Give role-writing fixtures their own offline profile names, never host settings. */
export function roleConfig(root: string, ...names: string[]) {
  const dir = join(root, "config");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "launch.yaml"),
    JSON.stringify({
      profiles: Object.fromEntries(
        names.map((name) => [name, { harness: "codex", model: "fixture" }]),
      ),
    }),
  );
  return dir;
}
