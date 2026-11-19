import { createHmac, randomBytes } from "node:crypto";
import {
  type LaunchConfig,
  requiredSecretKeys,
  resolveProfile,
} from "@cardigan/roles";
import type { Store } from "@cardigan/store";

/** Unused databases (including exportable synthetic fixtures) need no private key. */
function comparisonKey(store: Store) {
  const select = store.database.prepare(
    "SELECT key FROM launch_comparison_key WHERE singleton=1",
  );
  let row = select.get();
  if (!row) {
    // Two host processes can start together. Keep the first committed key and read the winner.
    store.database
      .prepare(
        "INSERT INTO launch_comparison_key(singleton,key) VALUES (1,?) ON CONFLICT(singleton) DO NOTHING",
      )
      .run(randomBytes(32));
    row = select.get();
  }
  if (!(row?.key instanceof Uint8Array) || row.key.length !== 32)
    throw new Error("启动配置指纹不可用");
  return row.key;
}

/** Stable across server restarts and mapping reordering. Ignore unrelated profiles/secrets. */
export function launchFingerprint(
  store: Store,
  launch: { config: LaunchConfig; secrets: Readonly<Record<string, string>> },
  ref: string,
  browserCapable = false,
) {
  const resolved = resolveProfile(launch.config, ref);
  const secrets = Object.fromEntries(
    requiredSecretKeys(launch.config, ref).map((key) => [
      key,
      launch.secrets[key],
    ]),
  );
  const { upstream: _monitor, ...provider } =
    resolved.provider?.definition ?? {};
  // Codex config entries are emitted as successive -c arguments; preserve their order.
  const { config, ...profile } = resolved.profile;
  const input = [
    ref,
    profile,
    Object.entries(config ?? {}),
    provider,
    secrets,
    browserCapable ? launch.config.browser : undefined,
  ];
  const canonical = JSON.stringify(input, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, value[k]]),
        )
      : value,
  );
  return createHmac("sha256", comparisonKey(store))
    .update(canonical)
    .digest("hex");
}
