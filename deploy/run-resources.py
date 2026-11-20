"""Confirm task lifecycle at its controller; never signal a PID from disk."""
import base64
import ctypes
import hashlib
import http.client
import errno
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
from urllib.parse import urlsplit

AUTHORITY = None  # pinned by the host when publishing this entry
DIR = os.O_DIRECTORY | os.O_RDONLY | os.O_NOFOLLOW
KEY = re.compile(r'(A-[1-9][0-9]{0,15})\.(R-[1-9][0-9]{0,15})\.(R-[1-9][0-9]{0,15})')


def require(value):
    if not value:
        raise ValueError('resource_identity_unknown')


def audit(key, outcome):
    syslog.syslog(syslog.LOG_NOTICE, 'cardigan run_resource ' + key + ' ' + outcome)


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


def host_state(key, token):
    endpoint, project, machine = AUTHORITY
    url = urlsplit(endpoint)
    require(url.path == '/mcp' and not (url.query or url.fragment or url.username or url.password))
    require(url.scheme == 'https' or (url.scheme == 'http' and url.hostname in ('localhost', '127.0.0.1', '::1')))
    client = (http.client.HTTPSConnection if url.scheme == 'https' else http.client.HTTPConnection)(url.hostname, url.port, timeout=2)
    try:
        # No proxy discovery, redirects, URL or credential taken from a marker.
        client.request('GET', '/mcp?run_resource=' + key, headers={'Authorization': 'Bearer ' + token})
        res = client.getresponse()
        require(res.status == 200)
        data = res.read(2049)
        require(len(data) <= 2048)
        row = json.loads(data)
        require((row['project'], row['machine'], row['key']) == (project, machine, key))
        require(row['state'] in ('active', 'ended', 'expired_preview', 'unknown'))
        return row['state']
    finally:
        client.close()


class Confirmation:
    def __init__(self, key, token, read=host_state, interval=15):
        self.read = lambda: read(key, token)
        self.key, self.interval, self.next = key, interval, 0
        self.last = None

    def state(self):
        if time.monotonic() < self.next:
            return self.last
        self.next = time.monotonic() + self.interval
        try:
            state = self.read()
        except (OSError, http.client.HTTPException, KeyError, TypeError, ValueError):
            state = 'unknown'
        if state != self.last and state in ('unknown', 'expired_preview'):
            audit(self.key, state)
        self.last = state
        return state


def supervise(key, argv, confirmation, exited, env, cancellation):
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
            env.clear()
            os.environ.clear()
            disown_stdio()
            code = task.wait()
            # Inspect our own still-live, private group before exiting; some
            # kernels omit zombies from group listings.
            empty = not linux and darwin_group_empty(os.getpid())
            os.write(writer, bytes([(128 - code if code < 0 else code) % 256, int(empty)]))
        finally:
            os._exit(0)
    os.close(writer)
    env.clear()
    disown_stdio()
    os.environ.clear()
    # Do not reap the anchor on foreground completion: an ordinary command
    # may have forked a service that still belongs to this isolated group.
    authorized = False
    try:
        while not exited() and confirmation.state() != 'ended':
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
                            return 0
                elif data[1:] == b"\x01":
                    os.waitpid(anchor, 0)
                    return 0
        authorized = True
        audit(key, 'closing_registered_tree')
        return 143
    finally:
        if authorized:
            stop_anchor(key, anchor, linux)


def stop_anchor(key, anchor, linux):
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


def command(tag, key, pid, argv, base='/tmp', expected=None, confirmation=None):
    global status_pipe
    require(KEY.fullmatch(key) and argv)
    expected = expected or birth(pid)
    require(birth(pid) == expected)
    confirmation = confirmation or Confirmation(key, os.environ['MCP_TOKEN'])
    require(confirmation.state() == 'active')
    root, parent = namespace(tag, True, base)
    try:
        scope = directory(root, scope_name(key), True)
        try:
            os.close(directory(scope, 'tmp', True))
        finally:
            os.close(scope)
    finally:
        os.close(root)
    path = os.path.join(parent, scope_name(key), 'tmp')
    # Q-1011: no recursive inspection, unlink, rename, or transfer of scratch.
    audit(key, 'shared_directory_retained')
    reader, writer = os.pipe()
    cancel_read, cancel_write = os.pipe()
    if os.fork() == 0:
        retain_fds({writer, cancel_read})
        status_pipe = writer
        try:
            os.setsid()
            code = supervise(key, argv, confirmation, session_watch(pid, expected),
                             dict(os.environ, TMPDIR=path, TEMP=path, TMP=path), cancel_read)
            emit_status(code)
        finally:
            os._exit(0)
    os.close(cancel_read)
    os.close(writer)
    try:
        data = os.read(reader, 1)
        return data[0] if data else 125
    finally:
        os.close(reader)
        os.close(cancel_write)


