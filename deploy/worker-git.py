#!/usr/bin/env python3
"""Project-account Git entry. Pack stdin/stdout remain binary streams."""
import ctypes
import importlib.util
import json
import os
import pwd
import re
import signal
import selectors
import time
import tempfile
import stat
import subprocess
import sys
import uuid
from pathlib import Path

spec = importlib.util.spec_from_file_location('native', Path(__file__).with_name('worker-primitives.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)
DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def require(ok):
    if not ok:
        raise ValueError('worker_git_rejected')


def private(fd):
    info = os.fstat(fd)
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
            and info.st_gid == os.getgid() and stat.S_IMODE(info.st_mode) == 0o700
            and native.acl_safe(fd))


def namespace(fd):
    info = os.fstat(fd)
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0
            and info.st_gid == os.getgid() and stat.S_IMODE(info.st_mode) == 0o750
            and native.acl_safe(fd))


def check_layout(root, project):
    """Shared readiness/IO contract: administrator parents, private project leaves."""
    require(re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9._-]*', project))
    anchor = native.directory(root, 0)
    try:
        namespace(anchor)
        for kind in ('repos', 'worktrees', 'builds'):
            parent = os.open(kind, DIRECTORY, dir_fd=anchor)
            try:
                namespace(parent)
                leaf = os.open(project, DIRECTORY, dir_fd=parent)
                try:
                    private(leaf)
                finally:
                    os.close(leaf)
            finally:
                os.close(parent)
        return anchor
    except Exception:
        os.close(anchor)
        raise


def publish(source, name, destination, target):
    """Atomic no-replace publication of the staged .git into the installed leaf."""
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == 'darwin':
        result = libc.renameatx_np(source, name.encode(), destination, target.encode(), 4)
    elif sys.platform == 'linux':
        result = libc.renameat2(source, name.encode(), destination, target.encode(), 1)
    else:
        raise ValueError('unsupported_platform')
    if result != 0:
        raise OSError(ctypes.get_errno(), 'clone_publication_failed')


