import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { fail, type HcClient } from "./client.js";

export const dedicatedConfigHome = (root: string, session: string) =>
  join(root, "hc-config", session);

/** Fixed program: no shell, symlinks, shared writable ancestors or shared config edits.
 * The core check reads only the one environment key relevant to config selection.
 */
export const DEDICATED_CONFIG_SCRIPT = `import os, stat, sys
path = sys.argv[1]
if sys.argv[2] == 'core' and os.environ.get('XDG_CONFIG_HOME') != path:
    raise SystemExit('Cardigan core config environment mismatch; operator migration required')
fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
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
print('cardigan-config-ready')
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
) {
  const answer = await client.exec([
    "exec",
    ...(machine ? ["--on", machine] : []),
    "--",
    "python3",
    "-c",
    DEDICATED_CONFIG_SCRIPT,
    home,
    "core",
  ]);
  if (answer.trim() !== "cardigan-config-ready")
    fail("invalid_launch", "Core configuration was not verified");
}
