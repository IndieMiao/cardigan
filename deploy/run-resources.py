"""Run-scoped task entry and read/notify reconciliation. Never take PIDs from disk."""
import base64
import ctypes
import hashlib
import errno
import fcntl
import json
import os
import re
import select
import signal
import stat
import subprocess
import sys
import syslog
from pathlib import Path
import time

DIR = os.O_DIRECTORY | os.O_RDONLY | os.O_NOFOLLOW
KEY = re.compile(r'(A-[1-9][0-9]{0,15})\.(R-[1-9][0-9]{0,15})\.(R-[1-9][0-9]{0,15})')


def require(value):
    if not value:
        raise ValueError('resource_identity_unknown')


def audit(key, outcome):
    syslog.syslog(syslog.LOG_NOTICE, 'cardigan run_resource ' + key + ' ' + outcome)


def owned(scope):
    # An exclusive flock on this exact directory lives only in its creator.
    # Files, PIDs or marker text written by a caller are not ownership proof.
    try:
        fcntl.flock(scope, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return True
    fcntl.flock(scope, fcntl.LOCK_UN)
    return False


def directory(parent, name, create=False):
    if create:
        try:
            os.mkdir(name, 0o700, dir_fd=parent)
        except FileExistsError:
            pass
    fd = os.open(name, DIR, dir_fd=parent)
    st = os.fstat(fd)
    if st.st_uid != os.getuid() or stat.S_IMODE(st.st_mode) != 0o700:
        os.close(fd)
        raise ValueError('resource_owner_unknown')
    return fd


def namespace(tag, create, base='/tmp'):
    require(re.fullmatch(r'[a-f0-9]{64}', tag))
    # Darwin /tmp is a system firmlink/symlink. Canonicalize only the OS root.
    base = os.path.realpath(base)
    root = os.open(base, DIR)
    # Keep the full target/uid binding without spelling out 64 hex digits.
    digest = hashlib.sha256(f'{os.getuid()}:{tag}'.encode('ascii')).digest()
    name = 'cr-' + base64.urlsafe_b64encode(digest).decode('ascii').rstrip('=')
    try:
        return directory(root, name, create), os.path.join(base, name)
    finally:
        os.close(root)


def same(parent, name, fd):
    try:
        return os.path.samestat(os.stat(name, dir_fd=parent, follow_symlinks=False), os.fstat(fd))
    except FileNotFoundError:
        return False


def identity(fd):
    st = os.fstat(fd)
    return [str(st.st_dev), str(st.st_ino)]


def scope_name(key):
    require(KEY.fullmatch(key))
    def compact(part):
        value = int(part[2:])
        digits = ''
        while value:
            value, r = divmod(value, 36)
            digits = '0123456789abcdefghijklmnopqrstuvwxyz'[r] + digits
        return digits
    return '.'.join(compact(part) for part in key.split('.'))


def ended(scope):
    # A host notification, never a PID, path to remove, or executable command.
    return 'end' in os.listdir(scope)


def end(scope):
    try:
        os.close(os.open('end', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=scope))
    except FileExistsError:
        pass


class ProcBSDInfo(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint32) for name in (
        'flags', 'status', 'xstatus', 'pid', 'ppid', 'uid', 'gid',
        'ruid', 'rgid', 'svuid', 'svgid', 'reserved')]
    _fields_ += [('comm', ctypes.c_char * 16), ('name', ctypes.c_char * 32)]
    _fields_ += [(name, ctypes.c_uint32) for name in (
        'nfiles', 'pgid', 'pjobc', 'tdev', 'tpgid')]
    _fields_ += [('nice', ctypes.c_int32), ('start_sec', ctypes.c_uint64),
                ('start_usec', ctypes.c_uint64)]


def darwin_identity(pid):
    libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
    boot = ctypes.create_string_buffer(128)
    size = ctypes.c_size_t(len(boot))
    if libc.sysctlbyname(b'kern.bootsessionuuid', boot, ctypes.byref(size), None, 0):
        raise OSError('boot_unknown')
    libproc = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
    info = ProcBSDInfo()
    libproc.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
    if libproc.proc_pidinfo(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info)) != ctypes.sizeof(info):
        raise OSError('identity_unknown')
    if info.pid != pid or info.status == 5 or not info.start_sec:
        raise ValueError('identity_unknown')
    return boot.value.decode(), info.uid, f'{info.start_sec}:{info.start_usec}', info.pgid


