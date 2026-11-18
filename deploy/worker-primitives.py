#!/usr/bin/env python3
"""Worker-only native identity and inherited-FD locking. No signals or cleanup."""
import ctypes
import errno
import fcntl
import hashlib
import json
import os
import platform
import plistlib
import pwd
import grp
import re
import selectors
import stat
import subprocess
import sys
import time
from pathlib import Path


def acl_safe(fd):
    if platform.system() == 'Linux':
        return not any(name.startswith('system.posix_acl_') for name in os.listxattr(fd))
    libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
    libc.acl_get_fd_np.restype = ctypes.c_void_p
    libc.acl_to_text.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ssize_t)]
    libc.acl_to_text.restype = ctypes.c_void_p
    libc.acl_free.argtypes = [ctypes.c_void_p]
    ctypes.set_errno(0)
    acl = libc.acl_get_fd_np(fd, 0x100)  # ACL_TYPE_EXTENDED
    if not acl:
        if ctypes.get_errno() == errno.ENOENT:
            return True
        raise OSError('acl_unknown')
    text = None
    try:
        size = ctypes.c_ssize_t()
        text = libc.acl_to_text(acl, ctypes.byref(size))
        if not text or not 0 <= size.value <= 65536:
            raise OSError('acl_unknown')
        return ctypes.string_at(text, size.value).strip() in (b'', b'!#acl 1')
    finally:
        if text:
            libc.acl_free(text)
        libc.acl_free(acl)


def directory(path, uid, private=False):
    """Pin a canonical directory via openat; no writable foreign ancestors/ACLs."""
    if not os.path.isabs(path) or os.path.normpath(path) != path:
        raise ValueError('path_unknown')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    isolated = False
    try:
        for part in ('', *Path(path).parts[1:]):
            if part:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = child
            info = os.fstat(fd)
            sticky = info.st_uid == 0 and info.st_mode & stat.S_ISVTX
            if info.st_uid not in (0, uid) or (info.st_mode & 0o022 and not sticky) or not acl_safe(fd):
                raise ValueError('path_unknown')
            isolated |= info.st_uid == uid and not info.st_mode & 0o077
        if private and not isolated:
            raise ValueError('path_not_private')
        return fd
    except Exception:
        os.close(fd)
        raise


# Darwin built-in group IDs; C-437 reports their implicit membership on a Mac.
# These are exact name/GID pairs, never a general exemption for system groups.
DARWIN_IMPLICIT_GROUPS = {'everyone': 12, 'localaccounts': 61, '_lpoperator': 100}


