/**
 * C-686: Claude Code status line for Agent sessions.
 *
 * The script travels inline in the per-launch `--settings` file the host
 * writes into the run directory, so it never enters the project repository
 * (§10.2) and reaches remote workers through the settings file they already
 * accept, without a new published file. It needs only Python 3 and git, does
 * no network or Card MCP calls, and prints selected fields only: no
 * environment value is echoed, and the API relay shows its hostname alone.
 *
 * Long-lived sessions receive later Runs as bells, so the current card and Run
 * come from the newest bell for this Assignment in the transcript tail (the
 * launch values are the fallback), remembered in the session's config
 * directory across `/clear`.
 */

export interface ClaudeStatusLineConfig {
  readonly employee?: string;
  readonly assignment: string;
  readonly role: string;
  readonly card?: string;
  readonly work_item?: string;
  readonly run: string;
  /** e.g. `origin/main`; without it the branch upstream is used. */
  readonly base_ref?: string;
  /** Remaining-context percentages, same comparison as host_ops. */
  readonly handoff_remaining_pct: number;
  readonly restart_remaining_pct: number;
  /** Hostname only, never a URL. */
  readonly relay?: string;
}

/** Hostname of an endpoint URL, or undefined. Never returns credentials, path or query. */
export function relayHostname(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const host = new URL(url).hostname;
    return /^[A-Za-z0-9.:[\]-]{1,253}$/.test(host) ? host : undefined;
  } catch {
    return undefined;
  }
}

const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

export function claudeStatusLineSetting(
  python: string,
  config: ClaudeStatusLineConfig,
) {
  return {
    type: "command",
    command: `${quote(python)} -I -B -S -c ${quote(CLAUDE_STATUSLINE_SCRIPT)} ${quote(JSON.stringify(config))}`,
    padding: 0,
  } as const;
}

