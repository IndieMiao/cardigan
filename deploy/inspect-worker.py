"""Fixed, read-only worker observation. Controller ships this code, not a worker module."""
import contextlib
import grp
import hashlib
import itertools
import json
import os
import pwd
import re
import signal
import socket
import stat
import subprocess
import sys
from pathlib import Path


DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
FILE = os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW
MARKS = ('identity', 'receiving', 'published', 'start', 'running', 'revoked')
EVENTS = ('session_meta', 'turn_context', 'response_item', 'event_msg', 'assistant', 'user', 'system', 'result', 'summary', 'progress', 'session', 'message', 'model_change', 'thinking_level_change', 'compaction')
STATES = ('working', 'idle', 'blocked', 'done', 'error', 'thinking', 'waiting for input', 'reconnecting', 'would you like to run the following command?')
PROGRAMS = ('codex', 'claude', 'pi', 'node', 'sh', 'bash', 'zsh', 'python3', 'git', 'pnpm')


@contextlib.contextmanager
def directory(path):
    fd = os.open('/', DIR)
    try:
        for part in Path(path).parts[1:]:
            if part in ('.', '..'):
                raise ValueError()
            child = os.open(part, DIR, dir_fd=fd)
            os.close(fd)
            fd = child
        yield fd
    finally:
        os.close(fd)


def read(fd, name, limit, tail=False):
    with os.fdopen(os.open(name, FILE, dir_fd=fd), 'rb') as f:
        st = os.fstat(f.fileno())
        if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or (not tail and st.st_size > limit):
            raise ValueError()
        if tail and st.st_size > limit:
            f.seek(-limit, os.SEEK_END)
            f.readline(limit)
        return f.read(limit)


def log_events(path):
    # Only the selected harness's transcript tree. Limit traversal, stat and I/O;
    # never follow directory entries, load a whole transcript, or export its body.
    newest = None
    budget = 512

    def visit(fd, depth):
        nonlocal newest, budget
        with os.scandir(fd) as entries:
            for entry in entries:
                if budget <= 0:
                    break
                budget -= 1
                if depth and entry.is_dir(follow_symlinks=False):
                    child = os.open(entry.name, DIR, dir_fd=fd)
                    try:
                        visit(child, depth - 1)
                    finally:
                        os.close(child)
                elif entry.name.endswith('.jsonl') and entry.is_file(follow_symlinks=False):
                    stamp = entry.stat(follow_symlinks=False).st_mtime_ns
                    if newest is None or newest[0] < stamp:
                        if newest:
                            os.close(newest[1])
                        newest = (stamp, os.dup(fd), entry.name)
    try:
        with directory(path) as folder:
            visit(folder, 4)
        result = []
        if newest:
            for line in reversed(read(newest[1], newest[2], 131072, True).splitlines()):
                try:
                    item = json.loads(line)
                    kind, stamp = item['type'], item['timestamp']
                    if isinstance(kind, str) and isinstance(stamp, str) and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)', stamp):
                        result.append({'type': kind if kind in EVENTS else 'other', 'time': stamp})
                except (KeyError, TypeError, ValueError, RecursionError):
                    continue
                if len(result) == 8:
                    break
        return result[::-1]
    finally:
        if newest:
            os.close(newest[1])


def screen(text):
    # Never relay arbitrary prose (including secrets.env, PEM fragments, tokens,
    # pasted prompts and model reasoning). Preserve recognizable status lines.
    result = []
    for line in text.rstrip().splitlines()[-12:]:
        words = line.strip().lower().strip('•·… .')
        result.append(next((s for s in STATES if words == s or words.startswith(s + ' (')), '[redacted]' if words else ''))
    return result


def terminals(home, session, labels, pinned):
    path = Path(home, '.local/state/herdr-core', session, session + '.sock')
    st = path.lstat()
    if not stat.S_ISSOCK(st.st_mode) or st.st_uid != os.getuid() or path.resolve() != path:
        raise ValueError()
    # The hc CLI autostarts a missing core. Talk only to an existing socket;
    # lines=0 reads the screen without scrolling the terminal for history.
    with socket.socket(socket.AF_UNIX) as sock:
        sock.settimeout(2)
        sock.connect(str(path))
        with sock.makefile('rb') as stream:
            counter = itertools.count(1)
            def rpc(method, params):
                n = next(counter)
                sock.sendall((json.dumps(dict(jsonrpc='2.0', id=n, method=method, params=params))+'\n').encode())
                line = stream.readline(1024 * 1024 + 1)
                if not line.endswith(b'\n') or len(line) > 1024 * 1024:
                    raise ValueError()
                reply = json.loads(line)
                if reply.get('id') != n or reply.get('jsonrpc') != '2.0':
                    raise ValueError()
                return reply['result']
            hello = rpc('hello', dict(generation=1, framed=False))
            if hello.get('generation') != 1 or hello.get('framed') is not False:
                raise ValueError()
            result, processes = [], []
            for t in rpc('terminal.list', dict(all=True, labels=labels))['terminals']:
                address = t['address']
                if (not re.fullmatch(r't[0-9a-z]{1,12}', address) or (pinned and address != pinned)
                        or not all(t['labels'].get(k) == v for k, v in labels.items())):
                    continue
                tail = screen(rpc('terminal.read', dict(terminal=address, lines=0))['text'])
                rows = []
                if t['state'] == 'live':
                    for pid in {t.get('pid'), (t.get('foreground') or {}).get('pid')}:
                        if type(pid) is int and pid > 0:
                            rows.extend(process(pid))
                after = rpc('terminal.get', dict(terminal=address))
                if any(after.get(k) != t.get(k) for k in ('address', 'labels', 'created_ms', 'pid')):
                    continue
                processes.extend(rows)
                activity = (after.get('status') or {}).get('state')
                result.append(dict(address=address, state=t['state'], activity=activity if activity in ('working', 'idle', 'done', 'error', 'blocked') else None, screen=tail))
                if len(result) == 4:
                    break
            return result, processes


