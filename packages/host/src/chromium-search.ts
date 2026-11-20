/** Only these host-defined labels, never candidate paths or stdout, enter health snapshots. */
export interface ChromiumSearch {
  readonly kind: "chromium";
  readonly patterns: readonly string[];
  readonly scopes: readonly {
    kind: "registry" | "path" | "file" | "cache";
    value: string;
    label: string;
  }[];
}
export type CapabilityCommand = readonly string[] | ChromiumSearch;
export const VERSION_PATTERN = String.raw`(?:^|[^a-zA-Z0-9_.])v?([0-9]{1,6}(?:\.[0-9]{1,6}){1,3})(?![0-9])`;

export function chromiumSearch(os: string, root?: string): ChromiumSearch {
  const mac = os === "darwin";
  const cache = mac ? "Library/Caches/ms-playwright" : ".cache/ms-playwright";
  const chromeApp =
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return {
    kind: "chromium",
    patterns: mac
      ? [
          "chromium-*/chrome-mac*/Chromium.app/Contents/MacOS/Chromium",
          "chromium-*/chrome-mac*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
          "chromium_headless_shell-*/chrome-headless-shell-mac*/chrome-headless-shell",
          "chromium_headless_shell-*/chrome-mac*/headless_shell",
        ]
      : [
          "chromium-*/chrome-linux*/chrome",
          "chromium_headless_shell-*/chrome-headless-shell-linux*/chrome-headless-shell",
          "chromium_headless_shell-*/chrome-linux*/headless_shell",
        ],
    scopes: [
      ...(root
        ? [
            {
              kind: "registry" as const,
              value: root,
              label: "launch.yaml:browser.browsers_path",
            },
          ]
        : []),
      ...["chromium", "chromium-browser", "google-chrome"].map((value) => ({
        kind: "path" as const,
        value,
        label: `PATH:${value}`,
      })),
      ...(mac
        ? [{ kind: "file" as const, value: chromeApp, label: chromeApp }]
        : []),
      { kind: "cache", value: cache, label: `$HOME/${cache}` },
    ],
  };
}

// Runs inside the existing account-scoped Python helper alongside run_command().
export const CHROMIUM_SEARCH_SCRIPT = `
import glob, re, shutil

def candidates(scope, patterns, env):
    kind, value = scope['kind'], scope['value']
    if kind == 'path':
        yield shutil.which(value, path=env['PATH'])
    elif kind == 'file':
        yield value
    else:
        root = os.path.join(env['HOME'], value) if kind == 'cache' else value
        for pattern in patterns:
            yield from glob.iglob(os.path.join(glob.escape(root), pattern))

def search_browser(plan, env, deadline):
    scopes = plan['scopes']
    attempted, incomplete = 0, False
    budget = (deadline - time.monotonic()) / len(scopes)
    for scope in scopes:
        now = time.monotonic()
        if now >= deadline: break
        # Slow candidates in a registry cannot consume the time reserved for PATH/cache.
        scope_end = now + (deadline - now) / (len(scopes) - attempted)
        attempted += 1
        for file in candidates(scope, plan['patterns'], env):
            now = time.monotonic()
            if now >= scope_end:
                incomplete = True
                break
            if not file or not os.path.isfile(file) or not os.access(file, os.X_OK): continue
            try:
                # Keep a share for the next installation in this same scope as well.
                candidate_end = now + min(budget, (scope_end - now) / 2)
                banner = run_command([file, '--version'], env, candidate_end)
            except (OSError, TimeoutError, ValueError):
                incomplete = True
                continue
            match = re.search(r'${VERSION_PATTERN}', banner or '')
            if match: return dict(ok=True, output=match[1])
    return dict(ok=False, output='', attempted=attempted, incomplete=incomplete or attempted != len(scopes))
`;