export const CLAUDE_STATUSLINE_SCRIPT = String.raw`import json, os, re, subprocess, sys
TAIL = 524288
BELL = re.compile(r"\[bell\] (?:card=([A-Za-z0-9_-]{1,40})|project=\S+) asg=([A-Za-z0-9_-]{1,40})(?: run=([A-Za-z0-9_-]{1,40}))?")
def clean(v, n=60):
    if v is None or isinstance(v, (dict, list)):
        return ""
    return re.sub(r"[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]", "", str(v)).strip()[:n]
def get(o, *keys):
    for k in keys:
        if not isinstance(o, dict):
            return None
        o = o.get(k)
    return o
def num(v):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v or v in (float("inf"), float("-inf")) or v < 0:
        return None
    return v
def load(text):
    try:
        v = json.loads(text)
    except Exception:
        return {}
    return v if isinstance(v, dict) else {}
def chunk(path, tail):
    if not isinstance(path, str) or not path.startswith("/"):
        return b"", False
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            start = max(0, size - TAIL) if tail else 0
            f.seek(start)
            raw = f.read(TAIL)
    except Exception:
        return b"", False
    return raw, start > 0 or (not tail and size > TAIL)
def latest_bell(path, asg, tail=True):
    if not asg:
        return None
    raw, cut = chunk(path, tail)
    lines = raw.split(b"\n")
    if cut:
        lines = lines[1:] if tail else lines[:-1]
    for line in reversed(lines):
        if b"[bell]" not in line:
            continue
        ev = load(line)
        if ev.get("type") != "user" or ev.get("isSidechain") is True:
            continue
        content = get(ev, "message", "content")
        if isinstance(content, str):
            texts = [content]
        elif isinstance(content, list):
            texts = [b.get("text") for b in content if isinstance(b, dict) and b.get("type") == "text"]
        else:
            texts = []
        for text in reversed(texts):
            if not isinstance(text, str):
                continue
            found = [m for m in BELL.finditer(text) if m.group(2) == asg]
            if found:
                m = found[-1]
                return {"asg": asg, "card": m.group(1), "run": m.group(3)}
    return None
def state_path():
    base = os.environ.get("CLAUDE_CONFIG_DIR")
    return os.path.join(base, "cardigan-statusline.json") if base and base.startswith("/") else None
def remembered(asg):
    path = state_path()
    if not path:
        return None
    try:
        with open(path, "rb") as f:
            v = load(f.read(4096))
    except Exception:
        return None
    return v if v.get("asg") == asg else None
def remember(bell):
    path = state_path()
    if not path or remembered(bell["asg"]) == bell:
        return
    tmp = path + "." + str(os.getpid())
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(json.dumps(bell))
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except Exception:
            pass
def git(cwd, *args):
    try:
        r = subprocess.run(["git", "-C", cwd, "--no-optional-locks", *args], stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=0.04, text=True)
    except Exception:
        return None
    return r.stdout.strip() if r.returncode == 0 else None
def branch(cwd, base):
    if not cwd or not os.path.isdir(cwd):
        return ""
    name = git(cwd, "rev-parse", "--abbrev-ref", "HEAD")
    if not name:
        return ""
    if name == "HEAD":
        name = git(cwd, "rev-parse", "--short", "HEAD") or name
    counts = git(cwd, "rev-list", "--left-right", "--count", (base or "@{upstream}") + "...HEAD")
    out = clean(name, 48)
    parts = (counts or "").split()
    if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
        out += " ↑" + parts[1] + " ↓" + parts[0]
    return out
def tokens(n):
    if n >= 1000000:
        return ("%.1f" % (n / 1000000)).rstrip("0").rstrip(".") + "M"
    if n >= 1000:
        return str(int(round(n / 1000))) + "k"
    return str(int(n))
def duration(ms):
    s = int(ms // 1000)
    if s < 60:
        return str(s) + "s"
    if s < 3600:
        return str(s // 60) + "m"
    return "%dh%02dm" % (s // 3600, s % 3600 // 60)
def relay(cfg):
    host = clean(cfg.get("relay"), 253)
    if not host:
        m = re.match(r"^[A-Za-z][A-Za-z0-9+.-]*://(?:[^/?#@]*@)?(\[[0-9A-Fa-f:.]+\]|[^/?#:]+)", os.environ.get("ANTHROPIC_BASE_URL", ""))
        host = m.group(1) if m else ""
    return host if re.match(r"^[A-Za-z0-9.:\[\]-]{1,253}$", host) else ""
def context(cfg, data):
    cw = get(data, "context_window")
    if not isinstance(cw, dict):
        return ""
    size = num(cw.get("context_window_size"))
    usage = cw.get("current_usage")
    used = None
    if isinstance(usage, dict):
        parts = [num(usage.get(k)) for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")]
        if all(p is not None for p in parts):
            used = sum(parts)
    pct = num(cw.get("used_percentage"))
    if pct is None and used is not None and size:
        pct = used * 100 / size
    if pct is None:
        return ""
    pct = min(pct, 100)
    remaining = round((100 - pct) * 10) / 10
    handoff = num(cfg.get("handoff_remaining_pct"))
    restart = num(cfg.get("restart_remaining_pct"))
    handoff = 20 if handoff is None else handoff
    restart = 15 if restart is None else restart
    color = "31" if remaining <= restart else "33" if remaining <= handoff else "32"
    filled = int(round(pct / 10))
    out = "\033[" + color + "m" + "█" * filled + "░" * (10 - filled)
    if used is not None and size:
        out += " " + tokens(used) + "/" + tokens(size)
    return out + (" %d%%" % round(pct)) + "\033[0m"
def main():
    cfg = load(sys.argv[1]) if len(sys.argv) > 1 else {}
    data = load(sys.stdin.read(1048576))
    asg = clean(cfg.get("assignment"), 40)
    card = clean(cfg.get("card"), 40)
    item = clean(cfg.get("work_item"), 40)
    run = clean(cfg.get("run"), 40)
    path = data.get("transcript_path")
    bell = latest_bell(path, asg)
    if bell:
        remember(bell)
    else:
        bell = remembered(asg) or latest_bell(path, asg, False)
    if bell:
        if bell.get("card") != card:
            item = ""
        card = clean(bell.get("card"), 40)
        run = clean(bell.get("run"), 40) or run
    work = "/".join(x for x in (card, item) if x)
    first = [clean(cfg.get("employee"), 40), asg, clean(cfg.get("role"), 40), work, run]
    cwd = get(data, "workspace", "current_dir") or data.get("cwd") or os.getcwd()
    cost = get(data, "cost") if isinstance(get(data, "cost"), dict) else {}
    usd = num(cost.get("total_cost_usd"))
    ms = num(cost.get("total_duration_ms"))
    added = num(cost.get("total_lines_added"))
    removed = num(cost.get("total_lines_removed"))
    model = get(data, "model")
    second = [
        clean(get(data, "model", "display_name") or get(data, "model", "id") or (model if isinstance(model, str) else ""), 40),
        branch(cwd if isinstance(cwd, str) else "", clean(cfg.get("base_ref"), 120)),
        context(cfg, data),
        "" if usd is None else "$%.2f" % usd,
        "" if ms is None else duration(ms),
        "" if added is None and removed is None else "+%d -%d" % (added or 0, removed or 0),
        relay(cfg),
    ]
    lines = [" | ".join(x for x in first if x), " | ".join(x for x in second if x)]
    sys.stdout.write("\n".join(x for x in lines if x) + "\n")
try:
    main()
except Exception:
    sys.stdout.write("cardigan\n")
`;
