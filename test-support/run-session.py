"""C-656 session lifecycle. Uses only its own temp base, processes and scope."""
import json
import os
import pathlib
import runpy
import subprocess
import sys
import tempfile
import time

source = pathlib.Path(__file__).resolve().parents[1] / 'deploy' / 'run-resources.py'
m = runpy.run_path(str(source))


def wait_for(condition, seconds=20):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if condition():
            return True
        time.sleep(0.05)
    return False


def alive(pid):
    try:
        state = pathlib.Path(f'/proc/{pid}/stat').read_text().rsplit(') ', 1)[1].split()[0]
        return state not in ('Z', 'X')
    except FileNotFoundError:
        return False


def user_manager():
    try:
        out = subprocess.run(['/usr/bin/systemctl', '--user', 'is-system-running'], capture_output=True,
                             text=True, timeout=5, env={'PATH': '/usr/bin:/bin',
                             'XDG_RUNTIME_DIR': f'/run/user/{os.getuid()}'})
        return out.stdout.strip() in ('running', 'degraded') and os.path.exists('/usr/bin/busctl')
    except (OSError, subprocess.SubprocessError):
        return False


def launch(base, script, work, key='A-7.R-9'):
    """Run session() like launch.sh's exec; the child becomes the 'CLI'."""
    child = os.fork()
    if child == 0:
        try:
            os.chdir(work)
            os.environ['CARDIGAN_RESOURCE_SESSION'] = key
            os.environ['TMPDIR'] = '/tmp'
            # Never sweep the real /tmp from a test: an empty stand-in.
            m['session'](['/bin/sh', '-c', script], base=base, tmp_base=base)
        finally:
            os._exit(127)
    _, status = os.waitpid(child, 0)
    return child, os.waitstatus_to_exitcode(status)


def lifecycle(scoped):
    # Without a scope, only the private root is reaped; the owner file records
    # that no unit exists, so the waiter does not need a user manager.
    g = m['session'].__globals__
    real = g['enter_scope']
    g['enter_scope'] = real if scoped else (lambda unit, pid: False)
    try:
        run_lifecycle(scoped)
    finally:
        g['enter_scope'] = real


def run_lifecycle(scoped):
    base = tempfile.mkdtemp(prefix='cg-session-')
    work = tempfile.mkdtemp(prefix='cg-session-work-')
    try:
        # The 'CLI' records its TMPDIR and private-task base, writes scratch,
        # and leaves a setsid daemon behind (outside its process group).
        script = ('echo "$TMPDIR" > tmpdir; '
                  'touch "$TMPDIR/scratch"; '
                  f'{sys.executable} -IBc "import runpy,os; m=runpy.run_path({str(source)!r}); '
                  f'os.environ[\'CARDIGAN_SESSION_PID\']=str(os.getppid()); '
                  f'print(m[\'private_base\']({base!r}))" > private; '
                  'setsid sleep 120 </dev/null >/dev/null 2>&1 & echo $! > daemon; '
                  'test -e "$TMPDIR/scratch"')
        pid, code = launch(base, script, work)
        assert code == 0, code
        root = pathlib.Path(base) / f'cardigan-{os.getuid()}'
        entry = root / f'A-7.R-9.{pid}'
        tmpdir = pathlib.Path(work, 'tmpdir').read_text().strip()
        assert tmpdir == str(entry / 'tmp'), (tmpdir, entry)
        assert pathlib.Path(work, 'private').read_text().strip() == str(entry)
        daemon = int(pathlib.Path(work, 'daemon').read_text())
        # The waiter removes the whole private root once the CLI has exited.
        # The waiter renames the entry to a claimed name first, then deletes
        # that tree: wait for both steps, not just the rename.
        assert wait_for(lambda: not entry.exists() and not any(
            p.name.startswith('.reaping.') for p in root.iterdir())), 'session root not reaped'
        if scoped:
            assert wait_for(lambda: not alive(daemon)), 'setsid descendant survived its session'
            unit = m['session_unit'](f'A-7.R-9.{pid}')
            state = subprocess.run(['/usr/bin/systemctl', '--user', 'is-active', unit], capture_output=True,
                                   text=True, env={'PATH': '/usr/bin:/bin',
                                   'XDG_RUNTIME_DIR': f'/run/user/{os.getuid()}'}).stdout.strip()
            assert state in ('inactive', 'failed', ''), state
        elif alive(daemon):
            os.kill(daemon, 9)
    finally:
        subprocess.run(['rm', '-rf', base, work])


def setup_failure_still_starts():
    base = tempfile.mkdtemp(prefix='cg-session-')
    work = tempfile.mkdtemp(prefix='cg-session-work-')
    try:
        _, code = launch(base, 'echo "$TMPDIR" > tmpdir', work, key='not-a-key')
        assert code == 0
        assert pathlib.Path(work, 'tmpdir').read_text().strip() == '/tmp'
        assert not (pathlib.Path(base) / f'cardigan-{os.getuid()}').exists()
    finally:
        subprocess.run(['rm', '-rf', base, work])


