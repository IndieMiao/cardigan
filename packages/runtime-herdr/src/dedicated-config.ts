import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { fail, type HcClient } from "./client.js";

export const dedicatedConfigHome = (root: string, session: string) =>
  join(root, "hc-config", session);

/** Fixed program: no shell, symlinks, shared writable ancestors or shared config edits.
 * The core check reads only the one environment key relevant to config selection.
 */
const AGENT_CONFIG_HOME_SCRIPT = `import pwd, re
session = sys.argv[1]
if not re.fullmatch(r'[a-zA-Z0-9_-]{1,48}', session):
    raise SystemExit('Invalid hc session name')
home = pwd.getpwuid(os.getuid()).pw_dir
path = os.path.join(home, '.config', 'cardigan-hc', session)
`;

const CONFIG_PROGRAM = `fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
if not os.path.isabs(path) or os.path.normpath(path) != path:
    raise SystemExit('Invalid Cardigan config path')
try:
    for part in path.strip('/').split('/') + ['herdr-core']:
        try: os.mkdir(part, 0o700, dir_fd=fd)
        except FileExistsError: pass
        child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
        info = os.fstat(child)
        if info.st_uid not in (0, os.getuid()) or (info.st_mode & 0o022 and not info.st_mode & stat.S_ISVTX):
            os.close(child)
            raise SystemExit('Untrusted Cardigan config ancestor')
        os.close(fd)
        fd = child
    try:
        conf = os.open('config.toml', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
    except FileExistsError:
        conf = os.open('config.toml', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        info = os.fstat(conf)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o777 != 0o600 or info.st_nlink != 1:
            os.close(conf)
            raise SystemExit('Untrusted Cardigan config file')
        with os.fdopen(conf, 'rb') as stream:
            if stream.read(128) != b'draft_wait = 0\\n':
                raise SystemExit('Unexpected Cardigan config content')
    else:
        with os.fdopen(conf, 'wb') as stream: stream.write(b'draft_wait = 0\\n')
finally:
    os.close(fd)
`;

export const DEDICATED_CONFIG_SCRIPT = `import os, stat, sys
if sys.argv[2] == 'agent-core':
    ${AGENT_CONFIG_HOME_SCRIPT.trim().split("\n").join("\n    ")}
else:
    path = sys.argv[1]
if sys.argv[2] in ('core', 'agent-core') and os.environ.get('XDG_CONFIG_HOME') != path:
    raise SystemExit('Cardigan core config environment mismatch; operator migration required')
${CONFIG_PROGRAM}
print('cardigan-config-ready')
`;

/** Executed by the SSH login account before hc starts; no HOME/env trust or stdout. */
export const AGENT_CONFIG_ENTRY_SCRIPT = `import os, stat, sys
${AGENT_CONFIG_HOME_SCRIPT}
${CONFIG_PROGRAM}
os.environ['XDG_CONFIG_HOME'] = path
os.execvp(sys.argv[2], sys.argv[2:])
`;

export async function prepareDedicatedConfig(home: string, timeoutMs: number) {
  if (!home.startsWith("/"))
    fail("invalid_launch", "Config root must be absolute");
  try {
    await promisify(execFile)(
      "python3",
      ["-c", DEDICATED_CONFIG_SCRIPT, home, "prepare"],
      {
        timeout: timeoutMs,
        env: { PATH: "/usr/bin:/bin" },
        maxBuffer: 1024,
      },
    );
  } catch {
    fail(
      "invalid_launch",
      "Dedicated hc configuration is unavailable or untrusted",
    );
  }
}

export async function checkCoreConfig(
  client: HcClient,
  home: string,
  machine?: string,
  accountHome = false,
) {
  const answer = await client.exec([
    "exec",
    ...(machine ? ["--on", machine] : []),
    "--",
    "python3",
    "-c",
    DEDICATED_CONFIG_SCRIPT,
    home,
    accountHome ? "agent-core" : "core",
  ]);
  if (answer.trim() !== "cardigan-config-ready")
    fail("invalid_launch", "Core configuration was not verified");
}