def isolation_groups(account, inherited=(), timeout_ms=5000):
    """Accept only the private primary group and verified Darwin implicit groups."""
    primary = account.pw_gid
    membership = set(os.getgrouplist(account.pw_name, primary))
    extra = (membership | set(inherited)) - {primary}
    if primary not in membership:
        raise ValueError('isolation_groups')
    if platform.system() != 'Darwin':
        if extra:
            raise ValueError('isolation_groups')
        return
    primary_name = grp.getgrgid(primary).gr_name
    if (primary in (0, 20, 80, *DARWIN_IMPLICIT_GROUPS.values())
            or primary_name in ('root', 'wheel', 'admin', 'staff', 'sudo', *DARWIN_IMPLICIT_GROUPS)
            or primary_name.startswith('com.apple.') or extra & {0, 20, 80}):
        raise ValueError('isolation_groups')

    def record(path, attributes):
        # Group membership attributes are optional. Asking dscl for an absent
        # key can emit "No such key" instead of a plist; read the group record.
        # User reads remain restricted to identity fields, never authentication data.
        query = attributes if path.startswith('/Users/') else []
        data = plistlib.loads(run(['/usr/bin/dscl', '-plist', '.', '-read', path, *query], timeout_ms).encode())
        if not isinstance(data, dict):
            raise ValueError('isolation_groups')
        result = {}
        for key in attributes:
            values = data.get('dsAttrTypeStandard:' + key, [])
            if not isinstance(values, list) or not all(isinstance(value, str) for value in values):
                raise ValueError('isolation_groups')
            if key in ('GeneratedUID', 'GroupMembers', 'NestedGroups'):
                if any(re.fullmatch(r'[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}', value) is None for value in values):
                    raise ValueError('isolation_groups')
                values = [value.upper() for value in values]
            result[key] = values
        return result

    user = record('/Users/' + account.pw_name, ['RecordName', 'GeneratedUID', 'UniqueID', 'PrimaryGroupID'])
    if (account.pw_name not in user['RecordName'] or len(user['GeneratedUID']) != 1
            or not user['GeneratedUID'][0] or user['UniqueID'] != [str(account.pw_uid)]
            or user['PrimaryGroupID'] != [str(primary)]):
        raise ValueError('isolation_groups')
    account_ids = {value.casefold() for value in user['RecordName'] + user['GeneratedUID']}

    def checked_group(name, gid):
        group = grp.getgrgid(gid)
        named = grp.getgrnam(name)
        data = record('/Groups/' + name, ['RecordName', 'GeneratedUID', 'PrimaryGroupID',
                                        'GroupMembership', 'GroupMembers', 'NestedGroups'])
        if (group.gr_name != name or group.gr_gid != gid or named.gr_name != name or named.gr_gid != gid
                or name not in data['RecordName'] or data['PrimaryGroupID'] != [str(gid)]
                or len(data['GeneratedUID']) != 1 or not data['GeneratedUID'][0]
                or account_ids & {value.casefold() for value in
                    group.gr_mem + data['GroupMembership'] + data['GroupMembers'] + data['NestedGroups']}
                or run(['/usr/bin/dsmemberutil', 'getuuid', '-G', name], timeout_ms).upper() != data['GeneratedUID'][0]):
            raise ValueError('isolation_groups')
        return data

    records = {name: checked_group(name, gid) for name, gid in DARWIN_IMPLICIT_GROUPS.items()}
    implicit_ids = {data['GeneratedUID'][0] for data in records.values()}
    if len(implicit_ids) != len(records) or user['GeneratedUID'][0] in implicit_ids:
        raise ValueError('isolation_groups')
    roots = {records[name]['GeneratedUID'][0] for name in ('everyone', 'localaccounts')}
    operator_nested = set(records['_lpoperator']['NestedGroups'])
    # The two universal groups are roots, not custom/recursive membership paths.
    if (any(records[name]['NestedGroups'] for name in ('everyone', 'localaccounts'))
            or not operator_nested & roots):
        raise ValueError('isolation_groups')
    # Stock macOS also nests _lpadmin (which nests admin). Check each non-root
    # by UUID: dsmemberutil resolves recursive membership, including aliases.
    # Only an explicit negative is safe; lookup failures/unknown output fail closed.
    for identifier in sorted(operator_nested - roots):
        if run(['/usr/bin/dsmemberutil', 'checkmembership', '-U', account.pw_name,
                '-X', identifier], timeout_ms) != 'user is not a member of the group':
            raise ValueError('isolation_groups')
    seen_ids = implicit_ids | set(user['GeneratedUID'])
    for gid in sorted(extra - set(DARWIN_IMPLICIT_GROUPS.values())):
        name = grp.getgrgid(gid).gr_name
        # Q-870: public-folder SACL groups only; no generic implicit-group exemption.
        if re.fullmatch(r'com\.apple\.sharepoint\.group\.[0-9]+', name) is None:
            raise ValueError('isolation_groups')
        data = checked_group(name, gid)
        nested = set(data['NestedGroups'])
        if not nested or not nested <= roots or data['GeneratedUID'][0] in seen_ids:
            raise ValueError('isolation_groups')
        seen_ids.add(data['GeneratedUID'][0])


