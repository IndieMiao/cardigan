"""Synthetic worker observations for the actual onboarding program; no sudo/SSH/host IO."""
import atexit
import errno
import grp
import json
import os
import pathlib
import platform
import pwd
import stat
import subprocess
import sys
import types

request = json.loads(sys.argv[1])
scenario = request.get('fixture', 'safe')
uid, gid = request['uid'], request['gid']
user, home, root = request['user'], request['home'], request['root']
if request['step'] == 'account':
    platform.system = lambda: 'Linux'
    platform.machine = lambda: 'x86_64'
    os.getuid = lambda: uid
    os.geteuid = lambda: 0 if scenario == 'effective-root' else uid
    os.getgid = os.getegid = lambda: gid
    os.getgroups = lambda: [gid]
    os.getgrouplist = lambda *args: [gid]
    account = types.SimpleNamespace(pw_name=user, pw_uid=uid, pw_gid=gid, pw_dir=home)
    pwd.getpwuid = lambda _: account
    pwd.getpwall = lambda: [account]
    grp.getgrgid = lambda _: types.SimpleNamespace(gr_name=user, gr_mem=[])

    def policy(command, **kwargs):
        assert command == ['/usr/bin/sudo', '-n', '-l']
        assert kwargs['stdin'] == subprocess.DEVNULL
        assert kwargs['env']['LC_ALL'] == 'C' and kwargs['timeout'] > 0
        if scenario == 'missing':
            raise FileNotFoundError('SECRET')
        if scenario == 'timeout':
            raise subprocess.TimeoutExpired(command, 1, output='SECRET')
        observations = {
            'safe': (1, f'User {user} is not allowed to run sudo on fixture.\n'),
            'safe-alternate': (1, f'Sorry, user {user} may not run sudo on fixture.\n'),
            'safe-no-entry': (1, f'{user} is not in the sudoers file.\n'),
            'allowed': (0, '(ALL) NOPASSWD: ALL\n'),
            'allowed-command': (0, '(root) /usr/bin/id\n'),
            'password': (1, 'sudo: a password is required\n'),
            'unknown': (1, 'SECRET policy unavailable\n'),
            'wrong-user': (1, 'User someone_else is not allowed to run sudo on fixture.\n'),
            'exit-zero-denial': (0, f'User {user} is not allowed to run sudo on fixture.\n'),
        }
        code, message = observations[scenario]
        return types.SimpleNamespace(returncode=code, stdout=b'', stderr=message.encode())
    subprocess.run = policy
else:
    facts, descriptors, reads = {}, {}, []

    def entry(path, owner=0, group=gid, mode=0o750, regular=False):
        # All shared ancestors belong to root and have ordinary traversal permissions.
        for parent in reversed(pathlib.PurePosixPath(path).parents):
            facts.setdefault(str(parent), types.SimpleNamespace(st_uid=0, st_gid=0,
                st_mode=stat.S_IFDIR | 0o755, st_nlink=2))
        facts[path] = types.SimpleNamespace(st_uid=owner, st_gid=group,
            st_mode=(stat.S_IFREG if regular else stat.S_IFDIR) | mode, st_nlink=1 if regular else 2)

    for path in (home, root, root + '/locks', root + '/libexec'):
        entry(path)
    for name in ('.local', '.local/bin', '.ssh'):
        entry(home + '/' + name)
    entry(home + '/.ssh/authorized_keys', mode=0o640, regular=True)
    for name in ('.config', '.cache', '.local/state', '.local/share'):
        entry(home + '/' + name, uid, mode=0o700)
    for name in ('runs', 'repos', 'worktrees', 'builds'):
        entry(root + '/' + name)
        entry(root + '/' + name + '/' + request['project'], uid, mode=0o700)
    for name in ('cache', 'generated', 'evidence', 'temporary'):
        entry(root + '/' + name, uid, mode=0o700)
    for name in ('git', 'tests'):
        entry(root + '/locks/' + name + '.lock', mode=0o660, regular=True)
    for path in request.get('helper_contents', {}):
        entry(path, mode=0o750, regular=True)

    if scenario.startswith('private:'):
        facts[home + '/' + scenario.split(':', 1)[1]].st_mode = stat.S_IFDIR | 0o777
    if scenario == 'ssh-owned':
        facts[home + '/.ssh'].st_uid = uid
    if scenario == 'keys-owned':
        facts[home + '/.ssh/authorized_keys'].st_uid = uid
    if scenario == 'local-owned':
        facts[home + '/.local'].st_uid = uid
    if scenario == 'keys-linked':
        facts[home + '/.ssh/authorized_keys'].st_nlink = 2
    if scenario == 'missing-private':
        del facts[home + '/.local/share']

    def opened(path, flags, *, dir_fd=None):
        path = str(path)
        if dir_fd is not None:
            assert '/' not in path and flags & os.O_NOFOLLOW
            path = str(pathlib.PurePosixPath(descriptors[dir_fd]) / path)
        if scenario == 'symlink' and path == home + '/.ssh':
            raise OSError(errno.ELOOP, 'SECRET')
        if path not in facts:
            raise FileNotFoundError('SECRET')
        if flags & os.O_DIRECTORY:
            assert stat.S_ISDIR(facts[path].st_mode)
        handle = max(descriptors, default=1000) + 1
        descriptors[handle] = path
        reads.append(path)
        return handle

    def attributes(fd):
        path = descriptors[fd]
        if scenario == 'acl-error':
            raise PermissionError('SECRET')
        if scenario == 'lock-acl' and path == root + '/locks/git.lock':
            return ['system.posix_acl_access']
        if scenario == 'ancestor-acl' and path == root:
            return ['system.posix_acl_default']
        if scenario == 'keys-acl' and path == home + '/.ssh/authorized_keys':
            return ['system.posix_acl_access']
        if scenario == 'helper-acl' and path.endswith('/worker-git.py'):
            return ['system.posix_acl_access']
        return []

    os.open = opened
    os.fstat = lambda fd: facts[descriptors[fd]]
    os.close = lambda fd: descriptors.pop(fd)
    os.listxattr = attributes
    pathlib.Path.read_bytes = lambda path: request['helper_contents'][str(path)].encode()

    @atexit.register
    def all_closed():
        assert not descriptors, 'probe leaked pinned descriptors'
