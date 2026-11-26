import type { Clock } from "@cardigan/domain";
import {
  compareToolCatalogs,
  IMMEDIATE_TOOL_PARAMETERS,
  type ToolCatalogSnapshot,
} from "@cardigan/mcp-server";
import {
  readToolCatalogSnapshot,
  recordToolCatalogSnapshot,
  type Store,
} from "@cardigan/store";

/** A C-786 catalog hash: the part of a session fingerprint before any `+` suffix. */
const CATALOG_HASH = /^[0-9a-f]{64}/;
const MAX_VERDICTS = 1024;

/**
 * C-797: keeps the tool structure behind every catalog fingerprint this
 * process hands out, and decides whether a live session that recorded an
 * older fingerprint may keep running. Only "a tool gained optional
 * parameters that are not marked immediate" keeps it; every other difference,
 * a different launch suffix (`+…`), or a structure that is missing or
 * unreadable replaces the session. Failures never block a delivery: a lost
 * record only means a later restart.
 */
export class ToolCatalogKeeper {
  readonly #recorded = new Map<string, string>();
  readonly #verdicts = new Map<string, boolean>();

  constructor(
    private readonly store: Store,
    private readonly clock: Clock,
    private readonly onError?: (error: Error) => void,
    private readonly immediate: Parameters<
      typeof compareToolCatalogs
    >[2] = IMMEDIATE_TOOL_PARAMETERS,
  ) {}

  /** Keep `snapshot` once per process; later calls only return its fingerprint. */
  record(snapshot: ToolCatalogSnapshot): string {
    if (!this.#recorded.has(snapshot.fingerprint)) {
      try {
        recordToolCatalogSnapshot(
          this.store,
          snapshot.fingerprint,
          snapshot.structure,
          this.clock.now(),
        );
        this.#recorded.set(snapshot.fingerprint, snapshot.structure);
      } catch (error) {
        this.onError?.(
          new Error(
            `tool catalog snapshot not recorded: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    }
    return snapshot.fingerprint;
  }

  /**
   * Whether a session that recorded `previous` may keep running under a deploy
   * whose fingerprint for the same Assignment is `current`.
   */
  compatible(previous: string, current: string): boolean {
    if (previous === current) return true;
    const key = `${previous}\n${current}`;
    const cached = this.#verdicts.get(key);
    if (cached !== undefined) return cached;
    let verdict = false;
    try {
      verdict = this.#judge(previous, current);
    } catch (error) {
      this.onError?.(
        new Error(
          `tool catalog comparison failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      return false;
    }
    if (this.#verdicts.size >= MAX_VERDICTS) this.#verdicts.clear();
    this.#verdicts.set(key, verdict);
    return verdict;
  }

  #judge(previous: string, current: string): boolean {
    const before = CATALOG_HASH.exec(previous)?.[0];
    const after = CATALOG_HASH.exec(current)?.[0];
    if (!before || !after) return false;
    // Launch suffixes (verifier environment, session files) must match exactly.
    if (previous.slice(before.length) !== current.slice(after.length))
      return false;
    const old = this.#structure(before);
    const now = this.#structure(after);
    if (old === undefined || now === undefined) return false;
    return compareToolCatalogs(old, now, this.immediate).compatible;
  }

  #structure(fingerprint: string): string | undefined {
    return (
      this.#recorded.get(fingerprint) ??
      readToolCatalogSnapshot(this.store, fingerprint)
    );
  }
}