def isolation_account(request, inherited=()):
    """Directory-service facts, including aliases and primary-group occupants."""
    account = pwd.getpwnam(request['account'])
    group = grp.getgrgid(account.pw_gid)
    if (account.pw_uid != request['uid'] or account.pw_uid <= 0 or account.pw_gid <= 0
            or group.gr_name in ('root', 'wheel', 'admin', 'sudo')
            or set(group.gr_mem) - {account.pw_name}
            or any(p.pw_name != account.pw_name and (p.pw_uid == account.pw_uid or p.pw_gid == account.pw_gid)
                   for p in pwd.getpwall())):
        raise ValueError('isolation_account')
    isolation_groups(account, inherited, request.get('timeout_ms', 5000))
    return account


def isolation_directory(path, uid, gid, mode, namespace=False):
    """Unlike temporary artifact paths, isolation anchors reject sticky parents too."""
    fd = directory(path, uid)
    try:
        info = os.fstat(fd)
        if info.st_uid != uid or info.st_gid != gid or stat.S_IMODE(info.st_mode) != mode:
            raise ValueError('isolation_path')
        for parent in Path(path).parents:
            check = directory(str(parent), 0 if namespace else uid)
            try:
                if os.fstat(check).st_mode & 0o022:
                    raise ValueError('isolation_namespace')
            finally:
                os.close(check)
        return fd
    except Exception:
        os.close(fd)
        raise


def process_groups():
    # Modern macOS Python os.getgroups() may refresh the user's directory-service
    # access list. libc getgroups samples the inherited process credentials instead.
    if platform.system() != 'Darwin':
        return os.getgroups()
    libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
    libc.getgroups.argtypes = [ctypes.c_int, ctypes.POINTER(ctypes.c_uint)]
    libc.getgroups.restype = ctypes.c_int
    count = libc.getgroups(0, None)
    if count < 0:
        raise OSError('process_groups_unknown')
    groups = (ctypes.c_uint * count)()
    actual = libc.getgroups(count, groups)
    if actual < 0 or actual > count:
        raise OSError('process_groups_unknown')
    return list(groups[:actual])


def project_isolation(request):
    """Read-only B8 entry, run under the selected project UID; no credentials read."""
    account = isolation_account(request, process_groups())
    uid, gid = account.pw_uid, account.pw_gid
    # Removing membership from the account database does not revoke old hc/login
    # processes' groups. Keep this check here: the installer inspects accounts as root.
    if (os.getuid() != uid or os.geteuid() != uid or os.getgid() != gid or os.getegid() != gid
            or request['home'] != account.pw_dir):
        raise ValueError('isolation_identity')
    home, root = Path(account.pw_dir), Path(request['root'])
    if home == root or home in root.parents or root in home.parents:
        raise ValueError('isolation_roots')
    for anchor in (home, root):
        os.close(isolation_directory(str(anchor), 0, gid, 0o750, True))
    os.close(isolation_directory(str(home / '.local'), 0, gid, 0o750, True))
    for relative in ('.config', '.cache', '.local/state', '.local/share'):
        os.close(isolation_directory(str(home / relative), uid, gid, 0o700))
    parent = isolation_directory(str(home), 0, gid, 0o750, True)
    try:
        fd = os.open('.cardigan-project', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        with os.fdopen(fd, 'rb') as claim:
            info = os.fstat(fd)
            if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != 0
                    or stat.S_IMODE(info.st_mode) != 0o644 or info.st_size > 4096 or not acl_safe(fd)
                    or json.loads(claim.read(4097)) != {'project': request['project'], 'uid': uid}):
                raise ValueError('isolation_claim')
    finally:
        os.close(parent)
    # An immutable home also protects the account's SSH authorization namespace.
    parent = isolation_directory(str(home / '.ssh'), 0, gid, 0o750, True)
    try:
        fd = os.open('authorized_keys', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            info = os.fstat(fd)
            if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != 0
                    or info.st_gid != gid or stat.S_IMODE(info.st_mode) != 0o640 or not acl_safe(fd)):
                raise ValueError('isolation_authorization')
        finally:
            os.close(fd)
    finally:
        os.close(parent)
    required = {'run', 'repo', 'worktree', 'build', 'cache', 'session', 'credentials', 'temporary', 'hc'}
    paths = request['paths']
    if set(paths) != required or len(set(paths.values())) != len(required):
        raise ValueError('isolation_inventory')
    for kind, value in paths.items():
        path = Path(value)
        if not any(anchor in path.parents for anchor in (home, root)):
            raise ValueError('isolation_inventory')
        os.close(isolation_directory(value, uid, gid, 0o700, kind in ('run', 'repo', 'worktree', 'build')))
    # hc sockets need not be regular files, but must stay inside the private hc root.
    socket_path = Path(request['socket'])
    if socket_path.parent != Path(paths['hc']):
        raise ValueError('isolation_socket')
    parent = isolation_directory(paths['hc'], uid, gid, 0o700)
    try:
        info = os.stat(socket_path.name, dir_fd=parent, follow_symlinks=False)
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid != uid or info.st_gid != gid or info.st_mode & 0o077:
            raise ValueError('isolation_socket')
    finally:
        os.close(parent)
    return dict(project=request['project'], uid=uid, ready=True)


