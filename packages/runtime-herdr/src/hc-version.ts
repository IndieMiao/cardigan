import { readFileSync } from "node:fs";

// The same relative path works from src and dist; installers and CI read this JSON too.
export const HC_RELEASE = Object.freeze(
  JSON.parse(
    readFileSync(
      new URL("../../../deploy/hc-version.json", import.meta.url),
      "utf8",
    ),
  ) as {
    version: string;
    minimum_version: string;
    maximum_tested: string;
    generation: number;
    targets: Record<string, { url: string; sha256: string }>;
  },
);

function stableVersion(value: unknown): number[] | undefined {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
  )
    return;
  const parts = value.split(".").map(Number);
  return parts.every(Number.isSafeInteger) ? parts : undefined;
}

/** Release installation stays pinned; runtime acceptance follows the protocol floor. */
export function isHcVersionCompatible(
  value: unknown,
  minimum = HC_RELEASE.minimum_version,
): boolean {
  const actual = stableVersion(value),
    floor = stableVersion(minimum);
  if (!actual || !floor) return false;
  for (let i = 0; i < 3; i++) {
    if (actual[i] !== floor[i]) return (actual[i] ?? -1) > (floor[i] ?? -1);
  }
  return true;
}

export function isHcCompatible(version: unknown, generation: unknown): boolean {
  return generation === HC_RELEASE.generation && isHcVersionCompatible(version);
}

const warnedVersions = new Set<string>();
/** Warn once per process/version, including CLI, remote and socket observations. */
export function warnIfHcUntested(version: unknown): void {
  if (
    typeof version !== "string" ||
    version === HC_RELEASE.maximum_tested ||
    !isHcVersionCompatible(version, HC_RELEASE.maximum_tested) ||
    warnedVersions.has(version)
  )
    return;
  warnedVersions.add(version);
  process.emitWarning(
    `hc ${version} exceeds maximum tested ${HC_RELEASE.maximum_tested}; accepting compatible protocol`,
    { code: "HC_UNTESTED_VERSION" },
  );
}