def linux_identity(pid):
    fields = Path(f'/proc/{pid}/stat').read_text().rsplit(') ', 1)[1].split()
    if fields[0] in ('Z', 'X'):
        raise ValueError('identity_unknown')
    uid = Path(f'/proc/{pid}').stat().st_uid
    boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    return boot, uid, fields[19], int(fields[2])


def birth(pid):
    key = (linux_identity if sys.platform == 'linux' else darwin_identity)(pid)
    require(key[1] == os.getuid())
    return ':'.join(map(str, key[:3]))


def session_watch(pid, expected=None):
    require(pid > 1 and (expected is None or birth(pid) == expected))
    if sys.platform == 'linux':
        fd = os.pidfd_open(pid)
        poll = select.poll()
        poll.register(fd, select.POLLIN)
        require(expected is None or birth(pid) == expected)
        return lambda: bool(poll.poll(0))
    if sys.platform == 'darwin':
        queue = select.kqueue()
        event = select.kevent(pid, filter=select.KQ_FILTER_PROC, flags=select.KQ_EV_ADD,
                              fflags=select.KQ_NOTE_EXIT)
        queue.control([event], 0, 0)
        require(expected is None or birth(pid) == expected)
        return lambda: bool(queue.control([], 1, 0))
    raise ValueError('unsupported_worker')


def view(root, age, now):
    result = []
    for name in os.listdir(root):
        if not re.fullmatch(r'[0-9a-z]{1,11}(?:\.[0-9a-z]{1,11}){2}', name):
            continue
        key = 'A-%d.R-%d.R-%d' % tuple(int(x, 36) for x in name.split('.'))
        if not KEY.fullmatch(key) or scope_name(key) != name:
            continue
        try:
            fd = directory(root, scope_name(key))
            try:
                result.append(dict(key=key, inode=identity(fd), expired=now-os.fstat(fd).st_mtime > age,
                                   closed=ended(fd), owned=owned(fd)))
            finally:
                os.close(fd)
        except (ValueError, OSError):
            audit(key, 'skipped_unknown')
    return result


def notify(root, item, age, now):
    key = item['key']
    require(KEY.fullmatch(key))
    fd = directory(root, scope_name(key))
    try:
        require(identity(fd) == item['inode'] and same(root, scope_name(key), fd) and owned(fd))
        require(not item['expired'])  # no worker-side proof of exclusive service use
        end(fd)
        audit(key, 'notified')
    finally:
        os.close(fd)


def mount(fd):
    if sys.platform == 'linux':
        with open('/proc/self/fdinfo/' + str(fd), encoding='ascii') as f:
            return next(line for line in f if line.startswith('mnt_id:'))
    # st_dev alone is insufficient on APFS (firmlinks). Never descend onto
    # an unexpected volume. Private tmp children cannot create OS firmlinks.
    return os.fstat(fd).st_dev, os.fstatvfs(fd).f_fsid


