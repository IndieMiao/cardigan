/**
 * C-600: some harness HTTP clients (Codex) read the macOS system proxy but not
 * its exception list, so a Card MCP request to a tailnet address goes to the
 * local proxy and fails. Every launch therefore names the Card MCP host in
 * NO_PROXY/no_proxy: the clients that honour system proxies also honour these
 * variables, while the model API keeps using whatever proxy is configured.
 *
 * Clients disagree on which spelling wins (curl and Python prefer lower case,
 * reqwest upper case), so each spelling keeps its own entries; a spelling that
 * was unset takes the other one's entries, so adding the Card host never
 * shadows an existing exception. A list that already bypasses everything
 * (`*`) is left exactly as it was.
 */
export const MCP_PROXY_BYPASS_KEYS = ["NO_PROXY", "no_proxy"] as const;

/** Host of the Card MCP URL as NO_PROXY spells it (no port, no brackets). */
export function mcpProxyBypassHost(url: string): string | undefined {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  host = host.replace(/^\[(.*)\]$/u, "$1");
  return host && !/[\s,]/u.test(host) ? host : undefined;
}

const entries = (list: string) =>
  list
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

/** Prepend `host` to a comma-separated NO_PROXY list, keeping its meaning. */
export function withMcpProxyBypass(
  current: string | undefined,
  host: string,
): string {
  // Exactly `*` bypasses everything for every client; Python ignores a `*`
  // entry inside a longer list, so only the whole value is left alone.
  if (current?.trim() === "*") return current;
  const kept = entries(current ?? "");
  return [host, ...kept.filter((entry) => entry.toLowerCase() !== host)].join(
    ",",
  );
}

/**
 * The NO_PROXY/no_proxy values a launch carries for `mcpUrl`, given the values
 * the launch environment already has. Shared by the launch compiler and the
 * machine check, so the probe follows exactly what launches contain.
 */
export function launchProxyBypass(
  mcpUrl: string,
  current: Readonly<Partial<Record<string, string>>> = {},
): Partial<Record<(typeof MCP_PROXY_BYPASS_KEYS)[number], string>> {
  const host = mcpProxyBypassHost(mcpUrl);
  if (!host) return {};
  const upper = current.NO_PROXY,
    lower = current.no_proxy;
  return {
    NO_PROXY: withMcpProxyBypass(upper ?? lower, host),
    no_proxy: withMcpProxyBypass(lower ?? upper, host),
  };
}

export type ProxyBypassValues = Partial<
  Record<(typeof MCP_PROXY_BYPASS_KEYS)[number], string>
>;

/** The NO_PROXY/no_proxy entries an environment layer defines. */
export function pickProxyBypass(
  env: Readonly<Record<string, string>>,
): ProxyBypassValues {
  const picked: ProxyBypassValues = {};
  for (const key of MCP_PROXY_BYPASS_KEYS)
    if (Object.hasOwn(env, key)) picked[key] = env[key] as string;
  return picked;
}

/**
 * The same merge in POSIX sh, run where the harness starts: the account's
 * inherited lists are only known there. `fixed` holds the values a launch
 * layer (profile env, Claude settings) sets; each spelling takes its fixed
 * value, else the inherited one, else the other spelling's — exactly the
 * list each client used before — and gains the Card host.
 */
export function launchProxyBypassShell(
  host: string,
  fixed: ProxyBypassValues,
  quote: (value: string) => string,
): string {
  const prior = (key: (typeof MCP_PROXY_BYPASS_KEYS)[number]) =>
    fixed[key] === undefined ? `"\${${key}:-}"` : quote(fixed[key]);
  return `# C-600: the Card MCP host never goes through a proxy; every other
# destination keeps the route it had (per spelling, layered, \`*\` untouched).
cardigan_bypass() {
  case "$(printf '%s' "$2" | tr -d ' \\t')" in
    \\*) printf '%s' "$2" ;;
    '') printf '%s' "$1" ;;
    *) printf '%s,%s' "$1" "$2" ;;
  esac
}
cardigan_prior_upper=${prior("NO_PROXY")}
cardigan_prior_lower=${prior("no_proxy")}
cardigan_upper=$(cardigan_bypass ${quote(host)} "\${cardigan_prior_upper:-$cardigan_prior_lower}")
cardigan_lower=$(cardigan_bypass ${quote(host)} "\${cardigan_prior_lower:-$cardigan_prior_upper}")
export NO_PROXY="$cardigan_upper" no_proxy="$cardigan_lower"
unset cardigan_prior_upper cardigan_prior_lower cardigan_upper cardigan_lower
`;
}
