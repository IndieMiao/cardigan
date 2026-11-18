"""Synthetic hc/OS observations, not a macOS or real hc integration result.

The production guard executes unchanged. This small socket/lock fixture models
the upstream connect/serve contract, including a stale socket and a restart.
"""
import fcntl
import errno
import io
import json
import os
import pathlib
import pwd
import socket
import subprocess
import sys
import tempfile
import types

fault, source = sys.argv[1:]
with tempfile.TemporaryDirectory(prefix='cg-hc-') as root:
    session, label = 'cg', 'dev.cardigan.example'
    sys.argv = ['-c', session, label, 'worker_fixture']
    sys.platform = 'darwin'
    os.environ.clear()
    os.environ.update(HOME=root, SSH_CONNECTION='fixture', HC_RUNTIME='1', PATH='/usr/bin:/bin')
    if fault == 'no-ssh': os.environ.pop('SSH_CONNECTION')
    pwd.getpwuid = lambda uid: types.SimpleNamespace(
        pw_name='wrong' if fault == 'wrong-user' else 'worker_fixture',
        pw_dir='/wrong' if fault == 'wrong-home' else root)
    original_lstat = os.lstat
    def lstat(path, *args, **kwargs):
        if str(path) != '/Library/LaunchDaemons/' + label + '.plist':
            return original_lstat(path, *args, **kwargs)
        if fault in ('plist', 'plist-symlink'):
            return types.SimpleNamespace(st_mode=0o120777 if fault == 'plist-symlink' else 0o100644)
        errors = {'plist-eacces': errno.EACCES, 'plist-eio': errno.EIO,
                  'plist-enotdir': errno.ENOTDIR, 'plist-eloop': errno.ELOOP}
        raise OSError(errors.get(fault, errno.ENOENT), 'synthetic metadata observation', str(path))
    os.lstat = lstat

    def launchctl(argv, **kwargs):
        assert argv == ['/bin/launchctl', 'print', 'system/' + label]
        assert kwargs['env'] == dict(PATH='/usr/bin:/bin', LC_ALL='C')
        if fault == 'timeout': raise subprocess.TimeoutExpired(argv, 5)
        error = 'Could not find service "' + ('other' if fault == 'wrong-label' else label) + '" in domain for system'
        if fault == 'denied': error = 'Operation not permitted'
        return types.SimpleNamespace(returncode=0 if fault == 'loaded' else 113, stderr=error.encode())
    subprocess.run = launchctl
    state = pathlib.Path(root) / '.local/state/herdr-core' / session
    state.mkdir(parents=True)
    endpoint = state / (session + '.sock')
    # A bound but closed listener is a real stale Unix socket.
    with socket.socket(socket.AF_UNIX) as stale:
        stale.bind(str(endpoint))
    lock = None
    listener = None
    generations = connections = 0

    def connect(core, args, env):
        global lock, listener, generations, connections
        assert core == '/Applications/Herdr Core.app/Contents/MacOS/herdr-core'
        assert args == [core, 'connect', '--session', session]
        assert env['HC_SOCKET'] == str(endpoint)
        # The entry itself must not unlink the stale socket or take core.lock.
        assert endpoint.exists()
        if listener is None:
            lock = open(state / 'core.lock', 'a+')
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            endpoint.unlink()
            listener = socket.socket(socket.AF_UNIX)
            listener.bind(str(endpoint))
            listener.listen()
            generations += 1
        with socket.socket(socket.AF_UNIX) as client:
            client.connect(str(endpoint))
            peer, _ = listener.accept()
            with peer:
                # The fixed entry preserves the byte stream hc will consume.
                payload = b'\x00framed\nprotocol\xff'
                client.sendall(payload)
                assert peer.recv(4096) == payload
        connections += 1
    os.execve = connect
    try:
        exec(source, {})
        if fault != 'lifecycle': raise AssertionError('guard accepted a fault')
        with open(state / 'core.lock', 'a+') as competitor:
            try:
                fcntl.flock(competitor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                raise AssertionError('second owner acquired lock')
            except BlockingIOError:
                pass
        exec(source, {})
        assert generations == 1
        listener.close()
        listener = None
        lock.close()
        exec(source, {})
        print(json.dumps(dict(connections=connections, generations=generations, competing_owner_rejected=True)))
    finally:
        if listener is not None: listener.close()
        if lock is not None: lock.close()
