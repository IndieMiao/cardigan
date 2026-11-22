// The old installer cannot resolve multiple bindings. Keep the single protected
// configuration in memory through its own preflight/apply rather than guessing.
const script = `import pathlib, runpy, subprocess, sys
entry, system, project, user, root, directory = sys.argv[1:]
api = runpy.run_path(str(pathlib.Path(entry).with_name("install-macos-worker.py")))
if "select_binding" in api:
    for flag in ("--check", "--apply"):
        subprocess.run([sys.executable, "-IB", entry, "--project", project, flag], check=True)
else:
    directory = pathlib.Path(directory)
    api["protected"](directory)
    api["require"](not any(p.name.startswith("worker-") and p.suffix == ".json" for p in directory.iterdir()))
    cfg = api["trusted_json"](directory / "worker.json")
    api["require"]((cfg["project"], cfg["account"], cfg["root"]) == (project, user, root))
    api["require"](type(cfg.get("timeout_ms")) is int and 0 < cfg["timeout_ms"] <= 2147483647)
    account, target = api["preflight"](cfg, system)
    api["apply"](account, target)`;

export function workerDirectoryCommand(
  mac: boolean,
  project: string,
  account: string,
  root: string,
) {
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  const args = [
    script,
    `/opt/cardigan/deploy/install-${mac ? "macos" : "linux"}-worker.py`,
    mac ? "Darwin" : "Linux",
    project,
    account,
    root,
    mac ? "/Library/Cardigan" : "/etc/cardigan",
  ];
  return `sudo ${mac ? "/opt/homebrew/bin" : "/usr/bin"}/python3 -IB -c ${args.map(quote).join(" ")}`;
}
