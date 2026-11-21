import { join } from "node:path";
import { workerJournalId } from "./worker-onboarding.js";
import {
  onboardingDigest,
  onboardingFail,
  parseWorkerOnboarding,
} from "./worker-onboarding-config.js";

/** UI supplies data, not YAML, commands, executable paths or a dispatch switch. */
export function workerWizardForm(
  root: string,
  dataDir: string,
  project: string,
  form: Record<string, unknown>,
) {
  const {
    machine_id: machine,
    label,
    account,
    uid,
    gid,
    os,
    arch,
    host,
    port = 22,
    mcp_url,
  } = form;
  if (
    Object.keys(form).some(
      (k) =>
        ![
          "machine_id",
          "label",
          "account",
          "uid",
          "gid",
          "os",
          "arch",
          "host",
          "port",
          "mcp_url",
        ].includes(k),
    ) ||
    typeof machine !== "string" ||
    typeof label !== "string" ||
    !label.trim() ||
    label.length > 80 ||
    /\p{C}/u.test(label) ||
    typeof account !== "string" ||
    !/^cg_[a-z0-9_]{1,26}$/u.test(account) ||
    ![uid, gid].every(
      (v) =>
        typeof v === "number" &&
        Number.isSafeInteger(v) &&
        v >= 501 &&
        v <= 2147483647,
    ) ||
    (os !== "linux" && os !== "macos" && os !== "darwin")
  )
    return onboardingFail("worker_form_invalid");
  workerJournalId(project, machine);
  const mac = os !== "linux",
    home = `${mac ? "/Users" : "/home"}/${account}`,
    work = `${mac ? "/Users" : "/srv"}/cardigan-workers/${project}`;
  const alias = `cg-${onboardingDigest([project, machine]).slice(0, 20)}`;
  const raw = {
    version: 1,
    uid,
    home,
    mcp_url,
    ...(mac
      ? {
          launchd: {
            label: `dev.cardigan.${project}`,
            hc_path: `${home}/.local/bin/hc`,
          },
        }
      : {}),
    runtime: {
      version: 1,
      machines: [
        {
          id: machine,
          os: mac ? "darwin" : "linux",
          arch,
          host,
          port,
          identity_file: join(root, "worker-key"),
          known_hosts_file: join(root, "worker-known-hosts"),
          host_key_alias: machine,
          projects: [
            {
              project_id: project,
              user: account,
              gid,
              alias,
              session: "cg",
              root: work,
              path: `${home}/.local/bin:${mac ? "/opt/homebrew/bin" : "/usr/local/bin"}:/usr/bin:/bin:/usr/sbin:/sbin`,
              generation: "initial",
              mcp_url,
              publication: {
                header_max_bytes: 65536,
                file_max_bytes: 1048576,
                batch_max_bytes: 8388608,
                timeout_ms: 30000,
              },
              python: mac ? "/opt/homebrew/bin/python3" : "/usr/bin/python3",
              file_helper: `${work}/libexec/worker-files.py`,
              git_helper: `${work}/libexec/worker-git.py`,
              ...(mac
                ? { retired_launchd_label: `dev.cardigan.${project}` }
                : {}),
            },
          ],
        },
      ],
    },
  };
  const config = parseWorkerOnboarding(raw, dataDir);
  return {
    label,
    raw,
    config,
    commands: targetCommands(
      mac,
      account,
      Number(uid),
      Number(gid),
      home,
      work,
      project,
    ),
  };
}
// Only generated fixed paths, validated dedicated account names and integers reach these templates.
function targetCommands(
  mac: boolean,
  user: string,
  uid: number,
  gid: number,
  home: string,
  work: string,
  project: string,
) {
  const py = mac ? "/opt/homebrew/bin/python3" : "/usr/bin/python3";
  const install = `sudo ${py} /opt/cardigan/deploy/install-${mac ? "macos" : "linux"}-worker.py --project ${project}`;
  return {
    account: mac
      ? [
          `users=$(dscl /Search -list /Users UniqueID)`,
          `groups=$(dscl /Search -list /Groups PrimaryGroupID)`,
          `test -n "$users" && test -n "$groups"`,
          `printf '%s\\n' "$users" | awk '$1 == "${user}" || $2 == ${uid} { exit 1 }'`,
          `printf '%s\\n' "$groups" | awk '$1 == "${user}" || $2 == ${gid} { exit 1 }'`,
          `sudo dscl . -create /Groups/${user} PrimaryGroupID ${gid}`,
          `sudo dscl . -create /Users/${user} UniqueID ${uid}`,
          `sudo dscl . -create /Users/${user} PrimaryGroupID ${gid}`,
          `sudo dscl . -create /Users/${user} NFSHomeDirectory ${home}`,
          `sudo dscl . -create /Users/${user} UserShell /bin/sh`,
        ].join(" && ")
      : `sudo groupadd --gid ${gid} ${user} && sudo useradd --uid ${uid} --gid ${gid} --home-dir ${home} --no-create-home --shell /bin/sh ${user}`,
    directories: `${install} --check && ${install} --apply`,
    helpers: ["worker-files.py", "worker-git.py"]
      .map(
        (file) =>
          `sudo test ! -L ${work}/libexec/${file} && (sudo cmp -s /opt/cardigan/deploy/${file} ${work}/libexec/${file} || (sudo test ! -e ${work}/libexec/${file} && sudo install -o root -g ${user} -m 0750 /opt/cardigan/deploy/${file} ${work}/libexec/${file}))`,
      )
      .join(" && "),
    tools: mac
      ? `codesign --verify --deep --strict -R '=anchor apple generic and identifier "dev.herdr.core" and certificate leaf[subject.OU] = "2W9652Q7QR"' '/Applications/Herdr Core.app' && sudo ln -s '/Applications/Herdr Core.app/Contents/MacOS/herdr-core' ${home}/.local/bin/hc && sudo ln -s '/Applications/Herdr Core.app/Contents/MacOS/herdr-core' ${home}/.local/bin/herdr-core`
      : `sudo /usr/bin/python3 -I - <<'PY'\nimport os, pathlib, platform, runpy\nbinary = runpy.run_path('/opt/cardigan/deploy/install-agent.py')['payload'](None, platform.machine())\nfor name in ('hc', 'herdr-core'):\n    path = pathlib.Path('${home}/.local/bin') / name\n    if path.exists():\n        if path.is_symlink() or path.read_bytes() != binary: raise SystemExit('installed binary conflict')\n        continue\n    with path.open('xb') as f:\n        os.fchmod(f.fileno(), 0o600)\n        f.write(binary)\n        os.fchown(f.fileno(), 0, ${gid})\n        os.fchmod(f.fileno(), 0o750)\nPY`,
  };
}