def dead(fd):
    poll = select.poll()
    poll.register(fd, select.POLLIN)
    return bool(poll.poll(0))


def observe_descendants(key, pid, rootfd):
    # Walk only kernel child lists rooted at the launch PID. Retain *handles*,
    # not PIDs, across setsid/reparenting. Identity must still be live on both
    # ends of each edge after reading ppid. Never target the observer itself.
    pins = {}
    incomplete = False
    while not dead(rootfd):
        for child, fd in list(pins.items()):
            if dead(fd):
                os.close(pins.pop(child))
        queue = [(pid, rootfd), *pins.items()]
        for parent, parentfd in queue:
            if dead(parentfd):
                continue
            try:
                for task in Path(f'/proc/{parent}/task').iterdir():
                    for n in (task/'children').read_text().split():
                        child = int(n)
                        if child == os.getpid() or child in pins:
                            continue
                        if len(pins) >= 4096:
                            raise ValueError('observation_limit')
                        fd = os.pidfd_open(child)
                        try:
                            fields = Path(f'/proc/{child}/stat').read_text().rsplit(') ', 1)[1].split()
                            if (int(fields[1]) == parent and not dead(parentfd) and not dead(fd)
                                    and Path(f'/proc/{child}').stat().st_uid == os.getuid()):
                                pins[child] = fd
                                queue.append((child, fd))
                                fd = None
                        finally:
                            if fd is not None:
                                os.close(fd)
            except (FileNotFoundError, ProcessLookupError):
                continue
            except (OSError, ValueError):
                if not incomplete:
                    audit(key, 'unobservable_descendants_not_targeted')
                    incomplete = True
        time.sleep(0.4)
    # Run monitors have their own session-exit watches. Give them a chance to
    # reap their groups before the outer observer handles remaining bypasses.
    time.sleep(1.5)
    for fd in pins.values():
        try:
            if not dead(fd):
                signal.pidfd_send_signal(fd, signal.SIGKILL)
                audit(key, 'session_descendant_stopped')
        except ProcessLookupError:
            pass
        except OSError:
            audit(key, 'session_signal_failed')
        finally:
            os.close(fd)
    audit(key, 'session_exit_unproven_not_targeted')


def install_observer(pid, key):
    require(pid > 1 and pid == os.getppid())  # the launcher can only enroll itself
    require(re.fullmatch(r'A-[1-9][0-9]{0,15}\.R-[1-9][0-9]{0,15}', key))
    stamp = birth(pid)
    if sys.platform != 'linux':
        require(os.getppid() == pid)
        audit(key, 'no_stable_bypass_signal_handle')
        return stamp
    fd = os.pidfd_open(pid)
    try:
        # Recheck parentage *after* pinning. A matching pair of birth reads
        # alone could both describe the process which recycled the launcher PID.
        require(birth(pid) == stamp and os.getppid() == pid and not dead(fd))
        if os.fork() == 0:
            try:
                os.setsid()
                disown_stdio()
                retain_fds({fd})
                os.environ.clear()
                observe_descendants(key, pid, fd)
            except Exception:
                audit(key, 'session_observer_failed')
            finally:
                os._exit(0)
        return stamp
    finally:
        os.close(fd)


def preview(tag, age, now, base='/tmp'):
    require(isinstance(age, int) and age > 0)
    summary = dict(expired=0, unknown=0, partial=False)
    try:
        root, _ = namespace(tag, False, base)
    except FileNotFoundError:
        return summary
    try:
        # Never open scratch or recurse. A partial preview is explicitly not
        # a full inventory; names and directory contents stay on the worker.
        with os.scandir(root) as entries:
            for i, entry in enumerate(entries):
                if i >= 1024:
                    summary['partial'] = True
                    break
                try:
                    require(re.fullmatch(r'[0-9a-z]{1,11}(?:\.[0-9a-z]{1,11}){2}', entry.name))
                    info = entry.stat(follow_symlinks=False)
                    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700)
                    if now - info.st_mtime > age:
                        summary['expired'] += 1
                except (OSError, ValueError):
                    summary['unknown'] += 1
    finally:
        os.close(root)
    return summary


def main():
    if sys.argv[1:] == ['preview']:
        request = json.load(sys.stdin)
        print(json.dumps(preview(request['tag'], request['age'], time.time())))
    elif len(sys.argv) == 4 and sys.argv[1] == 'observe-session':
        print(install_observer(int(sys.argv[2]), sys.argv[3]))
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
