"""Synthetic readiness observations; group policy runs the real shared primitive."""
import types

account = types.SimpleNamespace(pw_name='cg_example', pw_uid=2201, pw_gid=r['gid'], pw_dir='/Users/cg_example')
native = types.ModuleType('worker_native')
exec(r['native_source'], native.__dict__)
exec(r['group_fixture'])
install_group_observations(native.__dict__, account, r['fixture'], r['system'])
os.getuid = os.geteuid = lambda: account.pw_uid
os.getgid = os.getegid = lambda: account.pw_gid
native.isolation_directory = lambda *args: os.open('/dev/null', os.O_RDONLY)
git = types.SimpleNamespace(native=native, Workspace=lambda: None,
                            check_layout=lambda *args: os.open('/dev/null', os.O_RDONLY))
files = types.SimpleNamespace(namespace=lambda: None)
pathlib.Path.read_bytes = lambda self: b'fixture'
protected = lambda path: None
module = lambda path, name: git if name == 'worker_git' else files
pathlib.Path.lstat = lambda path: types.SimpleNamespace(st_mode=stat.S_IFREG | 0o660,
                                                        st_uid=0, st_gid=r['gid'], st_nlink=1)
def run(argv, **kwargs):
    if argv == ['git', '--version']:
        return types.SimpleNamespace(returncode=0)
    assert argv == ['/bin/pwd', '-P'] and r['system'] == 'Darwin'
    return types.SimpleNamespace(stdout=os.fsencode(kwargs['cwd'].removeprefix('/System/Volumes/Data')) + b'\n')
subprocess.run = run
subprocess.check_output = lambda *args, **kwargs: r['version'].encode()
