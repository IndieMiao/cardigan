#!/usr/bin/env python3
"""Project-account Git entry. Pack stdin/stdout remain binary streams."""
import ctypes
import array
import fcntl
import hashlib
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
        if op in ('snapshot', 'verify-sealed-snapshot'):
            require(path == self.leaves[0])
            if op == 'verify-sealed-snapshot' and not durable_writer_fence(self, path):
                return None
            sha = workspace_snapshot(self, path, r['branch'], r['generation'])
            require(op == 'snapshot' or sha == r['expected'])
            return sha
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


# The storage owner may have retired a dedicated workspace in place. We only
# *inspect* Linux ext4 seals; no chmod, SETFLAGS, mount, or privileged helper.
# fs-verity excludes existing writable fds/mappings as well as future opens.
# IMMUTABLE also protects modes, directory entries and rename. The project has
# no authority to thaw these inodes. No host/SSH lifetime controls the fence.
def inode_flags(fd):
    flags = array.array('l', [0])
    fcntl.ioctl(fd, 0x80006601 | (flags.itemsize << 16), flags, True)  # FS_IOC_GETFLAGS
    return flags[0]


def mount_id(fd):
    return re.search(r'^mnt_id:\s*(\d+)$', Path(f'/proc/self/fdinfo/{fd}').read_text(), re.M)[1]


def sealed_tree(fd, mount, remaining, writable=(), prefix=''):
    info = os.fstat(fd)
    require(mount_id(fd) == mount and remaining[0] > 0)
    remaining[0] -= 1
    flags = inode_flags(fd)
    require(flags & 0x10)  # FS_IMMUTABLE_FL, including the root of the walk
    if not stat.S_ISDIR(info.st_mode):
        require(stat.S_ISREG(info.st_mode) and flags & 0x00100000)  # FS_VERITY_FL
        return
    with os.scandir(fd) as entries:
        for entry in entries:
            name = prefix + entry.name
            if name in writable:
                # Only Git's content-addressed object cache and the replicated
                # backup namespace. Neither is a source of uncommitted files.
                child = os.open(entry.name, DIRECTORY, dir_fd=fd)
                os.close(child)
                continue
            mode = entry.stat(follow_symlinks=False).st_mode
            require(stat.S_ISDIR(mode) or stat.S_ISREG(mode))
            child = os.open(entry.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
            try:
                sealed_tree(child, mount, remaining, writable, name + '/')
            finally:
                os.close(child)


def retained_for_process(workspace, path, process):
    # Storage-owner receipt: this in-place seal is retained until this exact
    # identity exits, including across controller failure. Never created or
    # removed by the project. The receipt alone is NOT filesystem evidence.
    r = workspace.request
    require(re.fullmatch(r'[a-f0-9]{32}', r['generation']))
    locks = native.directory(workspace.root + '/locks', 0)
    try:
        name = 'retired-' + workspace.project + '-' + r['assignment'] + '-' + r['generation'] + '.json'
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=locks)
        try:
            info = os.fstat(fd)
            require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and
                    not info.st_mode & 0o022 and native.acl_safe(fd) and 0 < info.st_size <= 4096)
            def location(target):
                st = os.stat(target, follow_symlinks=False)
                return [st.st_dev, st.st_ino]
            require(json.loads(os.read(fd, 4097)) == dict(policy='ext4-verity-until-exit-v1',
                    project=workspace.project, assignment=r['assignment'], process=process,
                    worktree=location(path), gitdir=location(workspace.repo + '/.git')))
        finally:
            os.close(fd)
    finally:
        os.close(locks)


def verify_storage_seals(workspace, path, mounts):
    remaining = [100000]  # oversized or irregular trees remain observe-only
    for root, is_repo in ((path, False), (workspace.repo, True)):
        fd = workspace.directory(root)
        try:
            if is_repo:
                gitdir = os.open('.git', DIRECTORY, dir_fd=fd)
                os.close(fd)
                fd = gitdir
            mount = mount_id(fd)
            require(mounts.get(mount) == 'ext4')
            sealed_tree(fd, mount, remaining, ('objects', 'refs/cardigan/backups') if is_repo else ())
        finally:
            os.close(fd)


