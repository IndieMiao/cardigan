"""Fixed, read-only worker observation. Controller ships this code, not a worker module."""
import contextlib
import grp
import hashlib
import itertools
import json
import os
import platform
import pwd
import re
import signal
import socket
import stat
import subprocess
import sys
import time
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
        if not tail:
            return f.read(limit)
        truncated = st.st_size > limit
        if truncated:
            f.seek(-limit, os.SEEK_END)
            f.readline(limit)  # first line may be partial
        data = f.read(limit)
        if os.fstat(f.fileno()).st_mtime_ns != st.st_mtime_ns:
            raise ValueError()
        return data, truncated


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
                    raise ValueError()
                budget -= 1
                if entry.is_dir(follow_symlinks=False):
                    if not depth:
                        raise ValueError()
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
            data, truncated = read(newest[1], newest[2], 131072, True)
            for line in reversed(data.splitlines()):
                try:
                    item = json.loads(line)
                    kind, stamp = item['type'], item['timestamp']
                    if isinstance(kind, str) and isinstance(stamp, str) and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)', stamp):
                        result.append({'type': kind if kind in EVENTS else 'other', 'time': stamp})
                except (KeyError, TypeError, ValueError, RecursionError):
                    continue
                if len(result) == 8:
                    break
            if truncated and len(result) < 8:
                return None
        return result[::-1]
    except (OSError, ValueError):
        return None
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


def socket_path(home, session, system):
    if system == 'linux':
        # The fixed SSH probe has a clean environment: the Linux user-runtime
        # directory is /run/user/<uid>. hc also honors a private XDG runtime.
        runtime = Path(os.environ.get('XDG_RUNTIME_DIR') or f'/run/user/{os.getuid()}')
        if runtime.is_dir():
            st = runtime.lstat()
            if runtime.resolve() != runtime or st.st_uid != os.getuid() or st.st_mode & 0o077:
                raise ValueError()
            return runtime / 'herdr-core' / (session + '.sock')
        # With no per-user runtime hc falls back to its private session state.
    elif system != 'darwin':
        raise ValueError()
    return Path(home, '.local/state/herdr-core', session, session + '.sock')


@contextlib.contextmanager
def core_rpc(home, session, system):
    path = socket_path(home, session, system)
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
            yield rpc


IDLE_FOOTERS = {True: re.compile(r'\? for shortcuts|\d+% context left', re.I),
                False: re.compile(r'\? for shortcuts|shift\+tab to cycle', re.I)}
BUSY = re.compile(r'esc to (?:interrupt|cancel)|press enter to confirm', re.I)
# Longer than the once-a-second elapsed-time redraw of a running turn.
SETTLE_SECONDS = 1.5


def prompt_idle(screen, codex):
    # Same rule as the controller's bound prompt for clients without OSC state:
    # only an empty editor directly above its own idle footer, and no running
    # turn or pending confirmation near the bottom. Never relays the text.
    if len(screen.encode()) > 65536:
        return False
    lines = [line.strip() for line in re.split(r'\r?\n', screen) if line.strip()]
    if not lines or not IDLE_FOOTERS[codex].search(lines[-1]):
        return False
    bottom = lines[:-1]
    if not codex and bottom and re.fullmatch(r'─+', bottom[-1]):
        bottom.pop()
    if not bottom or bottom.pop() != ('›' if codex else '❯'):
        return False
    return not BUSY.search('\n'.join(lines[-8:]))


