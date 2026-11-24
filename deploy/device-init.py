#!/usr/bin/env python3
"""Cardigan one-time device initialisation (C-706).

The Workbench generates this script for one confirmed add-worker wizard and
the person at the new device runs it once with sudo (normally `pair-device.py`
pipes it to `sudo python3 -IB -`, so it is never written to disk). It does
only the following, in this order:

  1. create the dedicated group and account (fixed UID/GID, no password,
     shell /bin/sh, no other groups);
  2. create its HOME, the project work root and the fixed private
     directories, with the ADR 0012 owners and modes;
  3. install the control host's SSH public key as `authorized_keys` with the
     `restrict` option;
  4. write the ADR 0012 claim markers and the installer binding, then run the
     bundled install-*-worker.py `--check` and `--apply` (private layout,
     lock files and worker-primitives.py);
  5. only if the new account's `sudo -n -l` asks for a password, add the
     per-account drop-in `Defaults:<account> listpw=never` (checked with
     `visudo -cf`; it grants nothing).

Every conflict is checked before the first change: an existing account,
group, id, directory or file stops it with nothing changed. It installs no
other software, never edits /etc/sudoers itself, holds no credentials and
deletes itself and its temporary copy of the installer when it ends.
"""
import base64
import grp
import json
import os
import pwd
import re
import shutil
import stat
import subprocess
import sys
import tempfile

# Replaced by the Workbench with base64 JSON literals only.
PLAN = None  # @plan
FILES = None  # @files

MIN_FREE = 1 << 30
TIMEOUT_MS = 15000
PROJECT = re.compile(r'[A-Za-z0-9_][A-Za-z0-9._-]{0,63}')
ACCOUNT = re.compile(r'cg_[a-z0-9_]{1,26}')
KEY = re.compile(r'restrict ssh-ed25519 ([A-Za-z0-9+/]{68})')
KEY_BLOB = b'\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20'
CONFIG_DIR = {'linux': '/etc/cardigan', 'darwin': '/Library/Cardigan'}
SUDOERS_DIR = {'linux': '/etc/sudoers.d', 'darwin': '/private/etc/sudoers.d'}
WORK_PARENTS = {'linux': ('/srv/cardigan-workers', '/home/cardigan-workers'),
                'darwin': ('/Users/cardigan-workers',)}
HOME_PARENT = {'linux': '/home', 'darwin': '/Users'}
INSTALLERS = ('install-macos-worker.py', 'install-linux-worker.py', 'worker-primitives.py')
SAFE_ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C'}
DENIED = ('may not run sudo', 'is not allowed to run sudo', 'is not in the sudoers file')

# Test seam only; always empty when run for real.
PREFIX = ''


class Invalid(Exception):
    """The generated plan is not one this script accepts."""


class Failed(Exception):
    """A change did not complete."""


def at(path):
    return PREFIX + path


def load(plan, files):
    """Validate the embedded plan; the fixed scope cannot be widened by it."""
    if not isinstance(plan, dict) or set(plan) != {
            'version', 'os', 'project', 'account', 'uid', 'gid', 'home', 'work', 'public_key'}:
        raise Invalid('plan')
    system, project, account = plan['os'], plan['project'], plan['account']
    if plan['version'] != 1 or system not in CONFIG_DIR:
        raise Invalid('os')
    if not isinstance(project, str) or not PROJECT.fullmatch(project):
        raise Invalid('project')
    if not isinstance(account, str) or not ACCOUNT.fullmatch(account):
        raise Invalid('account')
    for key in ('uid', 'gid'):
        value = plan[key]
        if type(value) is not int or not 501 <= value <= 2147483647:
            raise Invalid(key)
    if plan['home'] != HOME_PARENT[system] + '/' + account:
        raise Invalid('home')
    if plan['work'] not in [parent + '/' + project for parent in WORK_PARENTS[system]]:
        raise Invalid('work')
    match = KEY.fullmatch(plan['public_key']) if isinstance(plan['public_key'], str) else None
    if not match or not base64.b64decode(match.group(1)).startswith(KEY_BLOB):
        raise Invalid('public_key')
    if not isinstance(files, dict) or set(files) != set(INSTALLERS):
        raise Invalid('files')
    return plan, {name: base64.b64decode(files[name], validate=True) for name in INSTALLERS}