def process(pid):
    # Query only hc-attributed pids. ps (without e) never reads environments.
    cmd = ['/bin/ps', '-p', str(pid), '-o', 'uid=,pid=,etime=,pcpu=,command=']
    with subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env={'LC_ALL': 'C'}) as ps:
        data = ps.stdout.read(4096)
        ps.stdout.close()
    fields = data.decode(errors='replace').strip().split(None, 4)
    if len(fields) != 5 or int(fields[0]) != os.getuid() or int(fields[1]) != pid:
        return []
    argv = fields[4].split()
    exe = os.path.basename(argv[0])
    safe = [exe if exe in PROGRAMS else '[redacted]']
    safe.extend(a if a in ('exec', 'resume', '--model', '--json', '-c') else '[redacted]' for a in argv[1:5])
    return [dict(pid=pid, elapsed=fields[2], cpu=float(fields[3]), command=' '.join(safe))]


def optional(fn):
    try:
        return fn()
    except (OSError, ValueError, KeyError, TypeError, RecursionError):
        return None


def main(c):
    user = pwd.getpwuid(os.getuid())
    if user.pw_name != c['user'] or os.getuid() == 0 or os.geteuid() != os.getuid() or os.getegid() != c['gid']:
        raise ValueError()
    if user.pw_name in ('root', 'ciadmin') or grp.getgrgid(user.pw_gid).gr_name in ('root', 'sudo', 'admin', 'wheel', 'docker'):
        raise ValueError()
    native['isolation_groups'](user, native['process_groups']())
    project, assignment, generation = c['project'], c['assignment'], c['generation']
    base = Path(c['root'], 'runs', project, assignment)
    session_dir = base / 'sessions' / generation if generation else base
    labels = dict(cardigan='1', project=project, assignment=assignment)
    if c['launch_run']:
        labels['run'] = c['launch_run']
    if generation:
        labels['generation'] = generation
    hc = optional(lambda: terminals(user.pw_dir, c['session'], labels, c['terminal']))
    # The CLI can outlive a missing core. Independently identify only its
    # journaled pid (boot + birth + uid + process group), before AND after ps.
    processes = hc[1] if hc else None
    saved = c['process']
    if saved and saved['machine'] == c['target'] and saved['terminal'] == generation and saved['uid'] == os.getuid():
        def observed():
            return native['identity'](saved['machine'], saved['pid'], generation, saved['process_group'])
        if observed() == saved:
            rows = optional(lambda: process(saved['pid']))
            if rows and observed() == saved and not any(r['pid'] == saved['pid'] for r in processes or []):
                processes = (processes or []) + rows

    def markers():
        with directory(base / 'generations' / generation) as d:
            identity = json.loads(read(d, 'identity', 4096))
            if identity != dict(version=1, project=project, assignment=assignment, run=c['launch_run'], generation=generation, target=c['target']):
                raise ValueError()
            return [k for k in MARKS if optional(lambda: stat.S_ISREG(os.stat(k, dir_fd=d, follow_symlinks=False).st_mode))]
    marks = optional(markers) if generation else None
    logs = {'codex': 'codex/sessions', 'claude-code': 'claude/projects', 'pi': 'pi/sessions'}.get(c['harness'])
    events = optional(lambda: log_events(session_dir / logs)) if logs and (marks or c['legacy']) else None
    def digest(path):
        with directory(Path(path).parent) as fd:
            return hashlib.sha256(read(fd, Path(path).name, 2*1024*1024)).hexdigest()
    with directory(c['root']) as fd:
        disk = os.fstatvfs(fd)
    return dict(terminals=hc[0] if hc else None, processes=processes,
                events=events, markers=marks, helpers=[optional(lambda: digest(p)) if p else None for p in c['helpers']],
                free_bytes=disk.f_bavail*disk.f_frsize)


if __name__ == '__main__':
    try:
        signal.alarm(10)
        print(json.dumps(main(json.loads(sys.stdin.buffer.read(8192)))))
    except Exception:
        sys.exit(1)  # no tracebacks, hostnames, paths or raw output on failure