def darwin_retirement(c, terminal_owner=None):
    # Both facts are read on the pinned SSH account. The native receipt comes
    # from the original host launch journal, never from this terminal listing.
    import runpy
    user = pwd.getpwuid(os.getuid())
    p = c['process']
    if (platform.system() != 'Darwin' or os.getuid() == 0 or os.getuid() != os.geteuid()
            or user.pw_name != c['user'] or user.pw_gid != os.getegid() or os.getegid() != c['gid']
            or p['uid'] != os.getuid() or p['pid'] <= 1 or not p['boot'] or not p['start']
            or p['terminal'] != c['generation'] or p['machine'] != c['target']
            or not re.fullmatch(r'[a-zA-Z0-9_-]{1,48}', c['session'])
            or not re.fullmatch(r't[0-9a-z]{1,12}', c['terminal'])):
        raise ValueError()
    with core_rpc(user.pw_dir, c['session'], 'darwin') as rpc:
        t = rpc('terminal.get', dict(terminal=c['terminal']))
        labels = dict(cardigan='1', project=c['project'], assignment=c['assignment'],
                      run=c['launch_run'], generation=c['generation'])
        if (t['address'] != c['terminal'] or type(t.get('created_ms')) != int or
                not all(t['labels'].get(k) == v for k, v in labels.items())):
            raise ValueError()
        if terminal_owner is not None and (t.get('name') != c['agent_name'] or t.get('cwd') != c['cwd']
                or t.get('rm') is not False or t.get('pid') != terminal_owner
                or (t.get('foreground') or {}).get('pid') not in (terminal_owner, p['pid'])):
            return 'unknown'
        native = runpy.run_path(c['primitive'])['darwin_identity']
        observed = darwin_execution(p, native)
        if t['state'] == 'finished' and observed == 'exited':
            return 'exited'
        if t['state'] == 'live' and t.get('keep') is True:
            return 'kept'
        def idle(t):
            status = t.get('status')
            if status is not None and type(status) is not dict:
                return False
            activity = (status or {}).get('state')
            if activity in ('idle', 'done'):
                return True
            # C-626: hc may report no activity for the CLI. Only a controller
            # call that has just read the bound empty editor opts in; working,
            # blocked or error never count. The idle owner never sets it.
            if c.get('unknown_activity') is True and activity in (None, 'unknown'):
                return True
            if status is not None:
                return False
            # hc only relays OSC 7501. Claude Code and Codex never send it, so a
            # null status says nothing about the turn. Require the client's own
            # empty input prompt on this exact terminal generation, twice and
            # byte-identical across an unchanged record: a running turn redraws
            # its elapsed-time line at least every second. The last read is the
            # last observation before any signal; anything else keeps the session.
            def screen():
                text = rpc('terminal.read', dict(terminal=c['terminal'], lines=0)).get('text')
                return text if type(text) is str and (prompt_idle(text, True) or prompt_idle(text, False)) else None
            first = screen()
            if first is None:
                return False
            time.sleep(SETTLE_SECONDS)
            again = rpc('terminal.get', dict(terminal=c['terminal']))
            if not (all(again.get(k) == t.get(k) for k in ('address', 'created_ms', 'pid', 'state', 'keep', 'status', 'turn', 'labels'))
                    and (again.get('foreground') or {}).get('pid') == (t.get('foreground') or {}).get('pid')):
                return False
            return screen() == first
        def live(t):
            return t.get('state') == 'live' and t.get('keep') is False and (not c['require_idle'] or idle(t))
        if observed != 'alive' or not live(t):
            return 'unknown'
        if (terminal_owner or p['pid']) == t.get('pid'):
            return 'alive'
        # Read-only observation runs OUTSIDE the supervisor. The journal identifies
        # its CLI child, not the terminal PID. Prove immediate parentage between two
        # native birth checks, then re-read the same labeled terminal generation.
        parent = t.get('pid')
        def supervised(row):
            return (row.get('name') == c['agent_name'] and row.get('rm') is False
                    and (row.get('foreground') or {}).get('pid') in (parent, p['pid']))
        if terminal_owner is not None or type(parent) != int or parent <= 1 or not supervised(t):
            return 'unknown'
        try:
            ppid = subprocess.check_output(['/bin/ps', '-p', str(p['pid']), '-o', 'ppid='],
                                           env={'LC_ALL': 'C'}, stdin=subprocess.DEVNULL,
                                           stderr=subprocess.DEVNULL, timeout=1).strip()
        except (OSError, subprocess.SubprocessError):
            return 'unknown'
        if ppid != str(parent).encode() or darwin_execution(p, native) != 'alive':
            return 'unknown'
        again = rpc('terminal.get', dict(terminal=c['terminal']))
        if (live(again) and supervised(again) and all(again.get(k) == t[k] for k in ('address', 'created_ms', 'pid'))
                and all(again['labels'].get(k) == v for k, v in labels.items())):
            return 'alive'
        return 'unknown'


def darwin_execution(p, native):
    try:
        boot, uid, start, pgid = native(p['pid'])
    except (OSError, ValueError):
        try:
            os.kill(p['pid'], 0)  # existence only; permission denied is NOT exit
        except ProcessLookupError:
            return 'exited'
        except PermissionError:
            pass
        return 'unknown'
    if not boot or not start:
        return 'unknown'
    if (boot, start) != (p['boot'], p['start']):
        return 'exited'
    return 'alive' if (uid, pgid) == (p['uid'], p['process_group']) else 'unknown'