def paths(plan):
    system, account, home, work = plan['os'], plan['account'], plan['home'], plan['work']
    return {
        'config': CONFIG_DIR[system],
        'binding': '%s/worker-%s.json' % (CONFIG_DIR[system], plan['project']),
        'sudoers': '%s/cardigan-worker-%s' % (SUDOERS_DIR[system], account),
        'parent': os.path.dirname(work),
        'keys': home + '/.ssh/authorized_keys',
        'project_marker': home + '/.cardigan-project',
        'worker_marker': work + '/.cardigan-worker',
    }


def actions(plan):
    a, p = plan['account'], paths(plan)
    installer = 'install-%s-worker.py' % ('macos' if plan['os'] == 'darwin' else 'linux')
    return [
        '创建组 %s（GID %d）和账号 %s（UID %d），无密码、shell /bin/sh、不加入其它组' % (a, plan['gid'], a, plan['uid']),
        '创建 %s（root:%s 0750），其中 .ssh、.local、.local/bin 为 root:%s 0750，'
        '.config、.cache、.local/state、.local/share 为 %s 0700' % (plan['home'], a, a, a),
        '创建工作根 %s（root:%s 0750）；%s 不存在时创建为 root 0755' % (plan['work'], a, p['parent']),
        '写入 %s（root:%s 0640）：控制主机的 SSH 公钥，带 restrict' % (p['keys'], a),
        '写入认领标记 %s、%s 和安装配置 %s（root 持有）' % (p['project_marker'], p['worker_marker'], p['binding']),
        '用随附的 %s 先 --check 再 --apply：创建私有目录、锁文件和 worker-primitives.py' % installer,
        '仅当 %s 执行 sudo -n -l 被要求输入密码时，写入 %s，内容只有 Defaults:%s listpw=never（visudo 校验，不授予任何命令）'
        % (a, p['sudoers'], a),
        '结束后删除本脚本和临时文件；不安装其它软件，不修改 /etc/sudoers',
    ]


# Operations below are module functions so tests can observe them.

def is_root():
    return os.geteuid() == 0


def current_os():
    return 'darwin' if sys.platform == 'darwin' else 'linux' if sys.platform.startswith('linux') else None


def run(argv):
    result = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            env=SAFE_ENV, timeout=120)
    if result.returncode != 0:
        raise Failed('%s 退出码 %d' % (os.path.basename(argv[0]), result.returncode))
    return result.stdout.decode('utf-8', 'replace')


def chown(fd, uid, gid):
    os.fchown(fd, uid, gid)


def tool(name):
    return shutil.which(name, path=SAFE_ENV['PATH'])


def user_taken(name=None, uid=None):
    try:
        pwd.getpwnam(name) if name is not None else pwd.getpwuid(uid)
        return True
    except KeyError:
        return False


def group_taken(name=None, gid=None):
    try:
        grp.getgrnam(name) if name is not None else grp.getgrgid(gid)
        return True
    except KeyError:
        return False


def directory_records(kind, attribute):
    """`dscl . -list` of local records; complements the system lookups on macOS."""
    out = run(['/usr/bin/dscl', '.', '-list', kind, attribute])
    return [line.split() for line in out.splitlines() if line.strip()]


def sudo_listing(account):
    """What the new account sees for `sudo -n -l`, as the wizard asks it over SSH."""
    result = subprocess.run(['/usr/bin/sudo', '-n', '-u', account, '--', '/usr/bin/env', 'LC_ALL=C',
                             '/usr/bin/sudo', '-n', '-l'],
                            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            env=SAFE_ENV, timeout=60, cwd='/')
    text = result.stdout.decode('utf-8', 'replace')
    if result.returncode != 0 and any(mark in text for mark in DENIED):
        return 'denied'
    if result.returncode != 0 and 'a password is required' in text:
        return 'password'
    return 'other'