def durable_writer_fence(workspace, path):
    if sys.platform != 'linux' or os.geteuid() == 0:
        return False
    try:
        r = workspace.request
        process = r['process']
        pid = process['pid']
        require(type(pid) is int and pid > 1 and process['uid'] == os.getuid()
                and process['terminal'] == r['generation'] and
                native.identity(process['machine'], pid, r['generation'], process['process_group']) == process)
        retained_for_process(workspace, path, process)
        # We must inspect the same namespace and directory as the old process,
        # not a read-only replacement mounted over its still-writable cwd.
        proc = Path('/proc') / str(pid)
        require(os.path.samefile(proc / 'ns/mnt', '/proc/self/ns/mnt') and
                os.path.samefile(proc / 'root', '/') and os.path.samefile(proc / 'cwd', path))
        for status in (proc / 'status', Path('/proc/self/status')):
            require(int(re.search(r'^CapPrm:\s*([0-9a-f]+)$', status.read_text(), re.M)[1], 16) == 0)
        verify_storage_seals(workspace, path, {line.split()[0]: line.split(' - ')[1].split()[0]
                    for line in Path('/proc/self/mountinfo').read_text().splitlines()})
        return True
    except (OSError, ValueError, KeyError, TypeError, AttributeError, RecursionError):
        return False


def verify_working_bytes(path, entries, sha):
    # Filters, local excludes and Git stat caches must not make an apparently
    # identical tree stand in for bytes absent from the controller backup.
    blobs = {}
    for entry in entries.split('\0'):
        if entry:
            meta, name = entry.split('\t', 1)
            mode, kind, oid = meta.split(' ')
            require(kind == 'blob' and mode in ('100644', '100755'))
            blobs[name] = (mode, oid)
    # Walk only after the whole source is sealed. Refuse empty directories and
    # special entries rather than claim that Git can restore them.
    def visit(directory, prefix=''):
        if prefix:
            require(os.listdir(directory))
        with os.scandir(directory) as children:
            for child in children:
                name = prefix + child.name
                if name == '.git':
                    continue
                info = child.stat(follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    visit(child.path, name + '/')
                    continue
                require(stat.S_ISREG(info.st_mode) and name in blobs)
                mode, oid = blobs.pop(name)
                require((mode == '100755') == bool(info.st_mode & stat.S_IXUSR))
                digest = hashlib.new('sha1' if len(sha) == 40 else 'sha256')
                digest.update(f'blob {info.st_size}\0'.encode())
                with open(child.path, 'rb') as contents:
                    for block in iter(lambda: contents.read(131072), b''):
                        digest.update(block)
                require(digest.hexdigest() == oid)
    visit(path)
    require(not blobs)


def copy_worktree_index(workspace, gitdir, destination):
    # No project-controlled symlinks or devices during the *initial*, still
    # unfenced backup. A linked worktree index must live in this clone.
    directory = workspace.directory(workspace.repo)
    try:
        for part in ('.git', 'worktrees', Path(gitdir).name):
            child = os.open(part, DIRECTORY, dir_fd=directory)
            os.close(directory)
            directory = child
        fd = os.open('index', os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=directory)
        with os.fdopen(fd, 'rb') as src, open(destination, 'wb') as dest:
            info = os.fstat(src.fileno())
            require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid())
            remaining = 64 * 1024 * 1024
            while True:
                chunk = src.read(min(remaining + 1, 131072))
                if not chunk:
                    break
                remaining -= len(chunk)
                require(remaining >= 0)
                dest.write(chunk)
    finally:
        os.close(directory)


def workspace_snapshot(workspace, path, branch, generation):
    """Preserve HEAD, index and working tree without stashing or modifying either.
    A second capture compares trees to the immutable first snapshot, not timestamps.
    """
    require(re.fullmatch(r'agent/[A-Za-z0-9._/-]+', branch) and re.fullmatch(r'[a-f0-9]{32}', generation))
    def git(*args):
        return workspace.git(path, list(args)).rstrip('\n')
    require(git('rev-parse', '--show-toplevel') == path and git('symbolic-ref', 'HEAD') == 'refs/heads/' + branch)
    require(git('rev-parse', '--path-format=absolute', '--git-common-dir') == workspace.repo + '/.git')
    # Ignored user files cannot be assumed disposable or safe to send to the controller.
    require(not git('ls-files', '--others', '--ignored', '--exclude-standard', '-z'))
    # Do not claim that a gitlink or sparse checkout contains the underlying files.
    require(all(entry.startswith('H ') for entry in git('ls-files', '-v', '-z').split('\0') if entry))
    head = git('rev-parse', '--verify', 'HEAD^{commit}')
    index_path = git('rev-parse', '--path-format=absolute', '--git-path', 'index')
    gitdir = git('rev-parse', '--absolute-git-dir')
    require(Path(gitdir).parent == Path(workspace.repo, '.git/worktrees') and index_path == gitdir + '/index')
    with tempfile.TemporaryDirectory() as scratch:
        copy_worktree_index(workspace, gitdir, scratch + '/index')
        workspace.env['GIT_INDEX_FILE'] = scratch + '/index'
        try:
            index = git('write-tree')
            os.unlink(scratch + '/index')
            git('read-tree', index)
            git('add', '-A', '--', '.')
            tree = git('write-tree')
            copy_worktree_index(workspace, gitdir, scratch + '/index')
            require(index == git('write-tree'))
        finally:
            del workspace.env['GIT_INDEX_FILE']
    for candidate in (head, index, tree):
        require(all(not entry.startswith('160000 ') for entry in git('ls-tree', '-r', '-z', candidate).split('\0') if entry))
    require(head == git('rev-parse', 'HEAD'))
    ref = 'refs/cardigan/backups/orphans/' + workspace.request['assignment'] + '/' + generation
    sha = git('for-each-ref', '--format=%(objectname)', ref)
    if workspace.request['operation'] == 'verify-sealed-snapshot':
        require(sha and sha == workspace.request['expected'])
        verify_working_bytes(path, git('ls-tree', '-rz', sha), sha)
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


