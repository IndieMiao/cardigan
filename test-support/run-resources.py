"""Only processes created by this fixture and its private temp root are used."""
import fcntl
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
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
TAG = '1' * 64
# Never send inherited credentials to the fixture HTTP listener.
os.environ['MCP_TOKEN'] = 'synthetic'
states = {}
class Authority(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        if self.headers.get('Authorization') != 'Bearer synthetic':
            self.send_error(403); return
        key = self.path.split('=', 1)[-1]
        row = dict(key=key, project='fixture', machine='isolated', state=states.get(key, 'active'))
        self.send_response(200); self.end_headers(); self.wfile.write(json.dumps(row).encode())

http = ThreadingHTTPServer(('127.0.0.1', 0), Authority)
threading.Thread(target=http.serve_forever, daemon=True).start()
stub = f"""import runpy,sys,os
m=runpy.run_path(sys.argv[1]);m['host_state'].__globals__['AUTHORITY']=['http://127.0.0.1:{http.server_port}/mcp','fixture','isolated']
c=m['Confirmation'](sys.argv[3],os.environ['MCP_TOKEN'],interval=0.05)
sys.exit(m['command'](sys.argv[2],sys.argv[3],int(sys.argv[4]),sys.argv[6:],sys.argv[5],confirmation=c))"""


def until(pred):
    deadline = time.monotonic()+8
    while not pred():
        if time.monotonic() > deadline:
            raise AssertionError('timed out: ' + pred.__code__.co_name)
        time.sleep(0.025)


def test_runs(base):
    session = subprocess.Popen([sys.executable, '-I', '-c', 'import time;time.sleep(30)'])
    other = subprocess.Popen([sys.executable, '-I', '-c', 'import time;time.sleep(30)'])
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
        until(lambda: all((parent/m['scope_name'](k)/'tmp'/'ready').exists() for k in keys))
        if sys.platform == 'linux':
            detached = int((parent/m['scope_name'](keys[0])/'tmp/detached').read_text())
            watch = m['session_watch'](detached)
        # A shell that launches a service and exits returns its own status;
        # the guardian must still clean the service, not recycle the old PGID.
        starter = "import pathlib,os,sys,subprocess; p=subprocess.Popen([sys.executable,'-I','-c','import time;time.sleep(30)'],start_new_session=sys.platform=='linux'); pathlib.Path(os.environ['TMPDIR'],'orphan').write_text(str(p.pid));sys.exit(7)"
        status = subprocess.run([sys.executable, '-I', '-B', '-c', stub, str(source), TAG, keys[0], str(session.pid), base,
                                 sys.executable, '-I', '-c', starter], timeout=4)
        assert status.returncode == 7
        orphan_exit = m['session_watch'](int((parent/m['scope_name'](keys[0])/'tmp/orphan').read_text()))
        scratch = parent/m['scope_name'](keys[0])
        (scratch/'end').touch()  # disk hints have no authority
        states[keys[0]] = 'unknown'; time.sleep(0.4)
        states[keys[0]] = 'expired_preview'; time.sleep(0.4)
        assert jobs[0].poll() is None and not orphan_exit()
        kept = scratch/'tmp'/'artifact'
        with kept.open() as reference:
            (scratch/'tmp').rename(scratch/'original')
            (scratch/'tmp').mkdir(); (scratch/'tmp'/'keep').symlink_to(kept.parent.parent/'original'/'artifact')
            states[keys[0]] = 'ended'
            assert jobs[0].wait(timeout=5) == 143
            assert reference.read() == 'fixture' and (scratch/'tmp'/'keep').read_text() == 'fixture'
        until(orphan_exit)
        if sys.platform == 'linux':
            assert watch(), 'detached descendant not terminated'
        assert session.poll() is None and jobs[1].poll() is None and jobs[2].poll() is None
        session.terminate(); session.wait(timeout=2)
        assert jobs[1].wait(timeout=5) == 143  # same live CLI, second Run closed only now
        assert (parent/m['scope_name'](keys[1])/'tmp'/'ready').exists()
        assert other.poll() is None and jobs[2].poll() is None
        other.terminate(); other.wait(timeout=2)
        assert jobs[2].wait(timeout=5) == 143
        assert (parent/m['scope_name'](keys[2])/'tmp'/'ready').exists()
        os.close(root)
    finally:
        for p in [session, other]:
            if p.poll() is None:
                p.terminate(); p.wait(timeout=2)
        for job in jobs:
            job.wait(timeout=6)


def foreground_contracts(base):
    # Only fixture children, its own advisory lock and private scratch.
    key = 'A-1696.R-8660.R-8759'
    session = subprocess.Popen([sys.executable, '-I', '-c', 'import time;time.sleep(40)'])
    entry = [sys.executable, '-IB', '-c', stub, str(source), TAG, key, str(session.pid), base,
             sys.executable, '-I', '-c']
    child = None
    try:
        with open(pathlib.Path(base)/'lock', 'wb') as locked:
            fcntl.flock(locked, fcntl.LOCK_EX)
            result = subprocess.run([*entry, "import os,socket;s=socket.socket(socket.AF_UNIX);s.bind(os.path.join(os.environ['TMPDIR'],'service.sock'))"],
                                    pass_fds=(locked.fileno(),), timeout=4)
            assert result.returncode == 0
        with open(pathlib.Path(base)/'lock', 'rb') as check:
            fcntl.flock(check, fcntl.LOCK_EX | fcntl.LOCK_NB)
        root, parent = m['namespace'](TAG, False, base)
        os.close(root)
        scope = pathlib.Path(parent)/m['scope_name'](key)
        ready = scope/'tmp'/'foreground'
        child = subprocess.Popen([*entry, "import os,pathlib,time;pathlib.Path(os.environ['TMPDIR'],'foreground').write_text(str(os.getpid()));time.sleep(30)"])
        until(lambda: ready.exists() and ready.read_text())
        exited = m['session_watch'](int(ready.read_text()))
        child.terminate(); child.wait(timeout=3)
        until(exited)
        assert session.poll() is None
    finally:
        session.terminate(); session.wait(timeout=3)
        if child is not None:
            child.wait(timeout=3)
    assert (scope/'tmp'/'service.sock').exists()


def session_bypass(base):
    # No run-command registration involved. Fake CLI starts its observer as
    # the real wrapper does and immediately creates a direct setsid child.
    if sys.platform != 'linux': return
    ready = pathlib.Path(base)/'bypass'
    session = subprocess.Popen([sys.executable, '-IB', '-c', """import os,pathlib,subprocess,sys,time
subprocess.run([sys.executable,'-IB',sys.argv[1],'observe-session',str(os.getpid()),'A-7.R-9'],check=True,stdout=subprocess.DEVNULL)
p=subprocess.Popen([sys.executable,'-I','-c','import time;time.sleep(20)'],start_new_session=True)
pathlib.Path(sys.argv[2]).write_text(str(p.pid));time.sleep(20)""", str(source), str(ready)])
    try:
        until(lambda: ready.exists() and ready.read_text())
        watch = m['session_watch'](int(ready.read_text()))
        time.sleep(1.1)
        assert not watch()
    finally:
        session.terminate(); session.wait(timeout=3)
    until(watch)


def observer_enrollment():
    # Synthetic parent identity and fake handles; never look up a recycled PID.
    ns = m['install_observer'].__globals__
    for parent, already_dead, accepted in [(73, False, True), (1, False, False), (73, True, False)]:
        system = mock.Mock()
        system.getppid.side_effect = [73, parent]
        system.pidfd_open.return_value = 42
        system.fork.return_value = 11
        with mock.patch.dict(ns, os=system, sys=SimpleNamespace(platform='linux'),
                             dead=lambda fd: already_dead, birth=lambda pid: 'same-stamp'):
            try:
                assert m['install_observer'](73, 'A-1.R-1') == 'same-stamp' and accepted
            except ValueError:
                assert not accepted
        assert system.fork.call_count == int(accepted)
        system.close.assert_called_once_with(42)


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


with tempfile.TemporaryDirectory() as base:
    assert m['preview'](TAG, 86400, 0, base)['expired'] == 0 and not os.listdir(base)
    root, path = m['namespace'](TAG, True, base)
    fd = m['directory'](root, '1.1.1', True)
    t = os.fstat(fd).st_mtime
    os.symlink('absent', '2.2.2', dir_fd=root)
    assert m['preview'](TAG, 86400, t+86400, base) == dict(expired=0,unknown=1,partial=False)
    assert m['preview'](TAG, 86400, t+86401, base) == dict(expired=1,unknown=1,partial=False)
    assert sorted(os.listdir(root)) == ['1.1.1','2.2.2']
    os.close(fd); os.close(root)
# A failed observation must not translate to an exit. The same guard retries.
reply = mock.Mock(side_effect=[TimeoutError(), 'expired_preview', 'ended'])
check = m['Confirmation']('A-1.R-1.R-1', 'synthetic', read=reply, interval=0)
assert [check.state() for _ in range(3)] == ['unknown', 'expired_preview', 'ended']
darwin_watch()
observer_enrollment()
# Simulate positive and incomplete Darwin group snapshots; not a macOS host run.
for n, member, expected in [(4,123,True),(4,456,False),(0,123,False),(8,123,False)]:
    def listing(kind, anchor, pids, size):
        assert kind == 2 and anchor == 123
        pids[0] = member
        return n
    with mock.patch.object(m['ctypes'], 'CDLL', return_value=SimpleNamespace(proc_listpids=listing)):
        assert m['darwin_group_empty'](123) == expected
with tempfile.TemporaryDirectory(dir='/tmp', prefix='cr') as base:
    foreground_contracts(base)
with tempfile.TemporaryDirectory() as base:
    test_runs(base)
with tempfile.TemporaryDirectory() as base:
    session_bypass(base)
http.shutdown(); http.server_close()
print('isolated run resources passed', sys.platform)