def install_layout(system, project, files):
    """Run the bundled installer from a root-only temporary directory."""
    directory = tempfile.mkdtemp(prefix='cardigan-init-')
    try:
        for name, data in files.items():
            fd = os.open(os.path.join(directory, name), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'wb') as out:
                out.write(data)
        entry = os.path.join(directory, 'install-%s-worker.py' % ('macos' if system == 'darwin' else 'linux'))
        for flag in ('--check', '--apply'):
            run([sys.executable, '-IB', entry, '--project', project, flag])
    finally:
        shutil.rmtree(directory, ignore_errors=True)


def mount_of(system, path):
    """The mount point of an existing path, as the installer checks it."""
    if system == 'darwin':
        lines = run(['/bin/df', '-P', path]).splitlines()
        fields = lines[-1].split(None, 5) if len(lines) >= 2 else []
        if len(fields) != 6 or not fields[5].startswith('/'):
            raise Failed('无法确定 %s 所在的卷' % path)
        return fields[5]
    current = path
    while not os.path.ismount(current):
        current = os.path.dirname(current)
    return current


def account_record(name):
    entry = pwd.getpwnam(name)
    return entry.pw_uid, entry.pw_gid, entry.pw_dir


def owned_directory(path, uid, gid, mode):
    info = os.lstat(at(path))
    return (stat.S_ISDIR(info.st_mode) and info.st_uid == uid and info.st_gid == gid
            and stat.S_IMODE(info.st_mode) == mode)


def preflight(plan):
    """All conflicts, before any change. Empty means safe to proceed."""
    system, a, uid, gid = plan['os'], plan['account'], plan['uid'], plan['gid']
    p, problems = paths(plan), []
    if user_taken(name=a):
        problems.append('账号 %s 已存在；不接管已有账号' % a)
    if user_taken(uid=uid):
        problems.append('UID %d 已被占用' % uid)
    if group_taken(name=a):
        problems.append('组 %s 已存在' % a)
    if group_taken(gid=gid):
        problems.append('GID %d 已被占用' % gid)
    if system == 'darwin':
        for kind, attribute, value, what in (('/Users', 'UniqueID', uid, 'UID'), ('/Groups', 'PrimaryGroupID', gid, 'GID')):
            try:
                records = directory_records(kind, attribute)
            except (OSError, subprocess.SubprocessError, Failed):
                problems.append('无法读取本机目录服务的 %s 记录' % kind)
                continue
            for record in records:
                if record[0] == a or record[1:] == [str(value)]:
                    problems.append('本机目录服务已有 %s 或 %s %d' % (a, what, value))
                    break
    else:
        for name in ('groupadd', 'useradd', 'visudo'):
            if tool(name) is None:
                problems.append('找不到 %s' % name)
    for path in (plan['home'], plan['work'], p['binding'], p['sudoers']):
        if os.path.lexists(at(path)):
            problems.append('%s 已存在；请先核对，不覆盖' % path)
    for top in (HOME_PARENT[system], os.path.dirname(p['parent'])):
        try:
            info = os.lstat(at(top))
        except FileNotFoundError:
            problems.append('%s 不存在' % top)
            continue
        if not stat.S_ISDIR(info.st_mode):
            problems.append('%s 不是目录（不跟随符号链接）' % top)
        elif os.statvfs(at(top)).f_flag & os.ST_RDONLY:
            problems.append('%s 所在分区只读' % top)
    if os.path.lexists(at(p['parent'])) and not owned_directory(p['parent'], 0, 0, 0o755):
        problems.append('%s 已存在但不是 root 持有的 0755 目录' % p['parent'])
    if os.path.lexists(at(p['config'])):
        if not owned_directory(p['config'], 0, 0, 0o700):
            problems.append('%s 已存在但不是 root 持有的 0700 目录' % p['config'])
        else:
            for name in sorted(os.listdir(at(p['config']))):
                if name != 'worker.json' and not (name.startswith('worker-') and name.endswith('.json')):
                    continue
                try:
                    with open(os.path.join(at(p['config']), name), encoding='utf-8') as f:
                        same = json.load(f).get('project') == plan['project']
                except (OSError, ValueError, AttributeError):
                    same = True
                if same:
                    problems.append('%s/%s 已登记本项目或无法读取；请先核对' % (p['config'], name))
    if not problems:
        try:
            mount = mount_of(system, at(os.path.dirname(p['parent'])))
            for path in ('/', mount):
                space = os.statvfs(at(path))
                if space.f_bavail * space.f_frsize < MIN_FREE:
                    problems.append('%s 可用空间不足 1 GiB' % path)
        except (OSError, Failed) as error:
            problems.append('无法读取工作根所在的卷：%s' % error)
    return problems


