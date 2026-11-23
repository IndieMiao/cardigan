"""Controller-shipped, opt-in parent of ONE unchanged worker publication launcher.

The caller cannot supply a signal, executable, signal target, or workspace to the
stop endpoint. A fresh challenge is signed only after the controller's last guard.
"""
import base64
import hashlib
import json
import os
import re
import resource
import secrets
import signal
import socket
import stat
import subprocess
import sys
import tempfile
from pathlib import Path


def metadata(path):
    # Read Git's small registration files only; never follow a substituted link or FIFO.
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or not 0 < info.st_size <= 4096:
            raise ValueError('unverified worktree registration')
        return os.read(fd, 4097)
    finally:
        os.close(fd)


def canonical(path):
    try:
        return path.resolve(strict=True) == path
    except (OSError, RuntimeError):  # pathlib can report a symlink loop as RuntimeError
        return False


def registered_admin(path, common):
    if not canonical(path) or not canonical(common):
        return None
    link = re.fullmatch(rb'gitdir: (/[^\x00\r\n]+)\n', metadata(path / '.git'))
    if not link:
        return None
    admin = Path(os.fsdecode(link[1]))
    if (admin.parent != common / 'worktrees' or not canonical(admin)
            or metadata(admin / 'commondir') != b'../..\n'
            or metadata(admin / 'gitdir') != os.fsencode(path / '.git') + b'\n'):
        return None
    return admin


def clean_tree(path, common, project):
    admin = registered_admin(path, common)
    if not admin:
        return False
    # Do not let Git rediscover a different repository through a changed .git file.
    env = dict(PATH='/usr/bin:/bin', GIT_CONFIG_GLOBAL='/dev/null', GIT_CONFIG_NOSYSTEM='1',
               GIT_DIR=str(admin), GIT_COMMON_DIR=str(common), GIT_WORK_TREE=str(path),
               GIT_NO_LAZY_FETCH='1', GIT_TERMINAL_PROMPT='0', LC_ALL='C')
    def git(*args):
        # Bound noisy/large repositories without transferring paths off the worker.
        cap = 4*1024*1024
        with tempfile.TemporaryFile() as output:
            subprocess.run(['/usr/bin/git', '--no-optional-locks', '-c', 'protocol.allow=never',
                            '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
                            *args], cwd=path, env=env, stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.DEVNULL,
                           timeout=3, check=True, preexec_fn=lambda: resource.setrlimit(resource.RLIMIT_FSIZE,(cap,cap)))
            output.seek(0)
            return output.read(cap)
    # Refuse configs that could launch repository-selected programs or hide changes.
    keys = git('config', '--local', '--no-includes', '--name-only', '--list').decode().splitlines()
    if any(not re.fullmatch(r'core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode)|remote\.origin\.(url|fetch)|branch\..+\.(remote|merge)|extensions\.objectformat', k) for k in keys):
        return False
    if git('config', '--local', '--no-includes', '--get-all', 'remote.origin.url') != os.fsencode('cardigan-central:' + project) + b'\n':
        return False
    # Unborn/damaged checkouts and indexes hiding tracked changes are not proof.
    if not re.fullmatch(b'[0-9a-f]{40}(?:[0-9a-f]{24})?\n', git('rev-parse', '--verify', 'HEAD^{commit}')):
        return False
    if any(not row.startswith((b'H 100644 ', b'H 100755 ', b'H 120000 '))
           for row in git('ls-files', '--stage', '-v', '-z').split(b'\x00') if row):
        return False
    return (git('rev-parse', '--show-toplevel') == os.fsencode(path) + b'\n' and
            not git('status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=none') and
            registered_admin(path, common) == admin)


def workspace(c):
    leaf = Path(c['project'], c['assignment'])
    tree, build = (Path(c['root'], k, leaf) for k in ('worktrees', 'builds'))
    if c['worktree'] == 'none':
        return (Path.cwd() == Path(c['root'], 'runs', leaf, 'generations', c['generation']) and
                not os.path.lexists(tree) and not os.path.lexists(build))
    common = Path(c['root'], 'repos', c['project'], '.git')
    return (Path.cwd() == tree and clean_tree(tree, common, c['project']) and
            (not os.path.lexists(build) or clean_tree(build, common, c['project'])))


