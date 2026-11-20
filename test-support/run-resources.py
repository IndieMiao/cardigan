"""Only processes created by this fixture and its private temp root are used."""
import os
import pathlib
import runpy
import subprocess
import sys
import tempfile
import time
from unittest import mock
from types import SimpleNamespace

source = pathlib.Path(__file__).resolve().parents[1] / 'deploy' / 'run-resources.py'
m = runpy.run_path(str(source))
# The fixture cannot attest to the shared CI host's file table. Inject a
# dedicated reference probe; below, separately test the real lsof call against
# a file actually opened by a synthetic process.
TAG = '1' * 64


def until(pred):
    deadline = time.monotonic()+8
    while not pred():
        if time.monotonic() > deadline:
            raise AssertionError('timed out: ' + pred.__code__.co_name)
        time.sleep(0.025)


def test_runs(base):
    session = subprocess.Popen([sys.executable, '-I', '-c', 'import time;time.sleep(30)'])
    other = subprocess.Popen([sys.executable, '-I', '-c', 'import time;time.sleep(30)'])
    # The managed commands inherit the real exit watch for the synthetic CLI.
    stub = '''import runpy,sys
m=runpy.run_path(sys.argv[1]); m['reclaim'].__defaults__=(lambda path: False,)
m['audit'].__globals__['audit']=lambda *_: None
sys.exit(m['command'](sys.argv[2],sys.argv[3],int(sys.argv[4]),sys.argv[6:],sys.argv[5]))'''
    jobs = []
    try:
        for key in ('A-1.R-1.R-1', 'A-1.R-1.R-2', 'A-2.R-3.R-3'):
            task = '''import os,sys,time,pathlib,subprocess
p=pathlib.Path(os.environ['TMPDIR']); (p/'artifact').write_text('fixture')
if sys.platform == 'linux':
 sub=subprocess.Popen([sys.executable,'-I','-c','import time;time.sleep(25)'],start_new_session=True)
 (p/'detached').write_text(str(sub.pid))
(p/'ready').touch();time.sleep(25)'''
            cli = other if key.startswith('A-2') else session
            job = subprocess.Popen([sys.executable, '-I', '-B', '-c', stub, str(source), TAG, key, str(cli.pid), base,
                                    sys.executable, '-I', '-c', task])
            jobs.append(job)
        root, parent = m['namespace'](TAG, False, base) if os.listdir(base) else (None, '')
        if root is None:
            until(lambda: bool(os.listdir(base)))
            root, parent = m['namespace'](TAG, False, base)
        parent = pathlib.Path(parent)
        keys = ('A-1.R-1.R-1', 'A-1.R-1.R-2', 'A-2.R-3.R-3')
        until(lambda: all((parent/k/'tmp'/'ready').exists() for k in keys))
        if sys.platform == 'linux':
            detached = int((parent/keys[0]/'tmp/detached').read_text())
            watch = m['session_watch'](detached)
        # A shell that launches a service and exits returns its own status;
        # the guardian must still clean the service, not recycle the old PGID.
        starter = "import pathlib,os,sys,subprocess; p=subprocess.Popen([sys.executable,'-I','-c','import time;time.sleep(30)'],start_new_session=sys.platform=='linux'); pathlib.Path(os.environ['TMPDIR'],'orphan').write_text(str(p.pid));sys.exit(7)"
        status = subprocess.run([sys.executable, '-I', '-B', '-c', stub, str(source), TAG, keys[0], str(session.pid), base,
                                 sys.executable, '-I', '-c', starter], timeout=4)
        assert status.returncode == 7
        orphan_exit = m['session_watch'](int((parent/keys[0]/'tmp/orphan').read_text()))
        rows = m['view'](root, 86400, time.time())
        assert all(r['owned'] and not r['closed'] and not r['expired'] for r in rows)
        row = next(row for row in rows if row['key'] == keys[0])
        m['notify'](root, row, 86400, time.time())
        assert jobs[0].wait(timeout=5) == 143
        until(lambda: not (parent/keys[0]).exists())
        assert orphan_exit(), 'background service survived Run end'
        if sys.platform == 'linux':
            assert watch(), 'detached descendant not terminated'
        assert session.poll() is None and jobs[1].poll() is None and jobs[2].poll() is None
        session.terminate(); session.wait(timeout=2)
        assert jobs[1].wait(timeout=5) == 143  # same live CLI, second Run closed only now
        until(lambda: not (parent/keys[1]).exists())
        assert other.poll() is None and jobs[2].poll() is None
        other.terminate(); other.wait(timeout=2)
        assert jobs[2].wait(timeout=5) == 143
        until(lambda: not (parent/keys[2]).exists())
        os.close(root)
    finally:
        for p in [session, other]:
            if p.poll() is None:
                p.terminate(); p.wait(timeout=2)
        for job in jobs:
            job.wait(timeout=6)


