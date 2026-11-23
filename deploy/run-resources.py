"""Confirm task lifecycle at its controller; never signal a PID from disk."""
import base64
import ctypes
import hashlib
import hmac
import http.client
import errno
import json
import os
import re
import select
import signal
import socket
import stat
import subprocess
import sys
import syslog
from pathlib import Path
import time
from urllib.parse import urlsplit

VITE_OWNER = None  # included by the host in the authenticated entry
AUTHORITY = None  # pinned by the host when publishing this entry
DIR = os.O_DIRECTORY | os.O_RDONLY | os.O_NOFOLLOW
KEY = re.compile(r'(A-[1-9][0-9]{0,15})\.(R-[1-9][0-9]{0,15})\.(R-[1-9][0-9]{0,15})')


def require(value):
    if not value:
        raise ValueError('resource_identity_unknown')


def describe(exc):
    # Only this file's fixed lowercase codes are shown; never paths or values.
    text = str(exc) if isinstance(exc, ValueError) else ''
    return text if re.fullmatch(r'[a-z][a-z_ ]{0,63}', text) else type(exc).__name__


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
        # Only a readable pidfd proves exit. An invalid handle or an
        # observation error cannot authorize a settlement notification.
        valid = True
        def observed_exit():
            nonlocal valid
            if valid:
                for _, flags in poll.poll(0):
                    valid = not flags & (select.POLLNVAL | select.POLLERR)
                    return valid and bool(flags & select.POLLIN)
            return False
        return observed_exit
    if sys.platform == 'darwin':
        queue = select.kqueue()
        event = select.kevent(pid, filter=select.KQ_FILTER_PROC, flags=select.KQ_EV_ADD,
                              fflags=select.KQ_NOTE_EXIT)
        queue.control([event], 0, 0)
        require(expected is None or birth(pid) == expected)
        return lambda: bool(queue.control([], 1, 0))
    raise ValueError('unsupported_worker')


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