def references(path, all_users=False):
    """lsof +D includes cwd, mapped files and open files beneath this tree.
    Treat warnings, truncation, tool absence and timeouts as unknown/busy.
    Scoped to the executing account; no process names/paths leave the worker.
    """
    tool = '/usr/sbin/lsof' if sys.platform == 'darwin' else '/usr/bin/lsof'
    # The steward pins directories itself. Exclude only that known process.
    result = subprocess.run([tool, '-nP', '-a', '-p', '^' + str(os.getpid()), '+D', path, '-Fp'],
                            cwd='/', env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'},
                            stdin=subprocess.DEVNULL, capture_output=True, timeout=15)
    if result.stdout:
        return True
    require(result.returncode == 1 and not result.stderr)
    # A negative pathname query alone is insufficient: lsof can silently omit
    # another process's inaccessible descriptors. Require a complete view of
    # the project account that owns this 0700 namespace. Fail closed on policy
    # restrictions; never ask for sudo/TCC changes. No raw output is logged.
    if sys.platform == 'linux':
        for proc in Path('/proc').iterdir():
            if not proc.name.isdecimal() or int(proc.name) == os.getpid():
                continue
            try:
                status = (proc/'status').read_bytes().splitlines()
                uid = next(line for line in status if line.startswith(b'Uid:'))
                if not all_users and os.getuid() not in map(int, uid.split()[1:]):
                    continue
                if next(line for line in status if line.startswith(b'State:')).split()[1] == b'Z':
                    continue
                for name in ('cwd', 'root', 'exe'):
                    os.readlink(proc/name)
                # listdir alone succeeds for some otherwise uninspectable PIDs.
                for name in os.listdir(proc/'fd'):
                    try:
                        os.readlink(proc/'fd'/name)
                    except FileNotFoundError:
                        pass  # A concurrently closed FD is not a reference.
                with (proc/'maps').open('rb') as maps:
                    require(bool(maps.read(1)))
            except FileNotFoundError:
                # A disappearing process is harmless; an incomplete live view is not.
                require(not proc.exists())
    else:
        # Verify each visible account process is represented by an inspectable
        # cwd and descriptor set. '+'D alone cannot report TCC/NOFD omissions.
        def query(args):
            r = subprocess.run(args, cwd='/', stdin=subprocess.DEVNULL, capture_output=True,
                               env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}, timeout=15)
            require(r.returncode == 0 and not r.stderr and len(r.stdout) <= 16*1024*1024)
            return r.stdout
        procs = query(['/bin/ps', '-axo', 'pid=,uid=,stat=,comm='])
        expected = {p for line in procs.splitlines() for p,uid,state,cmd in [line.split(None, 3)]
                    if (all_users or int(uid) == os.getuid()) and b'Z' not in state and cmd != b'/bin/ps'}
        entries = query([tool, '-nP', *([] if all_users else ['-u', str(os.getuid())]), '-Fpft'])
        visible = set()
        for field in entries.splitlines():
            if field.startswith(b'p'):
                pid = field[1:]
            if field == b'fcwd':
                visible.add(pid)
            require(field not in (b'fNOFD', b'tunknown'))
        require(expected <= visible)
    # Repeat the target-specific observation after checking visibility.
    result = subprocess.run([tool, '-nP', '-a', '-p', '^' + str(os.getpid()), '+D', path, '-Fp'],
                            cwd='/', env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'},
                            stdin=subprocess.DEVNULL, capture_output=True, timeout=15)
    if result.stdout:
        return True
    require(result.returncode == 1 and not result.stderr)
    return False


def walk_tree(fd, volume, current, expected=None):
    """Pinned openat traversal. Links are unlinked as links, never followed."""
    require(current() and mount(fd) == volume)
    snapshot = {}
    for name in os.listdir(fd):
        require(current())
        st = os.stat(name, dir_fd=fd, follow_symlinks=False)
        require(st.st_uid == os.getuid() and st.st_dev == os.fstat(fd).st_dev)
        obj = (st.st_dev, st.st_ino, st.st_mode)
        if expected is not None:
            require(name in expected and expected[name][0] == obj)
        children = None
        if stat.S_ISDIR(st.st_mode):
            child = os.open(name, DIR, dir_fd=fd)
            try:
                require(os.path.samestat(st, os.fstat(child)))
                children = walk_tree(child, volume, lambda: current() and same(fd, name, child),
                                     None if expected is None else expected[name][1])
                if expected is not None:
                    require(current() and same(fd, name, child))
                    os.rmdir(name, dir_fd=fd)
            finally:
                os.close(child)
        else:
            require(stat.S_ISREG(st.st_mode) or stat.S_ISLNK(st.st_mode) or stat.S_ISSOCK(st.st_mode))
            if expected is not None:
                require(current())
                os.unlink(name, dir_fd=fd)
        snapshot[name] = (obj, children)
    return snapshot


