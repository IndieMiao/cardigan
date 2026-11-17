#!/usr/bin/env python3
"""Fixed stdin-only launch publication protocol. Never print payloads/errors."""
import fcntl
import hashlib
import io
import importlib.util
import json
import os
import pwd
import re
import signal
import stat
import sys
import time
import uuid
from pathlib import Path

spec = importlib.util.spec_from_file_location('native', Path(__file__).with_name('worker-primitives.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)
DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
TRAILER = b'\nCARDIGAN-PUBLISH-1\n'
FILES = re.compile(r'(core\.md|first\.md|launch\.sh|launch\.json|token|secrets\.env|codex/config\.toml|pi/(mcp\.json|trust\.json|extensions/cardigan-context-usage\.js)|mcp\.json|cardigan-assignment\.[A-Za-z0-9_.-]+\.claude-settings\.json)')


def require(ok):
    if not ok:
        raise ValueError('publication_rejected')


def private(fd, mode, regular=False):
    info = os.fstat(fd)
    require(info.st_uid == os.getuid() and info.st_gid == os.getgid()
            and stat.S_IMODE(info.st_mode) == mode and native.acl_safe(fd))
    require((stat.S_ISREG(info.st_mode) and info.st_nlink == 1) if regular else stat.S_ISDIR(info.st_mode))


def child(parent, name, create=False):
    require(re.fullmatch(r'[A-Za-z0-9_.-]+', name) and name not in ('.', '..'))
    if create:
        try:
            os.mkdir(name, 0o700, dir_fd=parent)
        except FileExistsError:
            pass
    fd = os.open(name, DIRECTORY, dir_fd=parent)
    try:
        private(fd, 0o700)
        return fd
    except Exception:
        os.close(fd)
        raise


def read_file(parent, name, maximum):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    try:
        private(fd, 0o600, True)
        require(os.fstat(fd).st_size <= maximum)
        with os.fdopen(os.dup(fd), 'rb') as file:
            data = file.read(maximum + 1)
        require(len(data) <= maximum)
        return data
    finally:
        os.close(fd)


def exists(parent, name):
    try:
        info = os.stat(name, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        return False
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1)
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    try:
        private(fd, 0o600, True)
    finally:
        os.close(fd)
    return True


def write_file(parent, name, data, mode=0o600):
    # Even an existing destination is checked before replacement. Never follow it.
    if exists(parent, name):
        read_file(parent, name, len(data))
    temporary = '.publish-' + uuid.uuid4().hex
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
    try:
        private(fd, 0o600, True)
        with os.fdopen(os.dup(fd), 'wb') as file:
            file.write(data)
            file.flush()
        os.fchmod(fd, mode)
        os.fsync(fd)
        os.rename(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)
        os.fsync(parent)
    finally:
        os.close(fd)
        try:
            os.unlink(temporary, dir_fd=parent)
        except FileNotFoundError:
            pass


def limits(value):
    names = {'header_max_bytes', 'file_max_bytes', 'batch_max_bytes', 'timeout_ms'}
    require(type(value) is dict and set(value) == names)
    require(all(type(n) is int and 0 < n <= 9007199254740991 for n in value.values()))
    require(value['file_max_bytes'] <= value['batch_max_bytes'] and value['timeout_ms'] <= 2147483647)
    return value


def manifest(source, policy):
    line = source.readline(policy['header_max_bytes'] + 1)
    require(len(line) <= policy['header_max_bytes'] and line.endswith(b'\n'))
    header = json.loads(line, object_pairs_hook=unique)
    require(set(header) == {'version', 'operation', 'root', 'project', 'assignment', 'run', 'generation', 'target', 'files'} | ({'worktree'} if header.get('operation') == 'inspect' else set()))
    require(type(header['version']) is int and header['version'] == 1 and header['operation'] in ('publish', 'commit', 'clear', 'status', 'inspect'))
    for key, pattern in [('project', r'[A-Za-z0-9_][A-Za-z0-9._-]*'), ('assignment', r'A-[1-9][0-9]*'),
                         ('run', r'R-[1-9][0-9]*'), ('generation', r'[a-f0-9]{32}')]:
        require(type(header[key]) is str and re.fullmatch(pattern, header[key]))
    require(re.fullmatch(r'[a-f0-9]{64}', header['target']))
    require(type(header['files']) is list)
    names, total, secret_seen = set(), 0, False
    for entry in header['files']:
        name = entry['name']
        require(type(name) is str and FILES.fullmatch(name) and name not in names)
        names.add(name)
        secret = name in ('token', 'secrets.env')
        require(set(entry) == ({'name', 'size', 'mode'} if secret else {'name', 'size', 'mode', 'sha256'}))
        require(not secret_seen or secret)
        secret_seen |= secret
        require(type(entry['size']) is int and 0 <= entry['size'] <= policy['file_max_bytes'])
        require(entry['mode'] == (0o700 if name == 'launch.sh' else 0o600))
        require(entry.get('sha256') is None if secret else bool(re.fullmatch(r'[a-f0-9]{64}', entry.get('sha256', ''))))
        total += entry['size']
        require(total <= policy['batch_max_bytes'])
    require(header['operation'] == 'publish' or not names)
    require(header['operation'] != 'publish' or {'launch.sh', 'token'} <= names)
    return header


def unique(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result)
        result[key] = value
    return result


def exact(source, size):
    data = source.read(size)
    require(len(data) == size)
    return data


def binding(header):
    return {key: header[key] for key in ('version', 'project', 'assignment', 'run', 'generation', 'target')}


def inode(fd):
    info = os.fstat(fd)
    return [info.st_dev, info.st_ino]


def verify_lock(parent, lock):
    private(lock, 0o600, True)
    require(os.fstat(lock).st_size == 0)
    current = os.stat('.lock', dir_fd=parent, follow_symlinks=False)
    require(inode(lock) == [current.st_dev, current.st_ino])


class Namespace:
    """Keep the project anchor and durable generation-to-directory binding."""
    def __init__(self, root, header, check_root):
        self.root, self.header, self.check_root = root, header, check_root
        self.assignment = child(root, header['assignment'], True)

    def verify(self, generation, generation_lock, register=False):
        verify_lock(generation, generation_lock)
        self.check_root()
        private(self.root, 0o700)
        assignment = child(self.root, self.header['assignment'])
        try:
            require(inode(assignment) == inode(self.assignment))
            generations = child(assignment, 'generations')
            try:
                current = child(generations, self.header['generation'])
                try:
                    require(inode(current) == inode(generation))
                    directories = [inode(assignment), inode(generations), inode(current)]
                finally:
                    os.close(current)
            finally:
                os.close(generations)
        finally:
            os.close(assignment)
        # This short project-level lock only protects binding registration;
        # payload transfer still serializes on the exact generation's lock.
        lock = os.open('.publication-lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=self.root)
        try:
            private(lock, 0o600, True)
            require(os.fstat(lock).st_size == 0)
            fcntl.flock(lock, fcntl.LOCK_EX)
            require(inode(lock) == [os.stat('.publication-lock', dir_fd=self.root, follow_symlinks=False).st_dev,
                                    os.stat('.publication-lock', dir_fd=self.root, follow_symlinks=False).st_ino])
            name = '.launch-' + self.header['generation']
            expected = dict(binding=binding(self.header), directories=directories, lock=inode(generation_lock))
            if exists(self.root, name):
                require(json.loads(read_file(self.root, name, len(json.dumps(expected).encode()))) == expected)
            else:
                require(register)
                # A replaced namespace lock cannot overwrite an existing binding.
                # A crash leaving a partial binding fails closed on the next read.
                fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=self.root)
                try:
                    private(fd, 0o600, True)
                    with os.fdopen(os.dup(fd), 'wb') as file:
                        file.write(json.dumps(expected).encode())
                        file.flush()
                    os.fsync(fd)
                    os.fsync(self.root)
                finally:
                    os.close(fd)
            verify_lock(generation, generation_lock)
        finally:
            os.close(lock)

    def close(self):
        os.close(self.assignment)
        os.close(self.root)


def operate(namespace, header, source, policy):
    """Assignment FD has already been pinned beneath the protected namespace."""
    assignment = namespace.assignment
    generations = child(assignment, 'generations', True)
    try:
        # clear creates a tombstone even if a delayed publish has not arrived yet.
        generation = child(generations, header['generation'], True)
    finally:
        os.close(generations)
    lock = None
    receiving_started = False
    try:
        lock = os.open('.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=generation)
        verify_lock(generation, lock)
        fcntl.flock(lock, fcntl.LOCK_EX)
        namespace.verify(generation, lock, register=True)
        identity = binding(header)
        if exists(generation, 'identity'):
            require(json.loads(read_file(generation, 'identity', policy['header_max_bytes'])) == identity)
        else:
            write_file(generation, 'identity', json.dumps(identity).encode())
        operation = header['operation']
        if operation == 'publish':
            require(not any(exists(generation, name) for name in ('revoked', 'published', 'receiving')))
            write_file(generation, 'receiving', b'')
            receiving_started = True
            for entry in header['files']:
                data = exact(source, entry['size'])
                namespace.verify(generation, lock)
                require(not exists(generation, 'revoked'))
                if entry.get('sha256'):
                    require(hashlib.sha256(data).hexdigest() == entry['sha256'])
                parent = os.dup(generation)
                try:
                    parts = entry['name'].split('/')
                    for part in parts[:-1]:
                        next_fd = child(parent, part, True)
                        os.close(parent)
                        parent = next_fd
                    write_file(parent, parts[-1], data, entry['mode'])
                finally:
                    os.close(parent)
        require(exact(source, len(TRAILER)) == TRAILER and source.read(1) == b'')
        namespace.verify(generation, lock)
        if operation == 'publish':
            require(not exists(generation, 'revoked'))
            write_file(generation, 'published', b'')
        elif operation == 'commit':
            require(exists(generation, 'published') and not exists(generation, 'revoked') and not exists(generation, 'running'))
            write_file(generation, 'start', json.dumps(identity).encode())
        elif operation == 'clear':
            write_file(generation, 'revoked', b'')
            for name in ('token', 'secrets.env', 'start'):
                if exists(generation, name):
                    read_file(generation, name, max(policy['header_max_bytes'], policy['file_max_bytes']))
                    os.unlink(name, dir_fd=generation)
            os.fsync(generation)
        extra = {}
        if operation == 'inspect':
            path = header['worktree']
            expected = str(Path(header['root']).parent.parent / 'worktrees' / header['project'] / header['assignment'])
            require(path == expected or path.startswith(expected + '/'))
            workspace = native.directory(path, os.getuid(), private=True)
            try:
                require(os.path.realpath(path) == path and os.path.samefile(path, workspace))
                extra['worktree'] = path
            finally:
                os.close(workspace)
        process = json.loads(read_file(generation, 'process', policy['header_max_bytes'])) if exists(generation, 'process') else None
        observed = 'unknown'
        if process:
            actual = native.identity(process['machine'], process['pid'], process['terminal'], process['process_group'])
            if actual:
                observed = 'alive' if actual == process else 'exited'
            else:
                try:
                    os.kill(process['pid'], 0)
                except ProcessLookupError:
                    observed = 'exited'
        phase = next((name for name in ('revoked', 'running', 'start', 'published', 'receiving') if exists(generation, name)), 'empty')
        namespace.verify(generation, lock)
        return dict(identity, phase=phase, process=process, observed=observed, **extra)
    except Exception:
        # Revoke the pinned generation even when its canonical name was swapped.
        # Never report success or redirect cleanup into the replacement.
        if receiving_started:
            write_file(generation, 'revoked', b'')
            for name in ('token', 'secrets.env', 'start', 'published'):
                if exists(generation, name):
                    os.unlink(name, dir_fd=generation)
            os.fsync(generation)
        raise
    finally:
        if lock is not None:
            os.close(lock)
        os.close(generation)


def namespace(header):
    root_path = header['root']
    # All namespace parents are installed by the administrator. The account
    # can create Assignment leaves, but cannot replace its project's namespace.
    parent = native.directory(str(Path(root_path).parent), 0)
    try:
        root = os.open(Path(root_path).name, DIRECTORY, dir_fd=parent)
    finally:
        os.close(parent)
    def check_root():
        parent = native.directory(str(Path(root_path).parent), 0)
        try:
            current = os.open(Path(root_path).name, DIRECTORY, dir_fd=parent)
            try:
                require(inode(current) == inode(root))
            finally:
                os.close(current)
        finally:
            os.close(parent)
    try:
        private(root, 0o700)
        return Namespace(root, header, check_root)
    except Exception:
        os.close(root)
        raise


def run_worker(namespace, header, policy):
    assignment = namespace.assignment
    generations = child(assignment, 'generations')
    try:
        generation = child(generations, header['generation'])
    finally:
        os.close(generations)
    lock = os.open('.lock', os.O_RDWR | os.O_NOFOLLOW, dir_fd=generation)
    try:
        verify_lock(generation, lock)
        process = native.identity(header['target'], os.getpid(), header['generation'], os.getpgrp())
        require(process is not None and process['uid'] == os.getuid())
        fcntl.flock(lock, fcntl.LOCK_EX)
        namespace.verify(generation, lock)
        require(json.loads(read_file(generation, 'identity', policy['header_max_bytes'])) == binding(header))
        require(not exists(generation, 'process'))
        write_file(generation, 'process', json.dumps(process).encode())
        fcntl.flock(lock, fcntl.LOCK_UN)
        # Preserve the existing wrapper's 1200 x 0.1s sentinel wait policy.
        for _ in range(1200):
            fcntl.flock(lock, fcntl.LOCK_EX)
            namespace.verify(generation, lock)
            require(not exists(generation, 'revoked'))
            if exists(generation, 'start'):
                break
            fcntl.flock(lock, fcntl.LOCK_UN)
            time.sleep(0.1)
        else:
            raise TimeoutError()
        require(exists(generation, 'published'))
        require(json.loads(read_file(generation, 'start', policy['header_max_bytes'])) == binding(header))
        launch = json.loads(read_file(generation, 'launch.json', policy['file_max_bytes']))
        token_bytes = read_file(generation, 'token', policy['file_max_bytes'])
        os.unlink('token', dir_fd=generation)
        token = token_bytes.decode().strip()
        secret = {}
        if exists(generation, 'secrets.env'):
            secret_bytes = read_file(generation, 'secrets.env', policy['file_max_bytes'])
            os.unlink('secrets.env', dir_fd=generation)
            secret = json.loads(secret_bytes)
        require(token and all(re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', k) and type(v) is str for k, v in secret.items()))
        first = read_file(generation, 'first.md', policy['file_max_bytes']).decode()
        sessions = child(assignment, 'sessions', True)
        try:
            os.mkdir(header['generation'], 0o700, dir_fd=sessions)
            session = child(sessions, header['generation'])
        finally:
            os.close(sessions)
        try:
            harness = launch['harness']
            name = {'claude-code': 'claude', 'codex': 'codex', 'pi': 'pi'}[harness]
            home = child(session, name, True)
            try:
                if harness == 'claude-code':
                    write_file(home, 'settings.json', json.dumps(dict(theme='dark', skipDangerousModePermissionPrompt=True, autoMemoryEnabled=False)).encode())
                    write_file(home, '.claude.json', json.dumps(dict(hasCompletedOnboarding=True, lastOnboardingVersion='2.1.318', projects={launch['cwd']: dict(hasTrustDialogAccepted=True)} if launch['trust_worktree'] else {})).encode())
                else:
                    source = child(generation, name)
                    try:
                        for filename in (['config.toml'] if harness == 'codex' else ['mcp.json', 'trust.json']):
                            if exists(source, filename):
                                write_file(home, filename, read_file(source, filename, policy['file_max_bytes']))
                        if harness == 'pi':
                            src = child(source, 'extensions')
                            dst = child(home, 'extensions', True)
                            try:
                                write_file(dst, 'cardigan-context-usage.js', read_file(src, 'cardigan-context-usage.js', policy['file_max_bytes']))
                            finally:
                                os.close(src)
                                os.close(dst)
                    finally:
                        os.close(source)
            finally:
                os.close(home)
        finally:
            os.close(session)
        namespace.verify(generation, lock)
        os.unlink('start', dir_fd=generation)
        write_file(generation, 'running', b'')
        env = dict(os.environ, **launch['env'], **secret, MCP_TOKEN=token)
        env['HOME'] = pwd.getpwuid(os.getuid()).pw_dir
        # Runtime defaults must not send project data to a cross-account temp/cache.
        for name in ('temporary', 'cache'):
            os.close(child(assignment, name, True))
        base = Path(header['root']) / header['assignment']
        env.update(TMPDIR=str(base / 'temporary'), TMP=str(base / 'temporary'), TEMP=str(base / 'temporary'),
                   XDG_CACHE_HOME=str(base / 'cache'), npm_config_cache=str(base / 'cache' / 'npm'),
                   npm_config_store_dir=str(base / 'cache' / 'pnpm'), XDG_CONFIG_HOME=str(Path(env['HOME']) / '.config'),
                   XDG_DATA_HOME=str(Path(env['HOME']) / '.local/share'), XDG_STATE_HOME=str(Path(env['HOME']) / '.local/state'))
        env.pop('GIT_CONFIG_PARAMETERS', None)
        os.chdir(launch['cwd'])
        os.nice(launch['nice'])
    finally:
        os.close(lock)
        os.close(generation)
    os.execvpe(launch['command'], [launch['command'], *launch['args'], first], env)


def main():
    policy = limits(json.loads(sys.argv[1]))
    running = len(sys.argv) == 4 and sys.argv[2] == 'run'
    if running:
        header = manifest(io.BytesIO((sys.argv[3] + '\n').encode()), policy)
    else:
        signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(TimeoutError()))
        signal.setitimer(signal.ITIMER_REAL, policy['timeout_ms'] / 1000)
        header = manifest(sys.stdin.buffer, policy)
    assignment = namespace(header)
    try:
        if running:
            run_worker(assignment, header, policy)
        else:
            response = operate(assignment, header, sys.stdin.buffer, policy)
            sys.stdout.write(json.dumps(response) + '\n')
    finally:
        assignment.close()


if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.stderr.write('worker_publication_rejected\n')
        sys.exit(1)