def lock_fd(fd, budget_ms=0):
    if type(budget_ms) is not int or not 0 <= budget_ms <= 2147483647:
        raise ValueError('invalid_budget')
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size != 0:
        raise ValueError('invalid_lock')
    deadline = time.monotonic() + budget_ms / 1000
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return
        except BlockingIOError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(min(0.01, max(0, deadline - time.monotonic())))


def protected_lock(fd, path, budget_ms):
    if not os.path.isabs(path) or os.path.normpath(path) != path:
        raise ValueError('invalid_lock_path')
    parent = directory(str(Path(path).parent), 0)
    try:
        inode = os.stat(Path(path).name, dir_fd=parent, follow_symlinks=False)
        actual = os.fstat(fd)
        if (inode.st_dev, inode.st_ino) != (actual.st_dev, actual.st_ino) or actual.st_uid != 0 or actual.st_mode & 0o007 or not acl_safe(fd):
            raise ValueError('invalid_lock')
        lock_fd(fd, budget_ms)
    finally:
        os.close(parent)


def run(argv, timeout_ms):
    """Bounded read-only subprocess output; errors never expose native diagnostics."""
    env = dict(PATH='/usr/bin:/bin', LC_ALL='C', GIT_CONFIG_NOSYSTEM='1',
               GIT_CONFIG_GLOBAL='/dev/null', GIT_OPTIONAL_LOCKS='0', GIT_TERMINAL_PROMPT='0', GIT_NO_LAZY_FETCH='1')
    with subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env) as process:
        try:
            deadline, data = time.monotonic() + timeout_ms / 1000, bytearray()
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0 or not selector.select(remaining):
                        raise TimeoutError()
                    block = os.read(process.stdout.fileno(), 4096)
                    if not block:
                        break
                    data.extend(block)
                    if len(data) > 65536:
                        raise ValueError('output_limit')
            if process.wait(timeout=max(0, deadline - time.monotonic())) != 0:
                raise ValueError('probe_failed')
            return data.decode().strip()
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()


def tool(request):
    path = request['path']
    with open(path, 'rb') as file:
        header = file.read(512)
    arch, signed = None, None
    if header[:4] == b'\x7fELF':
        arch = {62: 'x64', 183: 'arm64'}.get(int.from_bytes(header[18:20], 'little' if header[5] == 1 else 'big'))
    elif header[:4] in (b'\xcf\xfa\xed\xfe', b'\xce\xfa\xed\xfe'):
        arch = {0x1000007: 'x64', 0x100000c: 'arm64'}.get(int.from_bytes(header[4:8], 'little'))
    elif header[:4] == b'\xca\xfe\xba\xbe':
        count = int.from_bytes(header[4:8], 'big')
        if 0 < count <= 20 and len(header) >= 8 + 20 * count:
            cpus = {int.from_bytes(header[8+i*20:12+i*20], 'big') for i in range(count)}
            arch = 'universal' if {0x1000007, 0x100000c} <= cpus else None
    elif header.splitlines()[0:1] == [b'#!/usr/bin/env node']:
        arch = request.get('node_arch')
    if platform.system() == 'Darwin' and (pin := request.get('signature')):
        if not re.fullmatch(r'[A-Z0-9]{10}', pin['team']) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9.-]+', pin['identifier']):
            raise ValueError('invalid_signature_pin')
        app = os.path.realpath(pin['app'])
        if not app.endswith('.app') or not Path(os.path.realpath(path)).is_relative_to(Path(app)):
            raise ValueError('invalid_app_path')
        requirement = f'anchor apple generic and identifier "{pin["identifier"]}" and certificate leaf[subject.OU] = "{pin["team"]}"'
        run(['/usr/bin/codesign', '--verify', '--deep', '--strict', '-R', requirement, app], request['timeout_ms'])
        signed = True
    return dict(arch=arch, signed=signed)


