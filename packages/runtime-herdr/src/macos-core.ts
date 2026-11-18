/** Manifest-pinned hc owns its SSH-started core (setsid + core.lock + holder recovery).
 * Never run a competing LaunchDaemon or synthesize SSH_CONNECTION to bypass
 * hc's GUI launchd path. This script runs only on the selected worker.
 */
export const MACOS_CORE_SCRIPT = `import os, pwd, subprocess, sys
def require(ok):
    if not ok:
        sys.stderr.write('worker_macos_core_owner_conflict\\n')
        sys.exit(1)
require(sys.platform == 'darwin' and bool(os.environ.get('SSH_CONNECTION')))
account = pwd.getpwuid(os.geteuid())
require(account.pw_name == sys.argv[3] and account.pw_dir == os.environ.get('HOME'))
label = sys.argv[2]
try:
    os.lstat('/Library/LaunchDaemons/' + label + '.plist')
except FileNotFoundError:
    pass
except OSError:
    require(False)
else:
    require(False)
try:
    result = subprocess.run(['/bin/launchctl', 'print', 'system/' + label],
                            stdin=subprocess.DEVNULL, capture_output=True, timeout=5,
                            env=dict(PATH='/usr/bin:/bin', LC_ALL='C'))
    require(result.returncode == 113 and
            ('Could not find service "' + label + '" in domain for system') in result.stderr.decode())
except Exception:
    require(False)
core = '/Applications/Herdr Core.app/Contents/MacOS/herdr-core'
os.environ['HC_SOCKET'] = account.pw_dir + '/.local/state/herdr-core/' + sys.argv[1] + '/' + sys.argv[1] + '.sock'
os.execve(core, [core, 'connect', '--session', sys.argv[1]], dict(os.environ))
`;