def sweep_cases():
    base = tempfile.mkdtemp(prefix='cg-session-')
    try:
        root = pathlib.Path(base) / f'cardigan-{os.getuid()}'
        root.mkdir(mode=0o700)
        def entry(name, owner):
            path = root / name
            (path / 'tmp').mkdir(parents=True, mode=0o700)
            (path / 'tmp' / 'file').write_text('x')
            if owner is not None:
                (path / 'owner').write_text(json.dumps(owner))
            return path
        me = m['birth'](os.getpid())
        live = entry(f'A-1.R-1.{os.getpid()}', {'birth': me, 'scoped': False})
        # A recycled PID: same number, different birth stamp.
        stale = entry(f'A-1.R-2.{os.getpid()}', {'birth': me + '0', 'scoped': False})
        gone = entry('A-1.R-3.999999999', {'birth': 'x', 'scoped': False})
        young = entry('A-1.R-4.999999998', None)
        # No owner file but its PID runs: never treated as gone.
        unknown_live = entry(f'A-1.R-6.{os.getpid()}', None)
        foreign = root / 'unrelated'
        foreign.mkdir()
        claimed = root / '.reaping.A-1.R-5.1.1'
        claimed.mkdir()
        old = time.time() - 3600
        os.utime(claimed, (old, old))
        assert m['sweep'](base) == 2
        assert live.exists() and young.exists() and foreign.exists()
        assert not stale.exists() and not gone.exists() and not claimed.exists()
        # An unowned entry past its grace period is reaped too.
        os.utime(young, (old, old))
        os.utime(unknown_live, (old, old))
        assert m['sweep'](base) == 1 and not young.exists()
        assert unknown_live.exists()
        # A root owned by someone else or with loose permissions is refused.
        os.chmod(root, 0o755)
        assert m['sweep'](base) == 0
        assert m['private_base'](base) == '/tmp'
    finally:
        subprocess.run(['rm', '-rf', base])


def tmp_cases():
    base = tempfile.mkdtemp(prefix='cg-tmp-')
    stamps = tempfile.mkdtemp(prefix='cg-tmp-stamp-')
    try:
        b = pathlib.Path(base)
        old = time.time() - 2 * 86400
        def make(rel, aged=True, directory=False):
            path = b / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            if directory:
                path.mkdir()
            else:
                path.write_text('x')
            # ctime cannot be backdated, so the sweep judges two days ahead;
            # a fresh entry is stamped at that moment.
            when = old if aged else time.time() + 2 * 86400
            os.utime(path, (when, when))
            return path
        stale_file = make('pi-mcp-1.txt')
        stale_dir = make('c581tools/a/b')
        for p in (b / 'c581tools' / 'a', b / 'c581tools'):
            os.utime(p, (old, old))
        mixed = make('cg-test-mixed/old')
        make('cg-test-mixed/new', aged=False)
        os.utime(b / 'cg-test-mixed', (old, old))
        held = make('held.log')
        keep_claude = make('claude-997/x')
        os.utime(b / 'claude-997', (old, old))
        legacy_old = make('cr-abc/1aa.75o.75o/tmp/f')
        legacy_new = make('cr-abc/1aa.75o.76g/tmp/f', aged=False)
        for p in (legacy_old.parent, legacy_old.parent.parent):
            os.utime(p, (old, old))
        now = time.time() + 2 * 86400 + 60
        with open(held):
            removed = m['tmp_sweep'](stamps, base=base, now=now)
        assert removed == 3, removed
        assert not stale_file.exists() and not (b / 'c581tools').exists()
        assert not legacy_old.parent.parent.exists() and (b / 'cr-abc').is_dir()
        assert held.exists() and keep_claude.exists() and legacy_new.exists()
        assert (b / 'cg-test-mixed').exists()
        # At most once per interval.
        assert m['tmp_sweep'](stamps, base=base, now=now + 60) == 0
    finally:
        subprocess.run(['rm', '-rf', base, stamps])


def stop_cases():
    # A scope that cannot be confirmed stopped keeps the entry for a later sweep.
    base = tempfile.mkdtemp(prefix='cg-stop-')
    try:
        root = pathlib.Path(base)
        name = 'A-1.R-1.999999999'
        (root / name / 'tmp').mkdir(parents=True)
        (root / name / 'owner').write_text(json.dumps({'birth': 'x', 'scoped': True}))
        tool = root / 'systemctl'
        g = m['reap_entry'].__globals__
        seconds = g['SCOPE_STOP_SECONDS']
        g['SCOPE_STOP_SECONDS'] = -19.8  # a 0.2 s bound for the hanging case
        try:
            for body, reaped in (('sleep 5', False), ('exit 1', False), ('exit 5', True)):
                tool.write_text('#!/bin/sh\n' + body + '\n')
                tool.chmod(0o755)
                assert m['reap_entry'](str(root), name, systemctl=str(tool)) is reaped, body
                assert (root / name).exists() is not reaped, body
        finally:
            g['SCOPE_STOP_SECONDS'] = seconds
    finally:
        subprocess.run(['rm', '-rf', base])


if __name__ == '__main__':
    assert sys.platform == 'linux'
    scoped = user_manager()
    sweep_cases()
    tmp_cases()
    stop_cases()
    setup_failure_still_starts()
    lifecycle(False)
    if scoped:
        lifecycle(True)
    print('session lifecycle passed (' + ('systemd scope' if scoped else 'no user manager: scope skipped') + ')')