def initialise(plan, files, created):
    system, a, uid, gid = plan['os'], plan['account'], plan['uid'], plan['gid']
    home, work, p = plan['home'], plan['work'], paths(plan)

    def make_dir(path, owner, group, mode):
        os.mkdir(at(path), 0o700)
        created.append(path)
        fd = os.open(at(path), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            chown(fd, owner, group)
            os.fchmod(fd, mode)
        finally:
            os.close(fd)

    def write_new(path, data, group, mode):
        fd = os.open(at(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        created.append(path)
        with os.fdopen(fd, 'wb') as out:
            chown(out.fileno(), 0, group)
            os.fchmod(out.fileno(), mode)
            out.write(data)

    # 1. Account.
    if system == 'darwin':
        dscl = '/usr/bin/dscl'
        run([dscl, '.', '-create', '/Groups/' + a])
        created.append('group:' + a)
        run([dscl, '.', '-create', '/Groups/' + a, 'PrimaryGroupID', str(gid)])
        run([dscl, '.', '-create', '/Users/' + a])
        created.append('account:' + a)
        for attribute, value in (('UniqueID', uid), ('PrimaryGroupID', gid), ('NFSHomeDirectory', home),
                                 ('UserShell', '/bin/sh')):
            run([dscl, '.', '-create', '/Users/' + a, attribute, str(value)])
    else:
        run([tool('groupadd'), '--gid', str(gid), a])
        created.append('group:' + a)
        run([tool('useradd'), '--uid', str(uid), '--gid', str(gid), '--home-dir', home, '--no-create-home',
             '--shell', '/bin/sh', a])
        created.append('account:' + a)
    if account_record(a) != (uid, gid, home):
        raise Failed('新账号的 UID、GID 或 HOME 与计划不符')

    # 2. HOME and the work root.
    make_dir(home, 0, gid, 0o750)
    for name in ('.ssh', '.local', '.local/bin'):
        make_dir(home + '/' + name, 0, gid, 0o750)
    for name in ('.config', '.cache', '.local/state', '.local/share'):
        make_dir(home + '/' + name, uid, gid, 0o700)
    if not os.path.lexists(at(p['parent'])):
        make_dir(p['parent'], 0, 0, 0o755)
    make_dir(work, 0, gid, 0o750)

    # 3. SSH public key.
    write_new(p['keys'], (plan['public_key'] + '\n').encode('ascii'), gid, 0o640)

    # 4. ADR 0012 markers, installer binding and the private layout.
    write_new(p['project_marker'], json.dumps({'project': plan['project'], 'uid': uid}).encode(), 0, 0o644)
    write_new(p['worker_marker'], json.dumps({'project': plan['project'], 'uid': uid, 'home': home}).encode(), 0, 0o600)
    if not os.path.lexists(at(p['config'])):
        make_dir(p['config'], 0, 0, 0o700)
    mount = mount_of(system, at(work))
    write_new(p['binding'], json.dumps({
        'account': a, 'uid': uid, 'project': plan['project'], 'root': work,
        'mount': mount, 'volume': str(os.statvfs(at(mount)).f_fsid),
        'minimum_free_bytes': {'root': MIN_FREE, 'work': MIN_FREE},
        'timeout_ms': TIMEOUT_MS,
    }).encode(), 0, 0o600)
    install_layout(system, plan['project'], files)

    # 5. The wizard asks `sudo -n -l` as the account; some sudo versions ask
    #    for a password instead of refusing. Only then add the listing default.
    listing = sudo_listing(a)
    if listing == 'password':
        if not os.path.isdir(at(SUDOERS_DIR[system])):
            raise Failed('%s 不存在，无法免去 sudo -l 的密码询问' % SUDOERS_DIR[system])
        staged = p['sudoers'] + '.new'  # sudo skips names containing a dot
        write_new(staged, ('Defaults:%s listpw=never\n' % a).encode('ascii'), 0, 0o440)
        run([tool('visudo') or '/usr/sbin/visudo', '-cf', at(staged)])
        os.link(at(staged), at(p['sudoers']))
        created.append(p['sudoers'])
        os.unlink(at(staged))
        created.remove(staged)
        listing = sudo_listing(a)
    if listing != 'denied':
        raise Failed('%s 执行 sudo -n -l 没有得到明确拒绝；请核对 sudo 策略' % a)


def cleanup_hint(system, created):
    lines = []
    names = [item.split(':', 1) for item in created if ':' in item and not item.startswith('/')]
    files = [item for item in created if item.startswith('/')]
    tops = [f for f in files if not any(f != other and f.startswith(other + '/') for other in files)]
    for path in reversed(tops):
        lines.append('sudo rm -r -- %s' % path)
    for kind, name in reversed(names):
        if system == 'darwin':
            lines.append('sudo dscl . -delete /%s/%s' % ('Users' if kind == 'account' else 'Groups', name))
        else:
            lines.append('sudo %s %s' % ('userdel' if kind == 'account' else 'groupdel', name))
    return lines


def main(argv):
    try:
        plan, files = load(PLAN, FILES)
    except (Invalid, ValueError, TypeError) as error:
        print('初始化脚本内容无效（%s），请回到 Workbench 重新生成。' % error, file=sys.stderr)
        return 2
    if argv == ['--list']:
        for number, item in enumerate(actions(plan), 1):
            print('%d. %s' % (number, item))
        return 0
    if argv:
        print('用法：sudo python3 -IB <本脚本>（或 --list 只列出将做的操作）', file=sys.stderr)
        return 2
    if current_os() != plan['os']:
        print('这份初始化脚本是给 %s 生成的，与本机系统不符。' % plan['os'], file=sys.stderr)
        return 2
    if not is_root():
        print('需要用 sudo 运行。', file=sys.stderr)
        return 2
    try:
        problems = preflight(plan)
    except Exception as error:  # nothing has changed yet
        print('检查本机失败（%s），未做任何改动。' % type(error).__name__, file=sys.stderr)
        return 3
    if problems:
        print('发现冲突，未做任何改动：', file=sys.stderr)
        for problem in problems:
            print('  - ' + problem, file=sys.stderr)
        return 3
    created = []
    try:
        initialise(plan, files, created)
    except Exception as error:  # report what exists now; never undo silently
        print('初始化失败：%s' % (error if isinstance(error, Failed) else type(error).__name__), file=sys.stderr)
        if created:
            print('已创建以下内容，核对后可按需手工删除再重试：', file=sys.stderr)
            for line in cleanup_hint(plan['os'], created):
                print('  ' + line, file=sys.stderr)
        return 1
    print('初始化完成：账号 %s（UID %d），工作根 %s。' % (plan['account'], plan['uid'], plan['work']))
    return 0


def remove_self(argv):
    """Delete this script when it was run from a file; stdin leaves nothing."""
    path = sys.argv[0] if sys.argv else ''
    if argv == ['--list'] or path in ('', '-', '-c'):
        return
    try:
        if stat.S_ISREG(os.lstat(path).st_mode):
            os.unlink(path)
    except OSError:
        pass


if __name__ == '__main__':
    code = 2
    try:
        code = main(sys.argv[1:])
    finally:
        remove_self(sys.argv[1:])
    sys.exit(code)