class Workspace:
    def __init__(self, request):
        self.request = request
        self.root = request['root']
        self.project = request['project']
        require(re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9._-]*', self.project))
        require(re.fullmatch(r'A-[1-9][0-9]*', request['assignment']))
        self.anchor = check_layout(self.root, self.project)
        self.repo = f'{self.root}/repos/{self.project}'
        self.leaves = [f'{self.root}/{kind}/{self.project}/{request["assignment"]}'
                       for kind in ('worktrees', 'builds')]
        self.env = dict(PATH=request['path'], HOME=pwd.getpwuid(os.getuid()).pw_dir,
                        LC_ALL='C', LANGUAGE='C', GIT_CONFIG_NOSYSTEM='1',
                        GIT_CONFIG_GLOBAL='/dev/null', GIT_NO_REPLACE_OBJECTS='1',
                        GIT_NO_LAZY_FETCH='1', GIT_TERMINAL_PROMPT='0', GIT_LFS_SKIP_SMUDGE='1')
        self.safety = ['-c', 'protocol.allow=never', '-c', 'core.hooksPath=/dev/null',
                       '-c', 'transfer.fsckObjects=true', '-c', 'core.fsmonitor=false',
                       '-c', 'receive.fsckObjects=true', '-c', 'fetch.fsckObjects=true',
                       '-c', 'credential.helper=', '-c', 'submodule.recurse=false']
        lock_path = f'{self.root}/locks/git.lock'
        self.lock = os.open(lock_path, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK)
        native.protected_lock(self.lock, lock_path, request['timeout_ms'])

    def allowed(self, path):
        require(type(path) is str and os.path.normpath(path) == path)
        stage = f'{self.repo}/.clone-{self.project}-'
        require(path == self.repo or path in self.leaves or
                (path.startswith(stage) and re.fullmatch(r'[a-f0-9]{32}', path[len(stage):])))

    def directory(self, path, create=False):
        self.allowed(path)
        relative = Path(path).relative_to(self.root)
        fd = os.dup(self.anchor)
        try:
            for index, part in enumerate(relative.parts):
                if create and index >= 2:
                    try:
                        os.mkdir(part, 0o700, dir_fd=fd)
                    except FileExistsError:
                        pass
                child = os.open(part, DIRECTORY, dir_fd=fd)
                try:
                    (namespace if index == 0 else private)(child)
                except Exception:
                    os.close(child)
                    raise
                os.close(fd)
                fd = child
            return fd
        except Exception:
            os.close(fd)
            raise

    def git(self, directory, args, stream=False):
        fd = self.directory(directory)
        try:
            os.fchdir(fd)
            # Workspace Git is always executed by this project account, never the host.
            command = ['git', *self.safety, *args]
            # The Git child inherits the lock description. SIGKILL of the SSH/helper
            # cannot release a lock while that child still mutates the repository.
            process = subprocess.Popen(command, env=self.env, stderr=subprocess.DEVNULL,
                                       stdout=None if stream else subprocess.PIPE,
                                       pass_fds=(self.lock,), start_new_session=True)
            def stop(*_):
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            previous = {sig: signal.signal(sig, stop) for sig in (signal.SIGHUP, signal.SIGTERM)}
            try:
                deadline = time.monotonic() + self.request['timeout_ms'] / 1000
                output = bytearray()
                if not stream:
                    with selectors.DefaultSelector() as selector:
                        selector.register(process.stdout, selectors.EVENT_READ)
                        while True:
                            remaining = deadline - time.monotonic()
                            require(remaining > 0 and selector.select(remaining))
                            block = os.read(process.stdout.fileno(), 65536)
                            if not block:
                                break
                            output.extend(block)
                            require(len(output) <= 4 * 1024 * 1024)
                require(process.wait(timeout=max(0, deadline - time.monotonic())) == 0)
                return None if stream else output.decode()
            finally:
                stop()
                process.wait()
                for sig, handler in previous.items():
                    signal.signal(sig, handler)
        finally:
            os.close(fd)

    def validate(self, path):
        require(self.git(path, ['rev-parse', '--show-toplevel']).strip() == path)
        require(self.git(path, ['rev-parse', '--show-object-format']).strip() == self.request['format'])
        require(self.git(path, ['config', '--local', '--get', 'remote.origin.url']).strip() == self.request['source'])

    def unpublished(self, fd):
        # Preserve abandoned stages, but never initialize over unrelated files.
        require(all(re.fullmatch(r'\.clone-' + re.escape(self.project) + r'-[a-f0-9]{32}', name)
                    for name in os.listdir(fd)))

    def operate(self):
        r, op = self.request, self.request['operation']
        path = r.get('repository', self.repo)
        if op == 'snapshot':
            require(path == self.leaves[0])
            return workspace_snapshot(self, path, r['branch'], r['generation'])
        if op == 'check':
            return True  # __init__ has checked the same paths used by Git operations.
        if op == 'directories':
            allowed = [f'{self.root}/repos', *[f'{self.root}/{kind}/{self.project}' for kind in ('worktrees', 'builds', 'checks')]]
            require(path in allowed)
            try:
                fd = native.directory(path, 0 if path == f'{self.root}/repos' else os.getuid())
            except FileNotFoundError:
                return []
            try:
                if path == f'{self.root}/repos':
                    namespace(fd)
                    return [self.repo] if self.project in os.listdir(fd) else []
                private(fd)
                entries = []
                for name in os.listdir(fd):
                    info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                    require(not stat.S_ISLNK(info.st_mode))
                    if stat.S_ISDIR(info.st_mode):
                        entries.append(path + '/' + name)
                return sorted(entries)
            finally:
                os.close(fd)
        if op == 'remove-empty' and path in [str(Path(p).parent) for p in self.leaves]:
            return None  # Keep the project's namespace for other Assignments.
        self.allowed(path)
        if op == 'stage':
            stage = f'{self.repo}/.clone-{self.project}-{uuid.uuid4().hex}'
            repos = self.directory(self.repo)
            try:
                self.unpublished(repos)
                os.mkdir(Path(stage).name, 0o700, dir_fd=repos)  # Exclusive; never replace a failed stage.
            finally:
                os.close(repos)
            require(r['format'] in ('sha1', 'sha256') and r['source'] == f'cardigan-central:{self.project}')
            self.git(stage, ['init', '--template=', '--object-format=' + r['format']])
            self.git(stage, ['config', '--local', 'remote.origin.url', r['source']])
            return stage
        if op in ('validate', 'publish', 'receive-pack', 'upload-pack'):
            self.validate(path)
            if op == 'publish':
                require(path != self.repo)
                require(self.git(path, ['for-each-ref', '--format=%(objectname)', 'refs/remotes/origin/']).strip())
                repos = self.directory(self.repo)
                try:
                    staged = self.directory(path)
                    try:
                        self.unpublished(repos)
                        require(os.listdir(staged) == ['.git'])
                        gitdir = os.open('.git', DIRECTORY, dir_fd=staged)
                        try:
                            private(gitdir)
                        finally:
                            os.close(gitdir)
                        publish(staged, '.git', repos, '.git')
                    finally:
                        os.close(staged)
                finally:
                    os.close(repos)
                os.rmdir(path)
                self.validate(self.repo)
            elif op in ('receive-pack', 'upload-pack'):
                return self.git(path, [op, '.'], True)
            return None
        if op == 'git':
            args = r['args']
            require(type(args) is list and all(type(a) is str and '\x00' not in a for a in args))
            at = args.index('-C')
            self.allowed(args[at + 1])
            return self.git(args[at + 1], args[:at] + args[at + 2:])
        if op == 'exists':
            try:
                fd = self.directory(path)
            except FileNotFoundError:
                return False
            try:
                if path == self.repo:
                    try:
                        gitdir = os.open('.git', DIRECTORY, dir_fd=fd)
                    except FileNotFoundError:
                        self.unpublished(fd)
                        return False
                    try:
                        private(gitdir)
                    finally:
                        os.close(gitdir)
                return True
            finally:
                os.close(fd)
        if op == 'prepare':
            require(path in self.leaves)
            os.close(self.directory(path, True))
            return None
        if op == 'remove-empty':
            require(path in self.leaves)
            try:
                fd = self.directory(path)
            except FileNotFoundError:
                return None
            os.close(fd)
            os.rmdir(path)
            return None
        raise ValueError('unsupported_operation')