def git_state(request, path):
    """Probe each repository separately; never let status recurse into unchecked repositories."""
    fd = directory(path, os.getuid(), private=True)
    try:
        git = [request['git'], '-C', path, '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never']
        query = lambda *args: run([*git, *args], request['timeout_ms'])
        keys = query('config', '--local', '--no-includes', '--name-only', '--list').lower().splitlines()
        if any(key.startswith(('filter.', 'include.', 'includeif.')) or key in ('extensions.worktreeconfig', 'extensions.partialclone') or key.endswith('.promisor') for key in keys):
            raise ValueError('unsafe_git_probe_config')
        common = os.path.realpath(query('rev-parse', '--path-format=absolute', '--git-common-dir'))
        sha = query('rev-parse', '--verify', 'HEAD')
        bare = query('rev-parse', '--is-bare-repository') == 'true'
        if os.path.realpath(path) != (common if bare else os.path.realpath(query('rev-parse', '--show-toplevel'))):
            raise ValueError('not_repository_root')
        dirty = False
        if not bare:
            def links(*args):
                result = {}
                for entry in query(*args).split('\0'):
                    if entry.startswith('160000 '):
                        fields, name = entry.split('\t', 1)
                        mode, object_id, stage = fields.split()
                        if args[0] == 'ls-tree':
                            object_id = stage
                        elif stage != '0':
                            raise ValueError('unmerged_submodule')
                        if os.path.isabs(name) or '..' in Path(name).parts:
                            raise ValueError('invalid_submodule_path')
                        result[name] = object_id
                return result
            index = links('ls-files', '--stage', '-z')
            dirty = index != links('ls-tree', '-r', '-z', 'HEAD')
            for name, commit in index.items():
                child = str(Path(path) / name)
                if not os.path.lexists(Path(child) / '.git'):
                    raise ValueError('submodule_unobserved')
                state = git_state(request, child)
                dirty |= state['sha'] != commit or state['dirty']
            dirty |= bool(query('status', '--porcelain=v1', '--untracked-files=normal', '--ignore-submodules=all'))
        if not os.path.samefile(path, fd) or query('rev-parse', '--verify', 'HEAD') != sha:
            raise ValueError('worktree_changed')
        return dict(common_dir=common, sha=sha, dirty=dirty)
    finally:
        os.close(fd)


