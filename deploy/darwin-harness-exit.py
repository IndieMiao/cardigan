"""Controller-shipped, signal-free exit request for ONE idle macOS harness session.

Used only when no idle owner can authorize a stop (no owner, or a key the
controller can no longer rebuild). It never signals or kills. The terminal is
read, checked and typed into over ONE core connection, so the manager instance
cannot change in between; hc applies the idle condition when it types. A
non-kept terminal cannot change program in place, and its address is never
reused on that core. The text is the harness's own exit command, nothing else.
"""
import itertools
import json
import os
import platform
import pwd
import re
import runpy
import signal
import socket
import stat
import subprocess
import sys
from pathlib import Path

EXITS = ('/exit', '/quit')


def connect(inspector, home, session):
    path = inspector['socket_path'](home, session, 'darwin')
    st = path.lstat()
    if not stat.S_ISSOCK(st.st_mode) or st.st_uid != os.getuid() or path.resolve() != path:
        raise ValueError()
    sock = socket.socket(socket.AF_UNIX)
    sock.settimeout(5)
    sock.connect(str(path))  # an existing core only; never autostart one
    stream = sock.makefile('rb')
    counter = itertools.count(1)

    def rpc(method, params, timeout=5):
        n = next(counter)
        sock.settimeout(timeout)
        sock.sendall((json.dumps(dict(jsonrpc='2.0', id=n, method=method, params=params))+'\n').encode())
        line = stream.readline(1024 * 1024 + 1)
        if not line.endswith(b'\n') or len(line) > 1024 * 1024:
            raise ValueError()
        reply = json.loads(line)
        if reply.get('id') != n or reply.get('jsonrpc') != '2.0':
            raise ValueError()
        if 'error' in reply:
            return None, (reply['error'].get('data') or {}).get('kind')
        return reply['result'], None

    hello, _ = rpc('hello', dict(generation=1, framed=False))
    if not hello or hello.get('generation') != 1 or hello.get('framed') is not False:
        raise ValueError()
    return sock, rpc


def parent_of(pid):
    try:
        return subprocess.check_output(['/bin/ps', '-p', str(pid), '-o', 'ppid='], env={'LC_ALL': 'C'},
                                       stdin=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=1).strip()
    except (OSError, subprocess.SubprocessError):
        return None


def refusal(c, t, p, native, inspector):
    labels = dict(cardigan='1', project=c['project'], assignment=c['assignment'],
                  run=c['launch_run'], generation=c['generation'])
    if (not t or t.get('address') != c['terminal'] or type(t.get('created_ms')) != int
            or not all((t.get('labels') or {}).get(k) == v for k, v in labels.items())
            or t.get('name') != c['agent_name'] or t.get('rm') is not False):
        return 'identity_changed'
    if t.get('state') != 'live':
        return 'terminal_not_live'
    if t.get('keep') is not False:
        return 'kept_terminal'  # a kept terminal can swap in a shell at this address
    if (t.get('status') or {}).get('state') != 'idle':
        return 'terminal_busy'
    pid = t.get('pid')
    if type(pid) != int or pid <= 1:
        return 'identity_changed'
    # The harness runs directly in the terminal, or as the only child of a
    # former owner whose key is gone. Prove which between native birth checks.
    if pid != p['pid'] and ((t.get('foreground') or {}).get('pid') not in (pid, p['pid'])
                            or parent_of(p['pid']) != str(pid).encode()):
        return 'identity_changed'
    if inspector['darwin_execution'](p, native) != 'alive':
        return 'identity_changed'
    return None


def main(c, inspector, owner):
    user = pwd.getpwuid(os.getuid())
    p = c['process']
    if (platform.system() != 'Darwin' or os.getuid() == 0 or os.getuid() != os.geteuid()
            or user.pw_name != c['user'] or user.pw_gid != os.getegid() or os.getegid() != c['gid']
            or p['uid'] != os.getuid() or p['pid'] <= 1 or not p['boot'] or not p['start']
            or p['terminal'] != c['generation'] or p['machine'] != c['target']
            or c['text'] not in EXITS or c['worktree'] not in ('none', 'write')
            or not re.fullmatch(r'[a-zA-Z0-9_-]{1,48}', c['session'])
            or not re.fullmatch(r't[0-9a-z]{1,12}', c['terminal'])):
        raise ValueError()
    # Same workspace proof as the owner, from the session's own working directory.
    leaf = Path(c['project'], c['assignment'])
    os.chdir(Path(c['root'], 'worktrees', leaf) if c['worktree'] != 'none'
             else Path(c['root'], 'runs', leaf, 'generations', c['generation']))
    if not owner['workspace'](c):
        return 'refused workspace_unverified'
    native = runpy.run_path(c['primitive'])['darwin_identity']
    sock, rpc = connect(inspector, user.pw_dir, c['session'])
    with sock:
        first, _ = rpc('terminal.get', dict(terminal=c['terminal']))
        why = refusal(c, first, p, native, inspector)
        if why:
            return 'refused ' + why
        print('ready', flush=True)
        # The controller's final business guard runs now; anything but go sends nothing.
        if sys.stdin.readline(16) != 'go\n':
            return 'refused guard_changed'
        again, _ = rpc('terminal.get', dict(terminal=c['terminal']))
        why = refusal(c, again, p, native, inspector)
        if why or any(again.get(k) != first[k] for k in ('created_ms', 'pid')):
            return 'refused ' + (why or 'identity_changed')
        sent, kind = rpc('terminal.send', {'terminal': c['terminal'], 'text': c['text'], 'if': 'idle'}, 20)
        if sent is not None:
            return 'sent'
        if kind in ('status_mismatch', 'blocked'):
            return 'refused terminal_busy'
        if kind in ('finished', 'not_found'):
            return 'refused terminal_not_live'
        raise ValueError()  # unknown delivery: the controller keeps the fence


if __name__ == '__main__':
    try:
        signal.alarm(40)
        inspection = {'__name__': 'worker_inspection'}
        exec(compile(sys.argv[1], '<worker-inspection>', 'exec'), inspection)
        idle_owner = {'__name__': 'darwin_idle_owner'}
        exec(compile(sys.argv[2], '<darwin-idle-owner>', 'exec'), idle_owner)
        print(main(json.loads(sys.argv[3]), inspection, idle_owner), flush=True)
    except Exception:
        sys.exit(1)  # no tracebacks, hostnames, paths or raw output on failure