def workspace_snapshot(workspace, path, branch, generation):
    """Preserve HEAD, index and working tree without stashing or modifying either.
    A second capture compares trees to the immutable first snapshot, not timestamps.
    """
    require(re.fullmatch(r'agent/[A-Za-z0-9._/-]+', branch) and re.fullmatch(r'[a-f0-9]{32}', generation))
    def git(*args):
        return workspace.git(path, list(args)).rstrip('\n')
    require(git('rev-parse', '--show-toplevel') == path and git('symbolic-ref', 'HEAD') == 'refs/heads/' + branch)
    require(git('rev-parse', '--path-format=absolute', '--git-common-dir') == workspace.repo + '/.git')
    # Do not claim that a gitlink or sparse checkout contains the underlying files.
    require(all(entry.startswith('H ') for entry in git('ls-files', '-v', '-z').split('\0') if entry))
    head = git('rev-parse', '--verify', 'HEAD^{commit}')
    index = git('write-tree')
    with tempfile.TemporaryDirectory() as scratch:
        workspace.env['GIT_INDEX_FILE'] = scratch + '/index'
        try:
            git('read-tree', index)
            git('add', '-A', '--', '.')
            tree = git('write-tree')
        finally:
            del workspace.env['GIT_INDEX_FILE']
    for candidate in (head, index, tree):
        require(all(not entry.startswith('160000 ') for entry in git('ls-tree', '-r', '-z', candidate).split('\0') if entry))
    require(head == git('rev-parse', 'HEAD') and index == git('write-tree'))
    ref = 'refs/cardigan/backups/orphans/' + workspace.request['assignment'] + '/' + generation
    sha = git('for-each-ref', '--format=%(objectname)', ref)
    if not sha:
        def commit(tree, *parents):
            return git('-c', 'user.name=Cardigan', '-c', 'user.email=backup@cardigan.invalid',
                       'commit-tree', tree, *parents, '-m', 'Orphan workspace backup')
        staged = commit(index, '-p', head)
        sha = commit(tree, '-p', head, '-p', staged)
        git('update-ref', ref, sha, '0' * len(sha))
    require(git('rev-parse', ref) == sha and git('rev-parse', ref + '^{tree}') == tree
            and git('rev-parse', ref + '^1') == head and git('rev-parse', ref + '^2^{tree}') == index)
    return sha


def main():
    require(len(sys.argv) == 2 and len(sys.argv[1].encode()) <= 65536)
    request = json.loads(sys.argv[1])
    require(type(request['timeout_ms']) is int and 0 < request['timeout_ms'] <= 2147483647)
    os.umask(0o077)
    workspace = Workspace(request)
    try:
        reply = workspace.operate()
        if request['operation'] not in ('receive-pack', 'upload-pack'):
            print(json.dumps(reply))
    finally:
        os.close(workspace.lock)
        os.close(workspace.anchor)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('worker_git_rejected', file=sys.stderr)
        sys.exit(75)