def retirement_terminal(c):
    if c.get('platform') == 'darwin':
        return darwin_retirement(c)
    # Narrow private read for the controller's existing pidfd retirement path.
    # Read the bound worker socket, never infer exit from an absent address.
    user = pwd.getpwuid(os.getuid())
    if (os.getuid() == 0 or os.geteuid() != os.getuid() or platform.system() != 'Linux'
            or not re.fullmatch(r'[a-zA-Z0-9_-]{1,48}', c['session'])
            or not re.fullmatch(r't[0-9a-z]{1,12}', c['terminal'])):
        raise ValueError()
    managed_loopback_account(c, user)
    with core_rpc(user.pw_dir, c['session'], 'linux') as rpc:
        t = rpc('terminal.get', dict(terminal=c['terminal']))
    labels = dict(cardigan='1', project=c['project'], assignment=c['assignment'],
                  run=c['launch_run'])
    if not labels['run']:
        raise ValueError()
    if c['generation'] is not None:
        labels['generation'] = c['generation']
    elif 'generation' in t['labels']:
        raise ValueError()
    if (t['address'] != c['terminal'] or not all(t['labels'].get(k) == v for k, v in labels.items())
            or t['state'] not in ('live', 'finished') or type(t.get('created_ms')) != int):
        raise ValueError()
    # A live terminal needs positive process evidence; a shell or foreign uid
    # is never a signal target. The pidfd helper checks birth and marker again.
    if t['state'] == 'live' and (type(t.get('pid')) != int or t['pid'] <= 1
                                or os.stat('/proc/' + str(t['pid'])).st_uid != os.getuid()):
        raise ValueError()
    activity = (t.get('status') or {}).get('state', 'unknown')
    return dict(address=t['address'], labels=labels, state=t['state'], created_ms=t['created_ms'],
                keep=t.get('keep', False), pid=t.get('pid'),
                status=dict(state=activity if activity in ('unknown', 'idle', 'done') else 'blocked'))


def terminals(home, session, labels, pinned, system):
    with core_rpc(home, session, system) as rpc:
        result, processes = [], []
        incomplete = False
        for t in rpc('terminal.list', dict(all=True, labels=labels))['terminals']:
            address = t['address']
            if (not re.fullmatch(r't[0-9a-z]{1,12}', address) or (pinned and address != pinned)
                    or not all(t['labels'].get(k) == v for k, v in labels.items())):
                continue
            def same_terminal(other):
                return all(other.get(k) == t.get(k) for k in ('address', 'labels', 'created_ms', 'pid', 'state'))
            def pids(term):
                return {p for p in (term.get('pid'), (term.get('foreground') or {}).get('pid'))
                        if type(p) is int and p > 0 and term['state'] == 'live'}
            def observe(pid):
                return native['identity'](session, pid, address, os.getpgid(pid))
            before = {p: optional(lambda: observe(p)) for p in pids(t)}
            # Bracket attribution with a native birth identity on both sides.
            # The first confirmation occurs *after* recording process births.
            confirmed = rpc('terminal.get', dict(terminal=address)) if before else t
            if not same_terminal(confirmed):
                incomplete = True
                continue
            tail = screen(rpc('terminal.read', dict(terminal=address, lines=0))['text'])
            rows = {p: optional(lambda: process(p)) for p in pids(confirmed) & before.keys()
                    if before[p] and before[p]['uid'] == os.getuid()}
            after = rpc('terminal.get', dict(terminal=address))
            if not same_terminal(after):
                incomplete = True
                continue
            for p in pids(after):
                birth = before.get(p)
                if not birth or optional(lambda: observe(p)) != birth:
                    incomplete = True
                elif birth['uid'] == os.getuid():
                    if rows.get(p):
                        processes.extend(rows[p])
                    else:
                        incomplete = True
            activity = (after.get('status') or {}).get('state')
            result.append(dict(address=address, state=t['state'], activity=activity if activity in ('working', 'idle', 'done', 'error', 'blocked') else None, screen=tail))
            if len(result) == 4:
                break
        # Keep verified rows; never turn an unreadable candidate into proof of absence.
        return result, (None if incomplete and not processes else processes)


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


