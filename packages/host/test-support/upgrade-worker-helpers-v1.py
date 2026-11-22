"""Verbatim v1 root entry (before C-595) for backward-compatibility tests only."""
import base64
import fcntl
import hashlib
import json
import os
import platform
import pwd
import re
import runpy
import signal
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path

BOOT = Path(__file__).parent
LEGACY = Path('/opt/cardigan-helper-upgrade')
NAMES = ('worker-files.py', 'worker-git.py', 'worker-primitives.py')
LIMIT = 1024 * 1024
USER = 'cardigan_updater'


def require(ok):
    if not ok:
        raise ValueError('upgrade_rejected')


def unique(pairs):
    obj = dict(pairs)
    require(len(obj) == len(pairs))
    return obj


def unpack(raw, project, verify, now, previous):
    require(len(raw) <= LIMIT)
    bundle = json.loads(raw, object_pairs_hook=unique)
    require(set(bundle) == {'manifest', 'signature', 'files'})
    manifest = bundle['manifest'].encode('ascii')
    require(len(manifest) < 4096)
    verify(manifest, base64.b64decode(bundle['signature'], validate=True))
    meta = json.loads(manifest, object_pairs_hook=unique)
    require(set(meta) == {'kind', 'project', 'issued', 'digests'} and meta['kind'] == 'cardigan-helper-v1'
            and meta['project'] == project and type(meta['issued']) is int
            and now - 120000 <= meta['issued'] <= now + 10000 and meta['issued'] > previous)
    require(set(bundle['files']) == set(meta['digests']) == set(NAMES))
    files = {n: base64.b64decode(bundle['files'][n], validate=True) for n in NAMES}
    require(all(files[n] and digest(files[n]) == meta['digests'][n] for n in NAMES))
    return meta['issued'], files


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_installed(path, gid, acl_safe):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as f:
        s = os.fstat(fd)
        require(stat.S_ISREG(s.st_mode) and s.st_uid == 0 and s.st_gid == gid and s.st_nlink == 1
                and stat.S_IMODE(s.st_mode) == 0o750 and s.st_size <= LIMIT and acl_safe(fd))
        data = f.read(LIMIT + 1)
        require(len(data) == s.st_size)
        return data


def write_new(path, data, gid, mode):
    with path.open('xb') as f:
        os.fchown(f.fileno(), 0, gid)
        os.fchmod(f.fileno(), mode)
        f.write(data)
        f.flush()
        os.fsync(f.fileno())


def update(files, target, gid, backup, acl_safe, check):
    # target is a pinned administrator-only namespace. No filenames from input.
    old = {n: read_installed(target / n, gid, acl_safe) for n in NAMES}
    check(old[NAMES[2]])
    for n in NAMES:
        write_new(backup / n, old[n], gid, 0o600)
    # Stage on the target filesystem. Rollback copies remain root-only.
    with tempfile.TemporaryDirectory(dir=target) as staging:
        stage = Path(staging)
        for n in NAMES:
            write_new(stage / n, files[n], gid, 0o750)
        for n in NAMES:
            os.replace(stage / n, target / n)
        require(all(read_installed(target / n, gid, acl_safe) == files[n] for n in NAMES))
        check(files[NAMES[2]])
    return {n: digest(old[n]) for n in NAMES}


def verify_release(state, public_key, manifest, signature):
    with tempfile.NamedTemporaryFile(dir=state) as sig:
        sig.write(signature)
        sig.flush()
        subprocess.run(['/usr/bin/openssl', 'dgst', '-sha256', '-verify', str(public_key),
                        '-signature', sig.name], input=manifest, env={'PATH': '/usr/bin:/bin'},
                       capture_output=True, timeout=5, check=True)


def timed_out(_signal, _frame):
    raise TimeoutError('upgrade_timeout')


def enrollment(boot, project):
    if boot == LEGACY:
        return USER
    tag = digest(project.encode())[:20]
    require(boot == LEGACY.with_name(LEGACY.name + '-' + tag))
    return 'cgu_' + tag


def main():
    require(len(sys.argv) == 1 and os.geteuid() == 0)
    require(BOOT == LEGACY or (BOOT.parent == LEGACY.parent and
            re.fullmatch(r'cardigan-helper-upgrade-[0-9a-f]{20}', BOOT.name)))
    # Both the script and its binding pin live inside the administrator's 0700 bootstrap.
    project = (BOOT / 'project').read_text().rstrip('\n')
    user = enrollment(BOOT, project)
    require(os.environ.get('SUDO_USER') == user)
    os.chdir('/')
    os.umask(0o077)
    signal.signal(signal.SIGALRM, timed_out)
    signal.alarm(90)
    native = runpy.run_path(str(BOOT / 'worker-primitives.py'))
    installer = runpy.run_path(str(BOOT / 'install-macos-worker.py'))
    system = platform.system()
    path, config = installer['select_binding'](installer['binding_inventory'](system), project)
    require(path.name == ('worker.json' if BOOT == LEGACY else f'worker-{project}.json'))
    account = pwd.getpwnam(config['account'])
    updater = pwd.getpwnam(user)
    require(account.pw_uid == config['uid'] and int(os.environ['SUDO_UID']) == updater.pw_uid > 0
            and updater.pw_uid != account.pw_uid and account.pw_gid not in os.getgrouplist(user, updater.pw_gid))
    target = Path(config['root']) / 'libexec'
    os.close(native['isolation_directory'](str(target), 0, account.pw_gid, 0o750, True))
    state = BOOT / 'state'
    os.close(native['isolation_directory'](str(state), 0, os.getegid(), 0o700, True))
    lock = os.open(state / 'lock', os.O_CREAT | os.O_NOFOLLOW | os.O_RDWR, 0o600)
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    last = state / 'issued'

    issued, files = unpack(sys.stdin.buffer.read(LIMIT + 1), config['project'],
                           lambda m, s: verify_release(state, BOOT / 'signer.pub', m, s),
                           time.time_ns() // 1000000, int(last.read_text()) if last.exists() else 0)
    backup = state / ('backup-' + str(issued))
    backup.mkdir(mode=0o700)
    write_new(backup / 'issued', str(issued).encode(), os.getegid(), 0o600)
    os.replace(backup / 'issued', last)
    old = update(files, target, account.pw_gid, backup, native['acl_safe'],
                 lambda primitive: installer['preflight'](config, system, expected_primitives=primitive))
    print(json.dumps(old))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.exit('upgrade_rejected')