def boundaries(base):
    root, parent = m['namespace'](TAG, True, base)
    key = 'A-9.R-9.R-9'
    scope = m['directory'](root, key, True)
    tmp = m['directory'](scope, 'tmp', True)
    path = pathlib.Path(parent)/key/'tmp'
    t = os.fstat(scope).st_mtime
    assert not m['view'](root, 86400, t+86400)[0]['expired']
    row = m['view'](root, 86400, t+86400.1)[0]
    assert row['expired'] and not row['owned']
    try:
        m['notify'](root, row, 86400, t+86401)
        raise AssertionError('orphan without owner')
    except ValueError:
        pass
    m['end'](scope)
    artifact = path/'artifact'; artifact.write_text('preserved')
    with artifact.open():
        # references excludes the steward itself; a distinct fixture process
        # pins the same file so the real positive probe must report busy.
        child = subprocess.Popen([sys.executable, '-I', '-c', 'import sys,time;f=open(sys.argv[1]);print(1,flush=True);time.sleep(10)', str(artifact)], stdout=subprocess.PIPE)
        try:
            assert child.stdout.readline()
            try:
                assert m['references'](str(path))
            except FileNotFoundError:
                # No lsof: the steward skips, not equivalent to an empty result.
                assert not pathlib.Path('/usr/sbin/lsof' if sys.platform == 'darwin' else '/usr/bin/lsof').exists()
            assert m['reclaim'](root,key,scope,tmp,str(path),lambda _:True) == 'in_use'
        finally:
            child.terminate(); child.wait(timeout=2)
    path.rename(path.with_name('old')); path.mkdir(); (path/'keep').touch()
    try:
        m['reclaim'](root,key,scope,tmp,str(path),lambda _:False)
        raise AssertionError('replacement accepted')
    except ValueError:
        pass
    assert (path/'keep').exists() and (path.with_name('old')/'artifact').exists()
    os.close(tmp); os.close(scope); os.close(root)


def darwin_watch():
    ns = m['session_watch'].__globals__
    queue = mock.Mock()
    queue.control.side_effect = [[], [], [object()]]
    native = SimpleNamespace(kqueue=lambda: queue, kevent=lambda *args, **props:(args, props),
                             KQ_FILTER_PROC=-5, KQ_EV_ADD=1, KQ_NOTE_EXIT=1 << 31)
    with mock.patch.dict(ns, sys=SimpleNamespace(platform='darwin'), select=native, birth=lambda _: 'original'):
        observe = m['session_watch'](123, 'original')
        assert not observe() and observe()
        assert queue.control.call_args_list[0].args[0][0][1]['fflags'] == native.KQ_NOTE_EXIT
    # A PID that changed incarnation while the watch was being armed is not
    # exit proof. There is no fallback to kill(pid) on Darwin.
    queue.control.side_effect = None
    with mock.patch.dict(ns, sys=SimpleNamespace(platform='darwin'), select=native,
                         birth=mock.Mock(side_effect=['original','replacement'])):
        try:
            m['session_watch'](123, 'original')
            raise AssertionError('accepted recycled PID')
        except ValueError:
            pass


darwin_watch()
with tempfile.TemporaryDirectory() as base:
    test_runs(base)
with tempfile.TemporaryDirectory() as base:
    boundaries(base)
print('isolated run resources passed', sys.platform)