def verify_state(public, signature, payload):
    # Use the system crypto implementation, not a Python package/import from
    # the project. The two short, public inputs never name writable files.
    fds = []
    try:
        for data in (public.encode('ascii'), base64.b64decode(signature, validate=True)):
            require(0 < len(data) <= 512)
            r, w = os.pipe()
            fds.append(r)
            try:
                os.write(w, data)
            finally:
                os.close(w)
        result = subprocess.run(['/usr/bin/openssl', 'dgst', '-sha256', '-verify',
            '/dev/fd/%d' % fds[0], '-signature', '/dev/fd/%d' % fds[1]],
            input=payload.encode('utf8'), pass_fds=fds, timeout=2, cwd='/',
            env={'PATH':'/usr/bin:/bin','OPENSSL_CONF':'/dev/null'},
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        require(result.returncode == 0)
    finally:
        for fd in fds: os.close(fd)


def host_state(key, read_key):
    endpoint, project, machine, registration, public = AUTHORITY
    url = urlsplit(endpoint)
    require(url.path == '/mcp' and not (url.query or url.fragment or url.username or url.password))
    require(url.scheme == 'https' or (url.scheme == 'http' and url.hostname in ('localhost', '127.0.0.1', '::1')))
    nonce = f'{int(time.time()*1000):016x}' + os.urandom(24).hex()
    started = time.monotonic()
    proof = hmac.new(read_key, f'resource-read-v1:{registration}:{key}:{nonce}'.encode('ascii'), 'sha256').hexdigest()
    client = (http.client.HTTPSConnection if url.scheme == 'https' else http.client.HTTPConnection)(url.hostname, url.port, timeout=2)
    try:
        client.request('GET', '/mcp?run_resource=' + key, headers={'X-Resource-Nonce':nonce,
            'X-Resource-Registration':registration, 'X-Resource-Proof':proof})
        res = client.getresponse()
        require(res.status == 200)
        data = res.read(2049)
        require(len(data) <= 2048)
        row = json.loads(data)
        payload = row['payload']
        require(isinstance(payload, str) and isinstance(row['signature'], str))
        verify_state(public, row['signature'], payload)
        fields = json.loads(payload)
        require(isinstance(fields, list) and len(fields) == 7 and fields[:-1] == [
            'resource-state-v1', registration, nonce, key, project, machine])
        require(fields[-1] in ('active', 'ended', 'expired_preview', 'unknown') and time.monotonic()-started < 5)
        return fields[-1]
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
        except Exception:
            # Any failed read is unknown, never an exit or a supervisor crash.
            state = 'unknown'
        if state != self.last and state in ('unknown', 'expired_preview'):
            audit(self.key, state)
        self.last = state
        return state


# An anonymous, invocation-specific lifetime capability, not a writable PID
# list or a service-discovery socket. No other Run is handed either endpoint.
# EOF alone is NOT settlement (the supervisor may have crashed). Participants
# peek the immutable record so it remains readable by private cross-group heirs.
SETTLED = b'cardigan-private-settled-v1\n'


def activate_vite(key, argv, env, port, ended):
    # Only this trusted worker owns this listener. No project/Node code runs
    # in the cold phase. Never release the port and ask a child to rebind it.
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        try:
            listener.bind(('127.0.0.1', port))
            listener.listen()
        except OSError:
            audit(key, 'vite_listener_unavailable')
            raise ValueError('vite port unavailable')
        listener.setblocking(False)
        print(f'cardigan: waiting for first connection on 127.0.0.1:{port}', flush=True)
        while True:
            # Check the queue *after* the potentially slow authenticated read.
            # Successful accept commits this invocation to activation forever,
            # even for a probe that disconnects before Node has started.
            settled = ended()
            try:
                first, _ = listener.accept()
            except BlockingIOError:
                if settled:
                    listener.close()
                    audit(key, 'unused_vite_listener_released')
                    return None
                select.select([listener], [], [], 0.12)
                continue
            except ConnectionAbortedError:
                # A reset during accept is evidence of a client, not of an
                # unused listener. There is no first stream left to hand off.
                first = None
            try:
                fds = (listener.fileno(),) if first is None else (listener.fileno(), first.fileno())
                audit(key, 'vite_listener_activated')
                return subprocess.Popen([*argv, *map(str, fds)], env=env,
                                        start_new_session=True, pass_fds=fds)
            finally:
                if first is not None: first.close()


def supervise_vite(key, argv, confirmation, exited, env, cancellation, port):
    # Neither launch mode entrusts project code with a settlement capability.
    # The inherited sockets, if any, are just this invocation's HTTP ingress.
    env.pop('CARDIGAN_PRIVATE_LIFETIME_FD', None)
    def ended():
        return exited() or confirmation.state() == 'ended'
    if port is None:
        task = subprocess.Popen(argv, env=env, start_new_session=True)
    else:
        task = activate_vite(key, argv, env, port, ended)
        if task is None:
            return 0, ''  # listener released; no project process was started
    env.clear()
    disown_stdio()
    os.environ.clear()
    while True:
        code = task.poll()
        if code is not None:
            return (128-code if code < 0 else code) % 256, ''
        why = stop_cause(key, select.select([cancellation], [], [], 0)[0], exited, confirmation)
        if why:
            audit(key, 'vite_ingress_unproven_retained')
            return 125, why + '; Vite ingress unproven, Vite retained'
        time.sleep(0.12)


def supervise(key, argv, confirmation, exited, env, cancellation):
    publisher, participant = socket.socketpair()
    with publisher, participant:
        participant.shutdown(socket.SHUT_WR)
        channel = participant.fileno()
        env['CARDIGAN_PRIVATE_LIFETIME_FD'] = str(channel)
        task = subprocess.Popen(argv, env=env, start_new_session=True, pass_fds=(channel,))
        participant.close()
        env.clear()
        disown_stdio()
        os.environ.clear()
        foreground = True
        while True:
            code = task.poll()
            if foreground and code is not None:
                foreground = False
                os.close(cancellation)
                emit_status((128-code if code < 0 else code) % 256)
            # POLLHUP, unlike a readable half-close, means all copies of the
            # private participant endpoint have gone. Never enumerate a PGID.
            poll = select.poll()
            poll.register(publisher, select.POLLHUP | select.POLLERR)
            if not foreground and poll.poll(0):
                return 0, ''
            cancelled = foreground and select.select([cancellation], [], [], 0)[0]
            why = stop_cause(key, cancelled, exited, confirmation)
            if why:
                try:
                    publisher.sendall(SETTLED)
                    # Keep our write half open. With the participant's write
                    # half already closed, shutting down ours can cause HUP
                    # while a detached reader still holds the capability.
                    # Only the participant can relinquish its own work after it
                    # has closed admission/drained users. Silence is never a
                    # positive reply or permission to kill it or its siblings.
                    deadline = time.monotonic() + 1
                    while time.monotonic() < deadline:
                        if task.poll() is not None and poll.poll(0):
                            audit(key, 'private_participants_released')
                            return 143, why + '; private participants released'
                        time.sleep(0.05)
                    audit(key, 'private_release_unconfirmed_retained')
                    return 125, why + '; release unconfirmed, private task retained'
                except (BrokenPipeError,ConnectionResetError):
                    audit(key, 'missing_private_participant_retained')
                    return 125, why + '; private participant missing, task retained'
            time.sleep(0.12)


def stop_cause(key, cancelled, exited, confirmation):
    """Why supervision is ending, or None. Each cause is audited once."""
    why = ('entry cancelled' if cancelled else 'agent session exited' if exited()
           else 'run ended' if confirmation.state() == 'ended' else None)
    if why:
        audit(key, 'stop_' + why.replace(' ', '_'))
    return why


status_pipe = None
# One status byte, then an optional short ASCII reason. A single write below
# PIPE_BUF is atomic; the entry reads until EOF.
REASON_MAX = 200


def emit_status(code, reason=''):
    global status_pipe
    if status_pipe is not None:
        try:
            os.write(status_pipe, bytes([code % 256]) + reason.encode('ascii', 'replace')[:REASON_MAX])
        except BrokenPipeError:
            pass
        os.close(status_pipe)
        status_pipe = None


def supervisor_lost(child):
    """Describe a supervisor that closed the status pipe without a status."""
    deadline = time.monotonic() + 2
    while True:
        try:
            done, status = os.waitpid(child, os.WNOHANG)
        except ChildProcessError:
            return 'exit unobserved'
        if done:
            break
        if time.monotonic() > deadline:
            return 'exit unobserved'
        time.sleep(0.02)
    if os.WIFSIGNALED(status):
        number = os.WTERMSIG(status)
        try:
            return signal.Signals(number).name
        except ValueError:
            return f'signal {number}'
    return f'exit {os.WEXITSTATUS(status)}' if os.WIFEXITED(status) else 'exit unobserved'


def prepare(tag, key, base, confirmation):
    """Runs in the supervisor: lifecycle read, scratch directories, audit."""
    state = confirmation.state()
    if state != 'active':
        return None, 'run not active (' + str(state) + ')'
    root, parent = namespace(tag, True, base)
    try:
        scope = directory(root, scope_name(key), True)
        try:
            os.close(directory(scope, 'tmp', True))
        finally:
            os.close(scope)
    finally:
        os.close(root)
    # Q-1011: no recursive inspection, unlink, rename, or transfer of scratch.
    audit(key, 'shared_directory_retained')
    return os.path.join(parent, scope_name(key), 'tmp'), ''


def command(tag, key, pid, argv, base='/tmp', expected=None, confirmation=None, project_vite=False, on_demand_port=None):
    global status_pipe
    require(KEY.fullmatch(key) and argv)
    expected = expected or birth(pid)
    require(birth(pid) == expected)
    token = None if confirmation else hashlib.sha256(os.environ['MCP_TOKEN'].encode()).digest()
    # C-605: fork before this process resolves a host name, opens TLS or
    # writes the system log. On Darwin those start libdispatch/XPC state; a
    # child forked after that dies on its next lookup (the first lifecycle
    # read, 15 s in) without a status, settlement or audit. The child is the
    # first and only process here to use them; the entry only waits.
    reader, writer = os.pipe()
    cancel_read, cancel_write = os.pipe()
    child = os.fork()
    if child == 0:
        # libc can cache its log socket across fork: release it through its
        # owner before recycling fd numbers for a pidfd, cancellation or
        # lifetime socket.
        syslog.closelog()
        retain_fds({writer, cancel_read})
        status_pipe = writer
        code, reason = 125, 'supervisor failed'
        try:
            os.setsid()
            check = confirmation or Confirmation(key, token)
            path, reason = prepare(tag, key, base, check)
            if path is not None:
                reason = 'supervisor failed'
                args = (key, argv, check, session_watch(pid, expected),
                        dict(os.environ, TMPDIR=path, TEMP=path, TMP=path), cancel_read)
                code, reason = supervise_vite(*args, on_demand_port) if project_vite else supervise(*args)
        except BaseException as exc:
            reason = 'supervisor failed (' + describe(exc) + ')'
            try:
                audit(key, 'supervisor_failed ' + type(exc).__name__)
            except Exception:
                pass
        finally:
            emit_status(code, reason)
            os._exit(0)
    os.close(cancel_read)
    os.close(writer)
    try:
        data = b''
        while len(data) <= REASON_MAX:
            block = os.read(reader, REASON_MAX + 1)
            if not block:
                break
            data += block
    finally:
        os.close(reader)
        os.close(cancel_write)
    if not data:
        how = supervisor_lost(child)
        audit(key, 'supervisor_lost ' + how.replace(' ', '_'))
        print('cardigan: supervisor lost (' + how + '); lifetime connection closed without settlement, '
              'private task retained', file=sys.stderr, flush=True)
        return 125
    reason = data[1:].decode('ascii', 'replace')
    if reason:
        print('cardigan: ' + reason, file=sys.stderr, flush=True)
    return data[0]


def dead(fd):
    poll = select.poll()
    poll.register(fd, select.POLLIN)
    return bool(poll.poll(0))


def install_observer(pid, key):
    require(pid > 1 and pid == os.getppid())  # the launcher can only enroll itself
    require(re.fullmatch(r'A-[1-9][0-9]{0,15}\.R-[1-9][0-9]{0,15}', key))
    stamp = birth(pid)
    if sys.platform != 'linux':
        require(os.getppid() == pid)
        audit(key, 'unregistered_session_descendants_retained')
        return stamp
    fd = os.pidfd_open(pid)
    try:
        # Recheck parentage *after* pinning. A matching pair of birth reads
        # alone could both describe the process which recycled the launcher PID.
        require(birth(pid) == stamp and os.getppid() == pid and not dead(fd))
        # Q-1019: parentage is not exclusive registration. A bypass can have
        # clients in another Run; do not even acquire descendant handles.
        audit(key, 'unregistered_session_descendants_retained')
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
        project_vite = len(sys.argv) == 4 and sys.argv[2] in ('--private-vite', '--private-vite-on-demand')
        if project_vite:
            require(VITE_OWNER and re.fullmatch(r'[1-9][0-9]{0,4}', sys.argv[3]) and int(sys.argv[3]) <= 65535)
            if 'CARDIGAN_RESOURCE_BINDINGS' in os.environ:
                require(any(row.get('port') == int(sys.argv[3]) for row in json.loads(os.environ['CARDIGAN_RESOURCE_BINDINGS'])))
            argv = ['node','--input-type=module','-e',VITE_OWNER,sys.argv[3]]
        else:
            require(len(sys.argv) > 4 and sys.argv[2:4] == ['--private', '--'])
            argv = sys.argv[4:]
        key = os.environ['CARDIGAN_RESOURCE_SESSION'] + '.' + sys.argv[1]
        sys.exit(command(os.environ['CARDIGAN_RESOURCE_TARGET'], key,
                         int(os.environ['CARDIGAN_SESSION_PID']), argv, expected=os.environ['CARDIGAN_SESSION_BIRTH'],
                         project_vite=project_vite,
                         on_demand_port=int(sys.argv[3]) if sys.argv[2] == '--private-vite-on-demand' else None))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print('cardigan: run resource unavailable (' + describe(exc) + ')', file=sys.stderr)
        sys.exit(125)
