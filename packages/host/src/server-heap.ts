/**
 * C-785: the V8 old-space limit of both server processes (Web/MCP and
 * background), and of every worker thread they start (workers inherit the
 * process-wide V8 flag). The supervisor puts it into the one environment it
 * hands to both children, so the two can never diverge; it does not depend on
 * the systemd unit carrying `NODE_OPTIONS`. Node's own default (about 4 GiB
 * on a large host) is reached by the whole-history command state within
 * weeks; this is insurance, not the fix (see docs/plans/C-785.md).
 *
 * The limit is a `NODE_OPTIONS` entry, never an argv flag: the supervisor
 * proves a child's identity by `argv[1]` being the server script.
 */
export const DEFAULT_SERVER_HEAP_MB = 8192;
export const MIN_SERVER_HEAP_MB = 1024;
export const MAX_SERVER_HEAP_MB = 65536;
/** Host override in MiB; an invalid value keeps the default and warns. */
export const SERVER_HEAP_ENV = "CARDIGAN_SERVER_HEAP_MB";

export interface ServerHeap {
  /** The `NODE_OPTIONS` value both server processes start with. */
  readonly node_options: string;
  /** Old-space limit in MiB the servers run with. */
  readonly heap_mb: number;
  /**
   * `node_options`: the host's own `NODE_OPTIONS` already sets the limit and
   * is kept as is; `env`: `CARDIGAN_SERVER_HEAP_MB`; otherwise the default.
   */
  readonly source: "node_options" | "env" | "default";
  /** Set when `CARDIGAN_SERVER_HEAP_MB` was present but unusable. */
  readonly warning?: string;
}

const FLAG = /(?:^|\s)--max[-_]old[-_]space[-_]size(?:=|\s+)(\d+)(?=\s|$)/gu;

export function serverHeap(env: NodeJS.ProcessEnv): ServerHeap {
  const inherited = (env.NODE_OPTIONS ?? "").trim();
  // The last occurrence wins in Node, so report that one.
  const set = [...inherited.matchAll(FLAG)].at(-1)?.[1];
  if (set !== undefined)
    return {
      node_options: inherited,
      heap_mb: Number(set),
      source: "node_options",
    };
  const raw = env[SERVER_HEAP_ENV]?.trim();
  let heap = DEFAULT_SERVER_HEAP_MB;
  let source: ServerHeap["source"] = "default";
  let warning: string | undefined;
  if (raw) {
    const value = /^[0-9]+$/u.test(raw) ? Number(raw) : Number.NaN;
    if (
      Number.isSafeInteger(value) &&
      value >= MIN_SERVER_HEAP_MB &&
      value <= MAX_SERVER_HEAP_MB
    ) {
      heap = value;
      source = "env";
    } else
      warning = `${SERVER_HEAP_ENV} 必须是 ${MIN_SERVER_HEAP_MB}～${MAX_SERVER_HEAP_MB} 之间的整数（MiB），已改用默认 ${DEFAULT_SERVER_HEAP_MB}`;
  }
  return {
    node_options: [inherited, `--max-old-space-size=${heap}`]
      .filter(Boolean)
      .join(" "),
    heap_mb: heap,
    source,
    ...(warning ? { warning } : {}),
  };
}