def managed_loopback_account(c, user):
    # install-agent.py predates per-project remote accounts: gid is the shared
    # supplementary group. Its root-owned installation marker is not readable
    # by the agent. Check metadata only, never the controller's identity/data.
    if (not c['local'] or c['platform'] != 'linux' or user.pw_name != 'agent'
            or user.pw_dir != '/var/lib/cardigan-agent' or os.getgid() != user.pw_gid
            or os.getegid() != user.pw_gid or grp.getgrgid(user.pw_gid).gr_name != 'agent'
            or grp.getgrgid(c['gid']).gr_name != 'cardigan-share'
            or c['gid'] not in os.getgroups() or set(os.getgroups()) - {user.pw_gid, c['gid']}):
        raise ValueError()
    with directory(user.pw_dir) as fd:
        home = os.fstat(fd)
        marker = os.stat('.cardigan-managed', dir_fd=fd, follow_symlinks=False)
        if (home.st_uid != 0 or stat.S_IMODE(home.st_mode) != 0o750 or marker.st_uid != 0
                or not stat.S_ISREG(marker.st_mode) or marker.st_nlink != 1 or stat.S_IMODE(marker.st_mode) != 0o600):
            raise ValueError()
    with directory(c['root']) as fd:
        root = os.fstat(fd)
        if root.st_uid == os.getuid() or root.st_gid != c['gid'] or stat.S_IMODE(root.st_mode) != 0o2750:
            raise ValueError()


def main(c):
    user = pwd.getpwuid(os.getuid())
    if user.pw_name != c['user'] or os.getuid() == 0 or os.geteuid() != os.getuid():
        raise ValueError()
    if user.pw_name in ('root', 'ciadmin') or grp.getgrgid(user.pw_gid).gr_name in ('root', 'sudo', 'admin', 'wheel', 'docker'):
        raise ValueError()
    project, assignment, generation = c['project'], c['assignment'], c['generation']
    if platform.system().lower() != c['platform']:
        raise ValueError()
    if c.get('managed_loopback'):
        managed_loopback_account(c, user)
    else:
        if os.getegid() != c['gid'] or user.pw_gid != c['gid']:
            raise ValueError()
        native['project_account'](dict(account=c['user'], uid=os.getuid(), home=user.pw_dir,
                                       root=c['root'], project=project))
    base = Path(c['root'], 'runs', project, assignment)
    published = generation and not c['local']
    labels = dict(cardigan='1', project=project, assignment=assignment)
    if c['launch_run']:
        labels['run'] = c['launch_run']
    if generation:
        labels['generation'] = generation
    hc = optional(lambda: terminals(user.pw_dir, c['session'], labels, c['terminal'], c['platform'])) if c['live'] else None
    # The CLI can outlive a missing core. Independently identify only its
    # journaled pid (boot + birth + uid + process group), before AND after ps.
    processes = hc[1] if hc else None
    saved = c['process']
    if c['live'] and saved and saved['machine'] == c['target'] and saved['terminal'] == generation and saved['uid'] == os.getuid():
        def observed():
            return native['identity'](saved['machine'], saved['pid'], generation, saved['process_group'])
        birth = optional(observed)
        if birth == saved:
            rows = optional(lambda: process(saved['pid']))
            if rows and optional(observed) == saved:
                if not any(r['pid'] == saved['pid'] for r in processes or []):
                    processes = (processes or []) + rows
            elif not processes:
                processes = None
        elif birth is None and not processes:
            processes = None

    def markers():
        with directory(base / 'generations' / generation) as d:
            identity = json.loads(read(d, 'identity', 4096))
            if identity != dict(version=1, project=project, assignment=assignment, run=c['launch_run'], generation=generation, target=c['target']):
                raise ValueError()
            return [k for k in MARKS if optional(lambda: stat.S_ISREG(os.stat(k, dir_fd=d, follow_symlinks=False).st_mode))]
    marks = optional(markers) if published else None
    logs = {'codex': 'codex/sessions', 'claude-code': 'claude/projects', 'pi': 'pi/sessions'}.get(c['harness'])
    # Local CLI homes are shared across replacement sessions. A matching hc
    # terminal does not bind a transcript; do not inspect that shared history.
    events = optional(lambda: log_events(base / 'sessions' / generation / logs)) if c['live'] and logs and marks else None
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
        print(json.dumps(retirement_terminal(json.loads(sys.argv[1])) if len(sys.argv) == 2
                         else main(json.loads(sys.stdin.buffer.read(8192)))))
    except Exception:
        sys.exit(1)  # no tracebacks, hostnames, paths or raw output on failure