def reclaim(root, key, scope, tmp, path, busy=references):
    require(same(root, scope_name(key), scope) and same(scope, 'tmp', tmp) and ended(scope))
    require(os.path.samestat(os.stat(path, follow_symlinks=False), os.fstat(tmp)))
    try:
        fcntl.flock(tmp, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return 'in_use'
    try:
        def current():
            return (os.path.samestat(os.stat(os.path.dirname(os.path.dirname(path)), follow_symlinks=False), os.fstat(root))
                    and same(root, scope_name(key), scope) and same(scope, 'tmp', tmp))
        volume = mount(scope)
        snapshot = walk_tree(tmp, volume, current)
        try:
            in_use = busy(path)
        except (OSError, ValueError, subprocess.SubprocessError):
            # A partial observation, unlike a known replacement, is retryable.
            return 'observation_unavailable'
        require(current())
        if in_use:
            return 'in_use'
        walk_tree(tmp, volume, current, snapshot)
        require(same(scope, 'tmp', tmp))
        fcntl.flock(root, fcntl.LOCK_EX)
        try:
            require(current())
            os.rmdir('tmp', dir_fd=scope)
            os.unlink('end', dir_fd=scope)
            os.rmdir(scope_name(key), dir_fd=root)
        finally:
            fcntl.flock(root, fcntl.LOCK_UN)
        return 'removed'
    finally:
        fcntl.flock(tmp, fcntl.LOCK_UN)


def steward(root, key, scope, tmp, path, exited):
    # Do not retain caller's pipes, socket, credentials, worktree cwd or tty.
    os.setsid()
    disown_stdio()
    os.environ.clear()
    # Session-bound fallback if the host disappears. Only an actual kernel
    # exit event closes the scope, never a failed observation or a reused PID.
    while not ended(scope) and not exited():
        time.sleep(1)
    audit(key, 'run_end' if ended(scope) else 'session_exit_unregistered_not_targeted')
    if not ended(scope):
        end(scope)
    backoff = 1
    while True:
        try:
            result = reclaim(root, key, scope, tmp, path)
            if result == 'removed' or backoff == 1:
                audit(key, result)
            if result == 'removed':
                return
        except ValueError:
            audit(key, 'skipped_unknown')
            return
        except (OSError, subprocess.SubprocessError):
            if backoff == 1:
                audit(key, 'observation_failed_retry')
        time.sleep(backoff)
        backoff = min(3600, backoff * 2)


def reap_adopted():
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return
        if pid == 0:
            with open('/proc/self/task/%s/children' % os.getpid(), encoding='ascii') as f:
                for text in f.read().split():
                    # Single-threaded subreaper: nobody can reap/recycle this PID
                    # between the kernel child listing and signal delivery.
                    os.kill(int(text), signal.SIGKILL)
            time.sleep(0.02)


def disown_stdio():
    null = os.open('/dev/null', os.O_RDWR)
    for n in range(3):
        os.dup2(null, n)
    os.close(null)
    os.chdir('/')


def retain_fds(keep):
    # Drop even caller descriptors explicitly marked inheritable. Run before
    # allocating watch descriptors; never enumerate any other process here.
    for name in os.listdir('/dev/fd'):
        if name.isdecimal() and int(name) > 2 and int(name) not in keep:
            try:
                os.close(int(name))
            except OSError as exc:
                if exc.errno != errno.EBADF:  # enumeration can include its own, now closed fd
                    raise


def darwin_group_empty(anchor):
    # PROC_PGRP_ONLY; the caller is its own live group leader. A full buffer means
    # multiple members or truncation, never permission to forget the group.
    lib = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
    pids = (ctypes.c_int * 4)()
    n = lib.proc_listpids(2, anchor, pids, ctypes.sizeof(pids))
    return n == ctypes.sizeof(ctypes.c_int) and pids[0] == anchor


def supervise(key, argv, scope, exited, env, cancellation):
    linux = sys.platform == 'linux'
    if linux:
        require(ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) == 0)  # PR_SET_CHILD_SUBREAPER
    reader, writer = os.pipe()
    # A child of the supervisor anchors an isolated session/PGID. Its PID
    # cannot be recycled until this parent waits, even if the anchor crashes.
    anchor = os.fork()
    if anchor == 0:
        try:
            retain_fds({writer})
            os.setsid()
            task = subprocess.Popen(argv, env=env)
            disown_stdio()
            code = task.wait()
            # Inspect our own still-live, private group before exiting; some
            # kernels omit zombies from group listings.
            empty = not linux and darwin_group_empty(os.getpid())
            os.write(writer, bytes([(128 - code if code < 0 else code) % 256, int(empty)]))
        finally:
            os._exit(0)
    os.close(writer)
    disown_stdio()
    os.environ.clear()
    # Do not reap the anchor on foreground completion: an ordinary command
    # may have forked a service that still belongs to this isolated group.
    reaped = False
    try:
        while not ended(scope) and not exited():
            if reader is None:
                time.sleep(0.3)
                continue
            ready = select.select([reader, cancellation], [], [], 0.3)[0]
            if cancellation in ready:
                audit(key, 'foreground_cancelled')
                break
            if reader in ready:
                data = os.read(reader, 2)
                os.close(cancellation)
                emit_status(data[0] if data else 125)
                os.close(reader)
                reader = None
                if linux:
                    # Anchor has reaped the foreground child. Wait for its exit
                    # without consuming status; orphans have now been adopted.
                    os.waitid(os.P_PID, anchor, os.WEXITED | os.WNOWAIT)
                    with open('/proc/self/task/%s/children' % os.getpid(), encoding='ascii') as f:
                        if f.read().split() == [str(anchor)]:
                            os.waitpid(anchor, 0)
                            reaped = True
                            return 0
                elif data[1:] == b"\x01":
                    os.waitpid(anchor, 0)
                    reaped = True
                    return 0
        audit(key, 'closing_registered_tree')
        return 143
    finally:
        # An already-reaped anchor means the optimized no-descendants path.
        if reaped:
            return 0
        try:
            # Even if closure races setsid, killing our unreaped direct child
            # first prevents it from ever creating a service after settlement.
            os.kill(anchor, signal.SIGKILL)
            try:
                os.killpg(anchor, signal.SIGTERM)
                time.sleep(0.25)
                os.killpg(anchor, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.waitpid(anchor, 0)
            if linux:
                reap_adopted()
            else:
                audit(key, 'unbound_descendants_not_targeted')
        except ChildProcessError:
            pass


status_pipe = None


def emit_status(code):
    global status_pipe
    if status_pipe is not None:
        try:
            os.write(status_pipe, bytes([code % 256]))
        except BrokenPipeError:
            pass
        os.close(status_pipe)
        status_pipe = None


def command(tag, key, pid, argv, base='/tmp', expected=None):
    global status_pipe
    require(KEY.fullmatch(key) and argv)
    root, parent = namespace(tag, True, base)
    fcntl.flock(root, fcntl.LOCK_EX)
    try:
        try:
            os.mkdir(scope_name(key), 0o700, dir_fd=root)
            new = True
        except FileExistsError:
            new = False
        scope = directory(root, scope_name(key))
        require(not ended(scope))
        path = os.path.join(parent, scope_name(key), 'tmp')
        if new:
            fcntl.flock(scope, fcntl.LOCK_EX | fcntl.LOCK_NB)
            os.mkdir('tmp', 0o700, dir_fd=scope)
        else:
            require(owned(scope))
        tmp = directory(scope, 'tmp')
        # Acquire independent kernel watches before the command can execute.
        expected = expected or birth(pid)
        require(birth(pid) == expected)
        if new and os.fork() == 0:
            try:
                retain_fds({root, scope, tmp})
                # A fresh open-file description is required for independent flocks.
                independent_root = os.open('.', DIR, dir_fd=root)
                os.close(root)
                root = independent_root
                independent_tmp = os.open('.', DIR, dir_fd=tmp)
                os.close(tmp)
                tmp = independent_tmp
                steward(root, key, scope, tmp, path, session_watch(pid, expected))
            finally:
                os._exit(0)
        if new:
            # Only the steward keeps the creating OFD (and hence its lock).
            previous = scope
            scope = os.open('.', DIR, dir_fd=scope)
            os.close(previous)
        fcntl.flock(tmp, fcntl.LOCK_SH)
    finally:
        fcntl.flock(root, fcntl.LOCK_UN)
    reader, writer = os.pipe()
    cancel_read, cancel_write = os.pipe()
    if os.fork() == 0:
        retain_fds({writer, tmp, scope, cancel_read})
        status_pipe = writer
        try:
            os.setsid()
            code = supervise(key, argv, scope, session_watch(pid, expected), dict(os.environ, TMPDIR=path, TEMP=path, TMP=path), cancel_read)
            emit_status(code)
        finally:
            os._exit(0)
    os.close(cancel_read)
    os.close(writer)
    os.close(tmp)
    os.close(scope)
    os.close(root)
    data = os.read(reader, 1)
    os.close(reader)
    os.close(cancel_write)
    return data[0] if data else 125


def main():
    if len(sys.argv) == 3 and sys.argv[1] == 'birth':
        print(birth(int(sys.argv[2])))
    elif len(sys.argv) == 2 and sys.argv[1] == 'reconcile':
        request = json.load(sys.stdin)
        try:
            root, _ = namespace(request['tag'], False)
        except FileNotFoundError:
            print('[]')
            return
        try:
            if 'items' in request:
                for item in request['items']:
                    notify(root, item, request['age'], time.time())
                print('[]')
            else:
                print(json.dumps(view(root, request['age'], time.time())))
        finally:
            os.close(root)
    else:
        require(len(sys.argv) > 3 and sys.argv[2] == '--')
        key = os.environ['CARDIGAN_RESOURCE_SESSION'] + '.' + sys.argv[1]
        sys.exit(command(os.environ['CARDIGAN_RESOURCE_TARGET'], key,
                         int(os.environ['CARDIGAN_SESSION_PID']), sys.argv[3:], expected=os.environ['CARDIGAN_SESSION_BIRTH']))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('cardigan: run resource unavailable', file=sys.stderr)
        sys.exit(125)