def valid_signature(public_pem, message, signature):
    with tempfile.TemporaryFile() as pub, tempfile.TemporaryFile() as sig:
        for f, value in ((pub, public_pem.encode()), (sig, base64.b64decode(signature, validate=True))):
            f.write(value)
            f.seek(0)
        return subprocess.run(['/usr/bin/openssl', 'dgst', '-sha256', '-verify', f'/dev/fd/{pub.fileno()}',
                               '-signature', f'/dev/fd/{sig.fileno()}'], input=message,
                              pass_fds=(pub.fileno(), sig.fileno()), env={'PATH': '/usr/bin:/bin'},
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=2).returncode == 0


def key_id(public_pem):
    der = ''.join(line for line in public_pem.splitlines() if not line.startswith('-----'))
    return hashlib.sha256(base64.b64decode(der, validate=True)).hexdigest()


def handle(conn, c, child, inspect, public_pem, spent):
    # Only this single-threaded parent reaps child. A dead, not-yet-reaped
    # child still reserves its PID; poll() returning an exit always withdraws.
    conn.settimeout(3)
    with conn.makefile('rb') as stream:
        raw = stream.readline(2048)
        if not raw.endswith(b'\n'):
            return
        req = json.loads(raw)
        p, terminal = req['process'], req['terminal']
        if (spent[0] or p['pid'] != child.pid or terminal != os.environ.get('HC_TERMINAL_ID') or
                child.poll() is not None):
            return
        bound = dict(c, process=p, terminal=terminal, require_idle=True)
        def eligible():
            return (workspace(c) and inspect(bound, os.getpid()) == 'alive' and child.poll() is None)
        if not eligible():
            return
        nonce = secrets.token_hex(32)
        # The key id lets a restarted controller refuse to sign for an owner it cannot serve.
        conn.sendall(f'{nonce} {key_id(public_pem)}\n'.encode())
        signature = stream.readline(256).rstrip(b'\n')
        if (not valid_signature(public_pem, nonce.encode()+b':'+hashlib.sha256(raw).hexdigest().encode(), signature)
                or not eligible()):
            conn.sendall(b'withdrawn\n')
            return
        spent[0] = True  # even an ambiguous receipt never repeats the stop
        child.terminate()  # only TERM to our own direct, unreaped child; never killpg
        conn.sendall(b'sent\n')


def bind_endpoint(listener, directory):
    # Relative UNIX names fit Darwin's sun_path even for long worker roots.
    # Keep the generation FD for cleanup; the session's cwd never changes.
    cwd = os.open('.', os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fchdir(directory)
        mask = os.umask(0o077)
        try:
            listener.bind('idle-owner.sock')
        finally:
            os.umask(mask)
    finally:
        os.fchdir(cwd)
        os.close(cwd)


def supervise(c, command, inspect):
    if sys.platform != 'darwin' or os.getuid() == 0:
        raise ValueError()
    signal.signal(signal.SIGCHLD, signal.SIG_DFL)
    with socket.socket(socket.AF_UNIX) as listener:
        # No pre-unlink or reconnect to an earlier owner's path. bind/close do
        # not touch the terminal history or anything in the checkout.
        directory = os.open(c['directory'], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        bind_endpoint(listener, directory)
        inode = os.stat('idle-owner.sock', dir_fd=directory, follow_symlinks=False).st_ino
        try:
            listener.listen(1)
            listener.settimeout(0.5)
            child = subprocess.Popen(command, close_fds=True)
            spent = [False]
            while child.poll() is None:
                try:
                    conn, _ = listener.accept()
                    with conn:
                        handle(conn, c, child, inspect, c['public_pem'], spent)
                except (OSError, ValueError, KeyError, TypeError, AttributeError, subprocess.SubprocessError):
                    continue
            return child.returncode if child.returncode >= 0 else 128-child.returncode
        finally:
            try:
                if os.stat('idle-owner.sock', dir_fd=directory, follow_symlinks=False).st_ino == inode:
                    os.unlink('idle-owner.sock', dir_fd=directory)
            except FileNotFoundError:
                pass
            finally:
                os.close(directory)


if __name__ == '__main__':
    inspector = {'__name__': 'worker_inspection'}
    exec(compile(sys.argv[1], '<worker-inspection>', 'exec'), inspector)
    sys.exit(supervise(json.loads(sys.argv[2]), sys.argv[3:], inspector['darwin_retirement']))