def paths(request):
    if not os.path.isabs(request['git']) or type(request['timeout_ms']) is not int or not 0 < request['timeout_ms'] <= 2147483647:
        raise ValueError('invalid_path_probe')
    uid, result = os.getuid(), []
    worktree = directory(request['worktree'], uid, private=True)
    lock = None
    try:
        if request.get('lock'):
            lock = os.open(request['lock'], os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK)
            protected_lock(lock, request['lock'], 0)
        binding = request.get('binding', {})
        def bound(path, info, kind):
            registered = binding.get('directories', {}).get(path, {})
            return registered == dict(device=str(info.st_dev), inode=str(info.st_ino), kind=kind)
        workspace_kind = binding.get('directories', {}).get(request['worktree'], {}).get('kind')
        context_bound = (workspace_kind in ('repo', 'worktree', 'build') and binding.get('workspace') == request['worktree'] and
                         re.fullmatch(r'A-[0-9]+', binding.get('assignment', '')) and
                         bound(request['worktree'], os.fstat(worktree), workspace_kind))
        for expected in request['paths']:
            path, kind = expected['path'], expected['kind']
            if not Path(path).is_relative_to(Path(expected['mount'])):
                raise ValueError('mount_mismatch')
            fd = directory(path, uid, private=True)
            mount = None
            try:
                mount = directory(expected['mount'], uid)
                info, disk, root = os.fstat(fd), os.fstatvfs(fd), os.statvfs('/')
                assignment = binding['assignment'] if context_bound and bound(path, info, kind) else None
                if kind not in ('repo', 'worktree', 'build') and assignment is None:
                    raise ValueError('path_binding_unknown')
                state = git_state(request, path if kind in ('repo', 'worktree', 'build') else request['worktree'])
                actual = dict(path=path, kind=kind, mount=expected['mount'], assignment=assignment, realpath=os.path.realpath(path), uid=info.st_uid,
                              **state, volume=str(disk.f_fsid),
                              mounted=os.path.ismount(expected['mount']) and info.st_dev == os.fstat(mount).st_dev,
                              acl_safe=True, project_private=True, free_bytes=disk.f_bavail * disk.f_frsize,
                              root_free_bytes=root.f_bavail * root.f_frsize, lock_verified=lock is not None)
                if not os.path.samefile(path, fd):
                    raise ValueError('path_changed')
                result.append(actual)
            finally:
                os.close(fd)
                if mount is not None:
                    os.close(mount)
        if not os.path.samefile(request['worktree'], worktree):
            raise ValueError('worktree_changed')
        return result
    finally:
        if lock is not None:
            os.close(lock)
        os.close(worktree)


