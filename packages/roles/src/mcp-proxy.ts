/**
 * C-600: some harness HTTP clients (Codex) read the macOS system proxy but not
 * its exception list, so a Card MCP request to a tailnet address goes to the
 * local proxy and fails. Every launch therefore names the Card MCP host in
 * NO_PROXY/no_proxy: the clients that honour system proxies also honour these
 * variables, while the model API keeps using whatever proxy is configured.
 *
 * Clients disagree on which spelling wins and on what an empty value means:
 *
 * - Python urllib, undici: `no_proxy` if set (empty: none), else `NO_PROXY`;
 * - curl, Go: the first non-empty of the two (curl lower first, Go upper);
 * - reqwest (Codex): `NO_PROXY` if set (empty: none), else `no_proxy`.
 *
 * So every non-empty spelling gains the Card host and keeps its entries (`*`
 * stays as it is); a spelling set in no layer takes the other one's entries;
 * an explicitly empty spelling becomes the Card host only when the other one
 * is not a non-empty list. When it is, clients already disagree (one reads
 * "none", another falls back to the other list) and no value adds the Card
 * host for both without changing someone's other routes, so the empty value
 * stays: no client's non-Card route ever changes. A client reading that empty
 * value keeps sending Card through its proxy; for a harness the session check
 * then reports the MCP failure and the machine check shows the same route.
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
  options: {
    /**
     * A spelling missing from `current` may still be inherited at run time
     * (Claude settings over the process): an empty value then stays empty,
     * which never changes a non-Card route.
     */
    absentMayBeInherited?: boolean;
  } = {},
): Partial<Record<(typeof MCP_PROXY_BYPASS_KEYS)[number], string>> {
  const host = mcpProxyBypassHost(mcpUrl);
  if (!host) return {};
  const merged = (own: string | undefined, other: string | undefined) => {
    const otherListed =
      other === undefined
        ? options.absentMayBeInherited === true
        : other !== "";
    if (own === "" && otherListed) return "";
    return withMcpProxyBypass(own ?? other, host);
  };
  return {
    NO_PROXY: merged(current.NO_PROXY, current.no_proxy),
    no_proxy: merged(current.no_proxy, current.NO_PROXY),
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
 * layer (profile env, Claude settings) sets; each spelling's prior list is
 * its fixed value, else the inherited one, merged by the rule above.
 */
export function launchProxyBypassShell(
  host: string,
  fixed: ProxyBypassValues,
  quote: (value: string) => string,
): string {
  const prior = (key: (typeof MCP_PROXY_BYPASS_KEYS)[number], name: string) =>
    fixed[key] === undefined
      ? `if [ "\${${key}+set}" = set ]; then cardigan_set_${name}=1; cardigan_prior_${name}=$${key}; else cardigan_set_${name}=; cardigan_prior_${name}=; fi`
      : `cardigan_set_${name}=1; cardigan_prior_${name}=${quote(fixed[key])}`;
  // Unset: the other's list; empty while the other is a non-empty list: kept
  // empty (clients already disagree); otherwise: own list plus the Card host.
  const merge = (own: string, other: string) =>
    `if [ -z "$cardigan_set_${own}" ]; then cardigan_${own}=$(cardigan_bypass ${quote(host)} "$cardigan_prior_${other}")
elif [ -z "$cardigan_prior_${own}" ] && [ -n "$cardigan_prior_${other}" ]; then cardigan_${own}=
else cardigan_${own}=$(cardigan_bypass ${quote(host)} "$cardigan_prior_${own}"); fi`;
  return `# C-600: the Card MCP host never goes through a proxy; no other destination
# changes route for any client (per spelling, layered, \`*\` untouched, an empty
# spelling stays empty while the other one is a non-empty list).
cardigan_bypass() {
  case "$(printf '%s' "$2" | tr -d ' \\t')" in
    \\*) printf '%s' "$2" ;;
    '') printf '%s' "$1" ;;
    *) printf '%s,%s' "$1" "$2" ;;
  esac
}
${prior("NO_PROXY", "upper")}
${prior("no_proxy", "lower")}
${merge("upper", "lower")}
${merge("lower", "upper")}
export NO_PROXY="$cardigan_upper" no_proxy="$cardigan_lower"
unset cardigan_set_upper cardigan_set_lower cardigan_prior_upper cardigan_prior_lower cardigan_upper cardigan_lower
`;
}
