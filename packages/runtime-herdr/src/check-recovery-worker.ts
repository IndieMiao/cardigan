/** Linux-only inspection. Residual deletion is disabled until exclusion can be proven. */
export const CHECK_RECOVERY_WORKER = String.raw`
import os, sys, stat, json, re, fcntl, signal, hmac, hashlib

auth_key = ''
stage = 'request'
evidence = None
def send(value):
    body = json.dumps(value, separators=(',', ':'))
    value['auth'] = hmac.new(auth_key.encode(), body.encode(), hashlib.sha256).hexdigest()
    print(json.dumps(value, separators=(',', ':')), flush=True)

class Refused(Exception): pass
class Occupied(Exception):
    def __init__(self, processes, uncertain=False):
        self.processes, self.reason = processes, 'unverified' if uncertain else 'occupied'

def output(status, reason, processes=[]):
    value = dict(status=status, reason=reason, processes=processes, stage=stage)
    if evidence is not None: value['evidence'] = evidence
    send(value)

def identity(info):
    return dict(device=str(info.st_dev), inode=str(info.st_ino), uid=info.st_uid)

def acl(fd):
    if any(n.startswith('system.posix_acl_') for n in os.listxattr(fd)): raise Refused()

def pin(path, owner=None):
    if not path.startswith('/') or os.path.normpath(path) != path: raise Refused()
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    private = False
    try:
        for name in path.split('/')[1:]:
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd); fd = child
            info = os.fstat(fd)
            sticky = info.st_uid == 0 and info.st_mode & stat.S_ISVTX
            private |= info.st_uid == os.getuid() and not info.st_mode & 0o077
            if info.st_mode & 0o022 and not sticky and not (private and info.st_uid == os.getuid()): raise Refused()
            acl(fd)
        if owner is not None and os.fstat(fd).st_uid != owner: raise Refused()
        return fd
    except BaseException:
        os.close(fd); raise

def read(fd, name):
    child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    try:
        info = os.fstat(child)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 65536: raise Refused()
        return os.read(child, 65537).decode().strip()
    finally: os.close(child)

def same(path, fd, expected):
    if identity(os.fstat(fd)) != expected or identity(os.stat(path, follow_symlinks=False)) != expected:
        raise Refused()
    if os.readlink('/proc/self/fd/' + str(fd)) != path: raise Refused()

def mounts():
    # Includes bind mounts on the same device; do not trust st_dev alone.
    with open('/proc/self/mountinfo') as file: return file.read()

def no_mounts(text, roots):
    for line in text.splitlines():
        fields = line.split()
        if len(fields) < 10: raise Refused()
        path = re.sub(r'\\([0-7]{3})', lambda m: chr(int(m[1], 8)), fields[4])
        if any(path == root or path.startswith(root + '/') for root in roots): raise Refused()
        if path == '/proc' and ('hidepid=' in line or 'subset=pid' in line): raise Refused()

def inventory(fd, path, device, entries, objects):
    info = os.fstat(fd)
    if info.st_uid != os.getuid() or info.st_dev != device: raise Refused()
    acl(fd)
    objects.add((info.st_dev, info.st_ino))
    for name in os.listdir(fd):
        info = os.stat(name, dir_fd=fd, follow_symlinks=False)
        if info.st_uid != os.getuid() or info.st_dev != device: raise Refused()
        if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or stat.S_ISSOCK(info.st_mode)):
            raise Refused()
        # Hard links outside this attempt cannot be proven private.
        if stat.S_ISREG(info.st_mode) and info.st_nlink != 1: raise Refused()
        objects.add((info.st_dev, info.st_ino))
        if stat.S_ISDIR(info.st_mode):
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            try:
                same(path + '/' + name, child, identity(info))
                inventory(child, path + '/' + name, device, entries, objects)
            finally: os.close(child)
        entries[path + '/' + name] = (info.st_dev, info.st_ino, info.st_mode)

def pstat(proc):
    with open(proc + '/stat') as file: value = file.read()
    fields = value[value.rfind(') ') + 2:].split()
    if len(fields) < 20 or not fields[19].isdigit() or not re.fullmatch('[A-Z]', fields[0]): raise Refused()
    return fields[19], fields[0]

def pids(): return sorted(p for p in os.listdir('/proc') if p.isdigit())

def task_ids(pid):
    tids = sorted(t for t in os.listdir('/proc/' + pid + '/task') if t.isdigit())
    if not tids: raise Refused()
    return tids

def scan(roots, objects):
    found, observed, groups = {}, {}, {}
    uncertain = False
    before = pids()
    for pid in before:
        try: groups[pid] = task_ids(pid)
        except Exception:
            uncertain = True
            found[pid] = dict(pid=int(pid), state='unknown', wchan='unknown')
            continue
        # A dead leader does not prove that its threads have exited. Each TID
        # can have independent CLONE_FS/CLONE_FILES state, including our group.
        for tid in groups[pid]:
            if int(tid) == os.getpid(): continue
            proc = '/proc/' + pid + '/task/' + tid
            state, wchan = 'unknown', 'unknown'
            try:
                start, state = pstat(proc); observed[(pid, tid)] = start
                if state in ('Z', 'X'): continue
                with open(proc + '/wchan') as file: wait = file.read().strip()
                if re.fullmatch('[A-Za-z0-9_]{1,80}', wait): wchan = wait
                handles = [proc + '/cwd'] + [proc + '/fd/' + n for n in os.listdir(proc + '/fd')]
                occupied = False
                for handle in handles:
                    target = os.readlink(handle)
                    info = os.stat(handle)
                    occupied |= (info.st_dev, info.st_ino) in objects or any(
                        target == root or target.startswith(root + '/') or target == root + ' (deleted)' for root in roots)
                if pstat(proc)[0] != start: raise Refused()
                if occupied: found[tid] = dict(pid=int(tid), state=state, wchan=wchan)
            except Exception:
                uncertain = True
                found[tid] = dict(pid=int(tid), state=state, wchan=wchan)
    # Process/thread churn and inaccessible task tables cannot prove idleness.
    for pid in set(pids()).symmetric_difference(before):
        uncertain = True
        found[pid] = dict(pid=int(pid), state='unknown', wchan='unknown')
    for pid, tids in groups.items():
        try: changed = set(task_ids(pid)).symmetric_difference(tids)
        except Exception: changed = {pid}
        for tid in changed:
            uncertain = True
            found[tid] = dict(pid=int(tid), state='unknown', wchan='unknown')
    for (pid, tid), start in observed.items():
        try:
            if pstat('/proc/' + pid + '/task/' + tid)[0] == start: continue
        except Exception: pass
        uncertain = True
        found[tid] = dict(pid=int(tid), state='unknown', wchan='unknown')
    if found: raise Occupied(list(found.values()), uncertain)

def protected_root(root):
    # Lock files and all ancestors must be administrator-owned and non-writable.
    rootfd = pin(root)
    current = root
    while current != '/':
        info = os.stat(current, follow_symlinks=False)
        if info.st_uid == os.getuid() or info.st_mode & 0o022 or os.access(current, os.W_OK): raise Refused()
        current = os.path.dirname(current)
    return rootfd

def absence_parent(path):
    # Keep the nearest existing parent pinned while checking ALL missing roots.
    # Its directory timestamps detect an earlier root reappearing while a later
    # root is inspected, even if that root is removed again before this check.
    parent = os.path.dirname(path)
    while True:
        try: fd = pin(parent, os.getuid()); break
        except FileNotFoundError: parent = os.path.dirname(parent)
    info = os.fstat(fd)
    return parent, fd, identity(info), (info.st_mtime_ns, info.st_ctime_ns)

def main():
    global auth_key, stage, evidence
    signal.alarm(60)
    root = sys.argv[1]
    request = json.loads(sys.stdin.readline(65536))
    auth_key = request['auth_key']
    if not re.fullmatch('[a-f0-9]{64}', auth_key): raise Refused()
    project, attempt, sha, binding = (request[k] for k in ('project', 'attempt', 'sha', 'binding'))
    if os.getuid() == 0 or not re.fullmatch('[A-Za-z0-9_][A-Za-z0-9._-]*', project) or not re.fullmatch('[A-Za-z0-9][A-Za-z0-9_-]{0,79}', attempt): raise Refused()
    if type(request['slots']) != int or not 1 <= request['slots'] <= 16: raise Refused()
    if not re.fullmatch('[a-f0-9]{40}([a-f0-9]{24})?', sha): raise Refused()
    if not re.fullmatch('[A-Za-z0-9][A-Za-z0-9._-]{0,79}', binding['registration_name']): raise Refused()
    stage = 'lock'
    rootfd = protected_root(root)
    locks = []
    for slot in range(request['slots']):
        name = 'merge-check' + (('-' + str(slot)) if slot else '') + '.lock'
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=rootfd); locks.append(fd)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid == os.getuid() or info.st_nlink != 1 or info.st_size != 0 or info.st_mode & 0o222: raise Refused()
        acl(fd)
        try: fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            output('busy', 'locked'); return
    container = root + '/checks/' + project + '/' + attempt
    repository = root + '/repos/' + project
    stage = 'repository_identity'
    repo = pin(repository, os.getuid()); same(repository, repo, binding['repository'])
    layout = binding['git_layout']
    if layout not in ('bare', 'checkout'): raise Refused()
    common = repository + ('/.git' if layout == 'checkout' else '')
    registration = common + '/worktrees/' + binding['registration_name']
    roots = [container, registration]
    stage = 'mounts'
    mounted = mounts(); no_mounts(mounted, roots)
    stage = 'target_identity'
    opened = {}
    observed = []
    for path, key in ((container, 'container'), (container + '/worktree', 'worktree'), (registration, 'registration')):
        try: fd = pin(path, os.getuid())
        except FileNotFoundError:
            observed.append([key, 'absent']); continue
        observed.append([key, identity(os.fstat(fd))])
        same(path, fd, binding[key]); opened[path] = fd
    evidence = hashlib.sha256(json.dumps(observed, sort_keys=True).encode()).hexdigest()
    if container + '/worktree' in opened and container not in opened: raise Refused()
    if request.get('observeOnly') is True:
        stage = 'presence'
        output('manual_attention', 'unverified'); return
    if not opened:
        stage = 'absence'
        # Normal checkout cleanup already finished: nothing is inspected or deleted.
        parents = [absence_parent(path) for path in roots]
        send(dict(phase='absent'))
        if sys.stdin.readline(32) != 'confirm\n': raise Refused()
        if mounts() != mounted: raise Refused()
        same(repository, repo, binding['repository'])
        for path in roots:
            try: fd = pin(path, os.getuid())
            except FileNotFoundError: continue
            os.close(fd); raise Refused()
        for path, fd, expected, times in parents:
            same(path, fd, expected)
            info = os.fstat(fd)
            if (info.st_mtime_ns, info.st_ctime_ns) != times: raise Refused()
        # This is still a bounded observation, not a fence against future writes.
        # The host must revisit even cleaned records on every later patrol.
        output('cleaned', 'complete'); return
    stage = 'registration'
    if len(opened) != 3: raise Refused()
    def registration_matches():
        def matches(fd, name, expected):
            try: value = read(fd, name)
            except FileNotFoundError: raise Refused()
            if value != expected: raise Refused()
        if registration in opened:
            fd = opened[registration]
            matches(fd, 'HEAD', sha)
            matches(fd, 'commondir', '../..')
            matches(fd, 'gitdir', container + '/worktree/.git')
        if container + '/worktree' in opened:
            matches(opened[container + '/worktree'], '.git', 'gitdir: ' + registration)
    registration_matches()
    stage = 'inventory'
    entries, objects = {}, set()
    for path in roots:
        if path in opened: inventory(opened[path], path, os.fstat(opened[path]).st_dev, entries, objects)
    def recheck():
        if mounts() != mounted: raise Refused()
        same(repository, repo, binding['repository'])
        for path, key in ((container, 'container'), (registration, 'registration')):
            if path in opened: same(path, opened[path], binding[key])
    stage = 'processes'
    recheck(); scan(roots, objects)
    # The current account and advisory slot locks do not fence other same-UID
    # processes/threads. Neither another scan nor an open dirfd prevents an
    # open/rename immediately afterwards. There is deliberately NO deletion
    # implementation or input flag that could bypass this missing guarantee.
    stage = 'exclusion'
    output('manual_attention', 'exclusion_unproven')

try: main()
except Occupied as error: output('manual_attention', error.reason, error.processes)
except Exception: output('manual_attention', 'unverified')
`;