USAGE_KINDS = ('worktrees', 'builds', 'runs')
USAGE_ENTRIES = 2000000
USAGE_DEPTH = 256


class Tally:
    def __init__(self, device, deadline):
        self.device, self.deadline = device, deadline
        self.entries, self.inodes, self.complete = USAGE_ENTRIES, set(), True

    def spend(self):
        self.entries -= 1
        if self.entries < 0 or time.monotonic() > self.deadline:
            self.complete = False
            return False
        return True


def measure(fd, tally, depth):
    """Allocated bytes below an open directory, like du -s on one file system.
    Never follows a symlink, never leaves the device and never writes."""
    total = 0
    try:
        names = os.listdir(fd)
    except OSError:
        tally.complete = False
        return 0
    for name in names:
        if not tally.spend():
            return total
        try:
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
        except FileNotFoundError:
            continue
        except OSError:
            tally.complete = False
            continue
        if info.st_dev != tally.device:
            tally.complete = False
            continue
        directory = stat.S_ISDIR(info.st_mode)
        if not directory and info.st_nlink > 1:
            if info.st_ino in tally.inodes:
                continue
            tally.inodes.add(info.st_ino)
        total += info.st_blocks * 512
        if not directory:
            continue
        if depth >= USAGE_DEPTH:
            tally.complete = False
            continue
        try:
            child = os.open(name, DIRECTORY, dir_fd=fd)
        except FileNotFoundError:
            continue
        except OSError:
            tally.complete = False
            continue
        try:
            opened = os.fstat(child)
            if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
                tally.complete = False
                continue
            total += measure(child, tally, depth + 1)
        finally:
            os.close(child)
    return total


def subdirectories(fd):
    count = 0
    for name in os.listdir(fd):
        try:
            count += stat.S_ISDIR(os.stat(name, dir_fd=fd, follow_symlinks=False).st_mode)
        except FileNotFoundError:
            pass
    return count


def usage(request):
    """C-666: read-only space report of this project's own worktrees, builds and
    runs leaves plus the volume's free space. It runs as the project account,
    takes no Git lock and touches no other account's directory."""
    project = request['project']
    require(type(project) is str and re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9._-]*', project))
    require(re.fullmatch(r'A-[1-9][0-9]*', request['assignment']))
    deadline = time.monotonic() + request['timeout_ms'] * 0.8 / 1000
    anchor = check_layout(request['root'], project)
    try:
        volume = os.fstatvfs(anchor)
        tally = Tally(os.fstat(anchor).st_dev, deadline)
        reply = dict(free_bytes=volume.f_bavail * volume.f_frsize,
                     total_bytes=volume.f_blocks * volume.f_frsize)
        for kind in USAGE_KINDS:
            reply[kind] = dict(bytes=0, directories=0)
            try:
                parent = os.open(kind, DIRECTORY, dir_fd=anchor)
            except FileNotFoundError:
                continue
            try:
                namespace(parent)
                try:
                    leaf = os.open(project, DIRECTORY, dir_fd=parent)
                except FileNotFoundError:
                    continue
                try:
                    private(leaf)
                    reply[kind] = dict(bytes=measure(leaf, tally, 0), directories=subdirectories(leaf))
                finally:
                    os.close(leaf)
            finally:
                os.close(parent)
        reply['complete'] = tally.complete
        return reply
    finally:
        os.close(anchor)


def main():
    require(len(sys.argv) == 2 and len(sys.argv[1].encode()) <= 65536)
    request = json.loads(sys.argv[1])
    require(type(request['timeout_ms']) is int and 0 < request['timeout_ms'] <= 2147483647)
    os.umask(0o077)
    if request['operation'] == 'usage':
        print(json.dumps(usage(request)))
        return
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
