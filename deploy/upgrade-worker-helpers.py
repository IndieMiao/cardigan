"""Human-run upgrade. The controller appends the pinned binding to this release script."""
import base64
import hashlib
import json
import os
from pathlib import Path
import platform
import pwd
import runpy
import shutil
import stat
import sys
import tarfile
import tempfile


def require(ok):
    if not ok:
        raise ValueError('worker_upgrade_precondition_failed')


def unpack(archive, dest):
    # Accept only release directories and plain files; never extract links or metadata.
    with tarfile.open(archive, 'r:gz') as tar:
        for member in tar:
            name = Path(member.name)
            require(name.parts[:1] == ('deploy',) and '..' not in name.parts)
            path = dest / name
            if member.isdir():
                path.mkdir(mode=0o755)
            else:
                require(member.isfile())
                with tar.extractfile(member) as src, path.open('xb') as out:
                    shutil.copyfileobj(src, out)
                path.chmod(0o755 if member.mode & 0o111 else 0o644)


def upgrade(encoded):
    b = json.loads(base64.b64decode(encoded))
    mac = b['os'] == 'darwin'
    require(os.geteuid() == 0 and platform.system() == ('Darwin' if mac else 'Linux'))
    work = Path.cwd()
    require(work.stat().st_uid == 0 and stat.S_IMODE(work.stat().st_mode) == 0o700)
    print('备份位置：', work, flush=True)
    unpack(work / 'deploy.tar.gz', work)
    release = work / 'deploy'
    installer = runpy.run_path(str(release / 'install-macos-worker.py'))
    config_path = Path('/Library/Cardigan/worker.json' if mac else '/etc/cardigan/worker.json')
    config = installer['trusted_json'](config_path)
    account = pwd.getpwnam(config['account'])
    require(config['project'] == b['project'] and config['root'] == b['root'] and
            config['account'] == b['account'] and config['uid'] == account.pw_uid > 0 and
            b['gid'] == account.pw_gid)
    root = Path(b['root'])
    require(installer['trusted_json'](root / '.cardigan-worker') == {
        'project': b['project'], 'uid': account.pw_uid, 'home': account.pw_dir})
    files, git = Path(b['files']), Path(b['git'])
    targets = {files: 'worker-files.py', git: 'worker-git.py',
               files.with_name('worker-primitives.py'): 'worker-primitives.py',
               git.with_name('worker-primitives.py'): 'worker-primitives.py',
               root / 'libexec/worker-primitives.py': 'worker-primitives.py'}
    native = runpy.run_path(str(release / 'worker-primitives.py'))
    # All destinations must already be protected helpers of the configured project.
    # Validate the entire set and save backups before replacing the first file.
    for i, target in enumerate(targets):
        installer['protected'](target.parent)
        with os.fdopen(os.open(target, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as src:
            s = os.fstat(src.fileno())
            require(stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and s.st_uid == 0 and
                    s.st_gid == b['gid'] and stat.S_IMODE(s.st_mode) == 0o750 and native['acl_safe'](src.fileno()))
            with (work / ('backup-%d-%s' % (i, target.name))).open('xb') as out:
                shutil.copyfileobj(src, out)
    for target, name in targets.items():
        data = (release / name).read_bytes()
        with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as tmp:
            tmp.write(data)
            tmp.flush()
            os.fchown(tmp.fileno(), 0, account.pw_gid)
            os.fchmod(tmp.fileno(), 0o750)
        os.replace(tmp.name, target)
        require(hashlib.sha256(target.read_bytes()).digest() == hashlib.sha256(data).digest())
    sys.argv = ['installer', '--config', str(config_path), '--check']
    installer['main']('Darwin' if mac else 'Linux')
    print('worker_helper_upgrade_ok', work)