def artifact(request):
    if request['writing_complete'] is not True:
        raise ValueError('writer_not_finished')
    source, evidence = Path(request['source']), Path(request['evidence_root'])
    temporary = Path(request['temporary_root'])
    if not temporary.is_absolute() or os.path.normpath(str(temporary)) != str(temporary) or not source.is_relative_to(temporary):
        raise ValueError('unapproved_source')
    parent = directory(str(source.parent), os.getuid(), private=True)
    target = None
    try:
        target = directory(str(evidence), os.getuid(), private=True)
        with os.fdopen(os.open(source.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent), 'rb') as file:
            before = os.fstat(file.fileno())
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_uid != os.getuid() or before.st_size > 10 * 1024 * 1024:
                raise ValueError('invalid_artifact')
            data = file.read(10 * 1024 * 1024 + 1)
            after = os.fstat(file.fileno())
            if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns) or len(data) != before.st_size:
                raise ValueError('artifact_changed')
        sha = hashlib.sha256(data).hexdigest()
        try:
            fd = os.open(sha, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=target)
            with os.fdopen(fd, 'wb') as copy:
                copy.write(data)
                copy.flush()
                os.fsync(copy.fileno())
            os.fsync(target)
        except FileExistsError:
            pass
        with os.fdopen(os.open(sha, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=target), 'rb') as copy:
            info = os.fstat(copy.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size != len(data) or hashlib.sha256(copy.read(len(data) + 1)).hexdigest() != sha:
                raise ValueError('artifact_copy_mismatch')
        return dict(sha256=sha, size=len(data), evidence_name=sha)
    finally:
        os.close(parent)
        if target is not None:
            os.close(target)


def desktop():
    result = dict.fromkeys(['login', 'unlocked', 'window-server', 'graphics-session', 'metal', 'screen-capture', 'accessibility', 'keychain'])
    if platform.system() != 'Darwin':
        return result
    try:
        cf = ctypes.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
        cg = ctypes.CDLL('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
        cf.CFStringCreateWithCString.restype = ctypes.c_void_p
        cf.CFStringCreateWithCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_uint32]
        cf.CFDictionaryGetValue.restype = ctypes.c_void_p
        cf.CFDictionaryGetValue.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        cf.CFNumberGetValue.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p]
        cf.CFNumberGetValue.restype = ctypes.c_bool
        cf.CFBooleanGetValue.argtypes = [ctypes.c_void_p]
        cf.CFBooleanGetValue.restype = ctypes.c_bool
        cf.CFRelease.argtypes = [ctypes.c_void_p]
        cg.CGSessionCopyCurrentDictionary.restype = ctypes.c_void_p
        session = cg.CGSessionCopyCurrentDictionary()
        def value(name, number=False):
            key = cf.CFStringCreateWithCString(None, name.encode(), 0x08000100)
            try:
                item = cf.CFDictionaryGetValue(session, key)
                if not item:
                    return None
                if number:
                    n = ctypes.c_int()
                    return n.value if cf.CFNumberGetValue(item, 9, ctypes.byref(n)) else None
                return bool(cf.CFBooleanGetValue(item))
            finally:
                cf.CFRelease(key)
        if session:
            try:
                own = value('kCGSessionUserIDKey', True) == os.getuid()
                result['graphics-session'] = own and value('kCGSessionOnConsoleKey')
                result['window-server'] = result['graphics-session']
                result['login'] = own and value('kCGSessionLoginDoneKey')
                locked = value('CGSSessionScreenIsLocked')
                result['unlocked'] = own and not locked if locked is not None else None
            finally:
                cf.CFRelease(session)
        cg.CGPreflightScreenCaptureAccess.restype = ctypes.c_bool
        result['screen-capture'] = bool(cg.CGPreflightScreenCaptureAccess())
        ax = ctypes.CDLL('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices')
        ax.AXIsProcessTrusted.restype = ctypes.c_bool
        result['accessibility'] = bool(ax.AXIsProcessTrusted())
        metal = ctypes.CDLL('/System/Library/Frameworks/Metal.framework/Metal')
        metal.MTLCreateSystemDefaultDevice.restype = ctypes.c_void_p
        result['metal'] = bool(metal.MTLCreateSystemDefaultDevice())
        security = ctypes.CDLL('/System/Library/Frameworks/Security.framework/Security')
        keychain, status = ctypes.c_void_p(), ctypes.c_uint32()
        if security.SecKeychainCopyDefault(ctypes.byref(keychain)) == 0:
            try:
                security.SecKeychainGetStatus.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
                if security.SecKeychainGetStatus(keychain, ctypes.byref(status)) == 0:
                    result['keychain'] = status.value & 3 == 3
            finally:
                cf.CFRelease(keychain)
    except (OSError, AttributeError):
        pass  # Never prompt, enumerate items, or infer missing desktop evidence.
    return result


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


def identity(machine, pid, terminal, pgid):
    try:
        if not machine or not terminal or pid <= 0 or pgid <= 0:
            raise ValueError('identity_unknown')
        probe = {'Linux': linux_identity, 'Darwin': darwin_identity}[platform.system()]
        first = probe(pid)
        if first != probe(pid) or not first[0] or not first[2] or first[3] != pgid:
            raise ValueError('identity_unknown')
        return dict(machine=machine, boot=first[0], uid=first[1], pid=pid,
                    start=first[2], process_group=first[3], terminal=terminal)
    except (OSError, ValueError, KeyError, IndexError):
        return None


if __name__ == '__main__':
    try:
        if sys.argv[1] == 'lock':
            protected_lock(3, sys.argv[3], int(sys.argv[2]))
        elif sys.argv[1] in ('identity', 'paths', 'artifact', 'desktop', 'tool', 'isolation'):
            request = json.loads(sys.stdin.read(65537))
            print(json.dumps({'identity': lambda r: identity(**r), 'paths': paths, 'artifact': artifact, 'desktop': lambda _: desktop(), 'tool': tool, 'isolation': project_isolation}[sys.argv[1]](request)))
        else:
            raise ValueError('invalid_operation')
    except Exception:
        print('worker_primitive_unavailable', file=sys.stderr)
        sys.exit(75)
