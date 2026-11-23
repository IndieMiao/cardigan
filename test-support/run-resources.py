"""Only processes created by this fixture and its private temp root are used."""
import errno
import fcntl
import http.client as http_client
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
import pathlib
import runpy
import socket
import select
import re
import subprocess
import sys
import tempfile
import time
from collections import Counter
from unittest import mock
from types import SimpleNamespace

source = pathlib.Path(__file__).resolve().parents[1] / 'deploy' / 'run-resources.py'
m = runpy.run_path(str(source))
TAG = '1' * 64
# Never send inherited credentials to the fixture HTTP listener.
os.environ['MCP_TOKEN'] = 'synthetic'
# Use a fresh, synthetic controller signing key. It never leaves this fixture.
import base64, hashlib, hmac
keydir = tempfile.TemporaryDirectory()
private = str(pathlib.Path(keydir.name)/'controller.pem')
subprocess.run(['/usr/bin/openssl','genpkey','-algorithm','EC','-pkeyopt','ec_paramgen_curve:P-256','-out',private], check=True, stderr=subprocess.DEVNULL)
public = subprocess.check_output(['/usr/bin/openssl','pkey','-in',private,'-pubout']).decode()
states = {}
served = Counter()
held_terminal = {}
class Authority(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        assert self.headers.get('Authorization') is None
        key = self.path.split('=', 1)[-1]
        nonce = self.headers['X-Resource-Nonce']
        registration = self.headers['X-Resource-Registration']
        proof = hmac.new(hashlib.sha256(b'synthetic').digest(),f'resource-read-v1:{registration}:{key}:{nonce}'.encode(),'sha256').hexdigest()
        if not hmac.compare_digest(self.headers['X-Resource-Proof'],proof):
            self.send_error(403); return
        if states.get(key) == 'unanswered':  # a read that fails outright
            served[key, 'unanswered'] += 1
            self.send_error(503); return
        state = states.get(key, 'active')
        if state == 'slow':  # a saturated link: answer after 3 s
            time.sleep(3); state = 'active'
        if state == 'ended' and key in held_terminal:
            arrived, release = held_terminal[key]
            arrived.set(); assert release.wait(timeout=2)
        payload = json.dumps(['resource-state-v1',registration,nonce if state != 'stale' else 'old',key,'fixture','isolated',state if state not in ('bad-signature','stale') else 'ended'])
        sig = subprocess.run(['/usr/bin/openssl','dgst','-sha256','-sign',private], input=payload.encode(),check=True,stdout=subprocess.PIPE).stdout
        row = dict(payload=payload,signature=base64.b64encode(sig if state != 'bad-signature' else b'invalid').decode())
        self.send_response(200); self.end_headers(); self.wfile.write(json.dumps(row).encode())
        served[key, state] += 1

http = ThreadingHTTPServer(('127.0.0.1', 0), Authority)
threading.Thread(target=http.serve_forever, daemon=True).start()
# A syslog implementation with a cached descriptor, independent of the host's
# log daemon. Never write through a descriptor if the guardian has recycled it.
cached_audit = f"""class AuditSink:
    LOG_NOTICE = 5
    fd = None
    path = {str(pathlib.Path(keydir.name)/'audit')!r}
    def syslog(self, level, message):
        if self.fd is None: self.fd = os.open(self.path, os.O_APPEND|os.O_WRONLY|os.O_CREAT, 0o600)
        assert os.path.samestat(os.fstat(self.fd), os.stat(self.path)), 'stale audit descriptor'
        os.write(self.fd, (message+chr(10)).encode())
    def closelog(self):
        if self.fd is not None: os.close(self.fd); self.fd = None
m['audit'].__globals__['syslog'] = AuditSink()"""


def entry(audit_sink="", vite_entry=False):
    setup = f"""import runpy,sys,os,hashlib
m=runpy.run_path(sys.argv[1]);m['host_state'].__globals__['AUTHORITY']=['http://127.0.0.1:{http.server_port}/mcp','fixture','isolated','fixture-token-id',{public!r}]
{audit_sink}
c=m['Confirmation'](sys.argv[3],hashlib.sha256(os.environ['MCP_TOKEN'].encode()).digest(),interval=0.05)
"""
    if not vite_entry:
        return setup + "sys.exit(m['command'](sys.argv[2],sys.argv[3],int(sys.argv[4]),sys.argv[6:],sys.argv[5],confirmation=c))"
    # Exercise --private-vite itself. Only replace the scratch root, test
    # controller and wrapper used to reap the fixture's own Node process.
    return setup + """tag,key,pid,base,wrapper,owner,flag,port=sys.argv[2:]
command=m['command']
def fixture_command(tag,key,pid,argv,**opts):
 return command(tag,key,pid,[sys.executable,'-IB','-c',wrapper,*argv],base=base,confirmation=c,**opts)
m['main'].__globals__.update(VITE_OWNER=owner,command=fixture_command)
session,run=key.rsplit('.',1)
os.environ.update(CARDIGAN_RESOURCE_TARGET=tag,CARDIGAN_RESOURCE_SESSION=session,
 CARDIGAN_SESSION_PID=pid,CARDIGAN_SESSION_BIRTH=m['birth'](int(pid)))
sys.argv[1:]=[run,flag,port];m['main']()"""


stub = entry()


def until(pred):
    deadline = time.monotonic()+8
    while not pred():
        if time.monotonic() > deadline:
            raise AssertionError('timed out: ' + pred.__code__.co_name)
        time.sleep(0.025)


# Test participant has no public endpoint. An inherited fd is its enrollment,
# not its name, PID, process group, or an environment variable alone.
WAIT = "import os,socket;s=socket.socket(fileno=int(os.environ['CARDIGAN_PRIVATE_LIFETIME_FD']));s.settimeout(20);assert s.recv(128,socket.MSG_PEEK)==b'cardigan-private-settled-v1\\n'"


def test_runs(base):
    session = subprocess.Popen([sys.executable, '-I', '-c', 'import time;time.sleep(30)'])
    other = subprocess.Popen([sys.executable, '-I', '-c', 'import time;time.sleep(30)'])
    jobs = []
    try:
        for key in ('A-1.R-1.R-1', 'A-1.R-1.R-2', 'A-2.R-3.R-3'):
            task = f"""import os,sys,pathlib,subprocess
p=pathlib.Path(os.environ['TMPDIR']); (p/'artifact').write_text('fixture')
sub=subprocess.Popen([sys.executable,'-I','-c',{WAIT!r}],pass_fds=(int(os.environ['CARDIGAN_PRIVATE_LIFETIME_FD']),),start_new_session=True)
(p/'detached').write_text(str(sub.pid)); (p/'ready').touch()
{WAIT}"""
            cli = other if key.startswith('A-2') else session
            job = subprocess.Popen([sys.executable, '-I', '-B', '-c', stub, str(source), TAG, key, str(cli.pid), base,
                                    sys.executable, '-I', '-c', task], stderr=subprocess.PIPE)
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
        starter = f"import pathlib,os,sys,subprocess; p=subprocess.Popen([sys.executable,'-I','-c',{WAIT!r}],pass_fds=(int(os.environ['CARDIGAN_PRIVATE_LIFETIME_FD']),),start_new_session=True); pathlib.Path(os.environ['TMPDIR'],'orphan').write_text(str(p.pid));sys.exit(7)"
        status = subprocess.run([sys.executable, '-I', '-B', '-c', entry(cached_audit), str(source), TAG, keys[0], str(session.pid), base,
                                 sys.executable, '-I', '-c', starter], timeout=4)
        assert status.returncode == 7
        orphan_exit = m['session_watch'](int((parent/m['scope_name'](keys[0])/'tmp/orphan').read_text()))
        scratch = parent/m['scope_name'](keys[0])
        (scratch/'end').touch()  # disk hints have no authority
        for answer in ('unknown','bad-signature','stale','expired_preview'):
            states[keys[0]] = answer
            until(lambda: served[keys[0], answer] >= 3)
            assert jobs[0].poll() is None and not orphan_exit(), answer
        kept = scratch/'tmp'/'artifact'
        with kept.open() as reference:
            (scratch/'tmp').rename(scratch/'original')
            (scratch/'tmp').mkdir(); (scratch/'tmp'/'keep').symlink_to(kept.parent.parent/'original'/'artifact')
            states[keys[0]] = 'ended'
            assert jobs[0].wait(timeout=5) == 143
            assert reference.read() == 'fixture' and (scratch/'tmp'/'keep').read_text() == 'fixture'
        until(orphan_exit)
        if sys.platform == 'linux':
            until(watch)
        assert session.poll() is None and jobs[1].poll() is None and jobs[2].poll() is None
        session.terminate(); session.wait(timeout=2)
        assert jobs[1].wait(timeout=5) == 143  # same live CLI, second Run closed only now
        assert os.read(jobs[1].stderr.fileno(), 4096) == b'cardigan: agent session exited; private participants released\n'
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
            job.stderr.close()


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
        child = subprocess.Popen([*entry, "import os,pathlib,time;pathlib.Path(os.environ['TMPDIR'],'foreground').write_text(str(os.getpid()));" + WAIT])
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


def registered_service(base, detached=False):
    # Real listener with an in-flight external consumer. Even --private does
    # not entitle Cardigan to interrupt this connection or force-kill the job.
    key = 'A-5.R-1.R-3' if detached else 'A-5.R-1.R-2'
    ready = pathlib.Path(base)/'listener'
    service = """import os,sys,socket,pathlib
s=socket.socket(socket.AF_UNIX);s.bind(sys.argv[2]);s.listen(1);s.settimeout(12)
pathlib.Path(sys.argv[1]).write_text(str(os.getpid()))
c,_=s.accept();c.settimeout(12)
with c:
 while (b:=c.recv(1)): c.sendall(b)
"""
    if detached:
        # The direct child cooperates immediately; a cross-group holder still
        # has a live client. Its retained channel must not be counted as closed.
        service = f"""import os,sys,subprocess
subprocess.Popen([sys.executable,'-I','-c',{service!r},*sys.argv[1:]],
                 pass_fds=(int(os.environ['CARDIGAN_PRIVATE_LIFETIME_FD']),),start_new_session=True)
{WAIT}"""
    path = str(pathlib.Path(base)/'socket')
    with subprocess.Popen([sys.executable,'-I','-c','import time;time.sleep(20)']) as session:
        try:
            with subprocess.Popen([sys.executable,'-IB','-c',stub,str(source),TAG,key,str(session.pid),base,
                                   sys.executable,'-I','-c',service,str(ready),path], stderr=subprocess.PIPE) as job:
                until(lambda: ready.exists() and ready.read_text())
                exited = m['session_watch'](int(ready.read_text()))
                with socket.socket(socket.AF_UNIX) as client:
                    client.settimeout(4); client.connect(path)
                    client.sendall(b'a'); assert client.recv(1) == b'a'
                    states[key] = 'ended'
                    assert job.wait(timeout=6) == 125 and not exited()
                    # The declared bound (the Run) was reached: say so.
                    assert os.read(job.stderr.fileno(), 4096) == b'cardigan: run ended; release unconfirmed, private task retained\n'
                    client.sendall(b'b'); assert client.recv(1) == b'b'
                until(exited)
        finally:
            session.terminate(); session.wait(timeout=3)


def session_bypass(base):
    # Keep a consumer alive across CLI exit. The service exits by itself when
    # its private peer closes; no numeric PID is signalled by this fixture.
    ready = pathlib.Path(base)/'bypass'
    service = "import socket,sys;s=socket.socket(fileno=int(sys.argv[1]));exec('while (v:=s.recv(1)): s.sendall(v)')"
    client, server = socket.socketpair()
    with client, server, subprocess.Popen([sys.executable, '-IB', '-c', """import os,pathlib,subprocess,sys,time
subprocess.run([sys.executable,'-IB',sys.argv[1],'observe-session',str(os.getpid()),'A-7.R-9'],check=True,stdout=subprocess.DEVNULL)
fd=int(sys.argv[3]);p=subprocess.Popen([sys.executable,'-I','-c',sys.argv[4],str(fd)],pass_fds=(fd,), start_new_session=True)
pathlib.Path(sys.argv[2]).write_text(str(p.pid));time.sleep(20)""", str(source), str(ready), str(server.fileno()), service], pass_fds=(server.fileno(),)) as session:
        client.settimeout(4)
        try:
            until(lambda: ready.exists() and ready.read_text())
            server.close()
            client.sendall(b'a'); assert client.recv(1) == b'a'
        finally:
            session.terminate(); session.wait(timeout=3)
        client.sendall(b'b'); assert client.recv(1) == b'b'


# Only the fixture owns stdin. Closing it cleans up the Vite child it created,
# even if an assertion fails after the real supervisor correctly retains it.
VITE_FIXTURE_PARENT = """import os,sys,subprocess,pathlib,select
assert 'CARDIGAN_PRIVATE_LIFETIME_FD' not in os.environ
pathlib.Path('wrapper.started').touch()
fds=tuple(map(int,sys.argv[6:]))
child=subprocess.Popen(sys.argv[1:],stdin=subprocess.DEVNULL,pass_fds=fds)
for fd in fds: os.close(fd)
try:
 while child.poll() is None and not select.select([0],[],[],0.05)[0]: pass
finally:
 if child.poll() is None: child.terminate()
 pathlib.Path('vite.exit').write_text(str(child.wait(timeout=4)))
"""


def vite_owner(base, mode, key):
    # Same signed lifecycle query, guardian, audit and locked Vite as the entry;
    # stdout readiness does not consume a connection on the never-used case.
    work = pathlib.Path(base)
    on_demand = mode.startswith('demand-')
    (work/'node_modules').mkdir()
    (work/'node_modules'/'vite').symlink_to(source.parents[1]/'apps/web/node_modules/vite', target_is_directory=True)
    (work/'public').mkdir()
    (work/'public'/'manifest.json').write_text('{"next":"/asset.txt"}')
    (work/'public'/'asset.txt').write_text('fixture asset')
    if mode == 'unverified-unused':
        # An ordinary inherited setting is not proof of a controlled launch.
        # It must not opt a never-visited instance into reclamation.
        (work/'startup.cjs').write_text("process.env.APP_STARTED = '1';")
    if mode in ('custom','demand-config'):
        # A plugin can expose a completely separate endpoint. Its client never
        # touches Vite's main listener; the adapter cannot prove exclusivity.
        (work/'vite.config.mjs').write_text("""import {createServer} from 'node:http';
export default {plugins:[{name:'fixture',configureServer(){
 const s=createServer((_,res)=>res.end('plugin asset'));
 s.listen(0,'127.0.0.1',()=>console.log('plugin-port='+s.address().port));
}}]};""")
    env = {'PATH':os.environ['PATH'],'HOME':base,'TMPDIR':base,
           'NO_COLOR':'1','CI':'true','MCP_TOKEN':'synthetic'}
    if mode == 'unverified-unused':
        env['NODE_OPTIONS'] = '--require=./startup.cjs'
    if mode == 'auxiliary':
        # A normal startup health check. Its only client never visits Vite.
        (work/'health.cjs').write_text("""const http=require('node:http');
const health=http.createServer((_,res)=>res.end('healthy'));
health.listen(0,'127.0.0.1',()=>console.log('health-port='+health.address().port)).unref();""")
        env['NODE_OPTIONS'] = '--require=./health.cjs'
    if on_demand:
        preload = "require('node:fs').appendFileSync('project.starts','1');"
        if mode == 'demand-starting':
            preload += """const until=Date.now()+10000;
while(!require('node:fs').existsSync('finish-startup') && Date.now()<until)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,40);"""
        (work/'startup.cjs').write_text(preload)
        env['NODE_OPTIONS'] = '--require=./startup.cjs'
    owner = source.with_name('run-vite-owner.mjs').read_text()
    with socket.socket() as reserve:
        reserve.bind(('127.0.0.1',0))
        assigned = reserve.getsockname()[1]
    args = [sys.executable, '-IB', '-c', entry(cached_audit, vite_entry=True), str(source), TAG,
            key, str(os.getpid()), base, VITE_FIXTURE_PARENT, owner,
            '--private-vite-on-demand' if on_demand else '--private-vite', str(assigned)]
    with subprocess.Popen(args,cwd=base, env=env, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,stderr=subprocess.STDOUT) as job:
        client = None
        try:
            output = b''
            deadline = time.monotonic()+10
            aux_port = {'custom': rb'plugin-port=(\d+)\n', 'auxiliary': rb'health-port=(\d+)\n'}.get(mode)
            ready = rb'waiting for first connection on 127[.]0[.]0[.]1:(\d+)\n' if on_demand else rb'127[.]0[.]0[.]1:(\d+)/'
            while not (match:=re.search(ready,output)) or (aux_port and not re.search(aux_port, output)):
                assert time.monotonic()<deadline and job.poll() is None, output[-600:]
                if select.select([job.stdout],[],[],0.2)[0]: output+=os.read(job.stdout.fileno(),4096)
            port = int(match[1])
            assert port == assigned
            endpoint = int(re.search(aux_port,output)[1]) if aux_port else port
            client = http_client.HTTPConnection('127.0.0.1', endpoint, timeout=4)
            def get(path, close=True):
                client.request('GET', path, headers={'Connection':'close' if close else 'keep-alive'})
                response = client.getresponse()
                assert response.status == 200
                return response.read()
            if on_demand:
                assert not (work/'wrapper.started').exists() and not (work/'project.starts').exists()
                with socket.socket() as check:  # verify ownership without a client probe
                    try: check.bind(('127.0.0.1',port))
                    except OSError as exc: assert exc.errno == errno.EADDRINUSE
                    else: raise AssertionError('announced listener not bound')
            if mode in ('between', 'inflight', 'demand-between', 'demand-config'):
                resource = json.loads(get('/manifest.json', close=mode!='inflight'))['next']
                if mode != 'inflight': assert client.sock is None  # same caller, no TCP connection
                else: client.sock.sendall(b'GET /asset.txt HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n')
            if mode == 'custom': assert get('/') == b'plugin asset'
            if mode == 'auxiliary': assert get('/health') == b'healthy'
            if mode == 'demand-starting':
                # The client disconnects before Node finishes starting. A
                # trusted terminal notification must not undo that admission.
                with socket.create_connection(('127.0.0.1',port),timeout=3): pass
                until(lambda: (work/'project.starts').exists())
            states[key] = 'bad-signature'
            until(lambda: served[key, 'bad-signature'] >= 2)
            assert job.poll() is None
            if mode == 'demand-unused':
                assert not (work/'wrapper.started').exists() and not (work/'project.starts').exists()
            if mode == 'demand-race':
                arrived, release = held_terminal[key] = threading.Event(), threading.Event()
            states[key] = 'ended'
            if mode == 'demand-race':
                # The first request arrives during a signed terminal read.
                # A stale empty-queue observation must not discard it.
                try:
                    assert arrived.wait(timeout=3)
                    client.request('GET','/manifest.json',headers={'Connection':'close'})
                finally: release.set()
            expected = 'unused_vite_listener_released' if mode == 'demand-unused' else 'vite_ingress_unproven_retained'
            observed = job.wait(timeout=6)
            assert observed == (0 if mode == 'demand-unused' else 125), (mode, observed, expected)
            assert f'cardigan run_resource {key} {expected}' in (pathlib.Path(keydir.name)/'audit').read_text().splitlines()
            if mode == 'demand-unused':
                assert not (work/'wrapper.started').exists() and not (work/'project.starts').exists()
                with socket.socket() as check: check.bind(('127.0.0.1',port))
            elif mode in ('between','demand-between','demand-config'):
                assert get(resource) == b'fixture asset'
                if on_demand: assert (work/'project.starts').read_text() == '1'
                if mode == 'demand-config':
                    while not (aux:=re.search(rb'plugin-port=(\d+)\n',output)):
                        assert select.select([job.stdout],[],[],3)[0], output[-500:]
                        block=os.read(job.stdout.fileno(),4096); assert block
                        output+=block
                    plugin=http_client.HTTPConnection('127.0.0.1',int(aux[1]),timeout=4)
                    try:
                        plugin.request('GET','/'); response=plugin.getresponse()
                        assert response.status == 200 and response.read() == b'plugin asset'
                    finally: plugin.close()
            elif mode == 'demand-starting':
                (work/'finish-startup').touch()
                assert get('/asset.txt') == b'fixture asset'
            elif mode == 'demand-race':
                response=client.getresponse()
                assert response.status == 200 and json.loads(response.read())['next'] == '/asset.txt'
                assert get('/asset.txt') == b'fixture asset'
            elif mode == 'custom': assert get('/') == b'plugin asset'
            elif mode == 'auxiliary': assert get('/health') == b'healthy'
            elif mode == 'unverified-unused': assert get('/asset.txt') == b'fixture asset'
            else:
                client.sock.sendall(b'\r\n')
                response = http_client.HTTPResponse(client.sock); response.begin()
                assert response.status == 200 and response.read() == b'fixture asset'
        finally:
            if client: client.close()
            states[key] = 'ended'
            job.stdin.close()
            if job.poll() is None: job.wait(timeout=6)
            # Wait for the fixture parent to reap its own child before tmp cleanup.
            if (work/'wrapper.started').exists(): until(lambda: (work/'vite.exit').exists())


def occupied_vite_port(base):
    # A competing listener belongs to the fixture, not to the registration.
    with socket.socket() as existing:
        existing.bind(('127.0.0.1',0)); existing.listen()
        port = existing.getsockname()[1]
        key = 'A-8.R-1.R-11'
        owner = source.with_name('run-vite-owner.mjs').read_text()
        run = subprocess.run([sys.executable,'-IB','-c',entry(cached_audit,vite_entry=True),
            str(source),TAG,key,str(os.getpid()),base,VITE_FIXTURE_PARENT,owner,
            '--private-vite-on-demand',str(port)], cwd=base, capture_output=True,timeout=4,
            env={'PATH':os.environ['PATH'],'HOME':base,'MCP_TOKEN':'synthetic'})
        assert run.returncode == 125 and not (pathlib.Path(base)/'wrapper.started').exists()
        assert f'cardigan run_resource {key} vite_listener_unavailable' in (pathlib.Path(keydir.name)/'audit').read_text().splitlines()
        with socket.create_connection(existing.getsockname(), timeout=2) as caller:
            peer, _ = existing.accept()
            with peer: peer.sendall(b'original')
            assert caller.recv(8) == b'original'


def observer_enrollment():
    # Synthetic parent identity and fake handles; never look up a recycled PID.
    ns = m['install_observer'].__globals__
    for parent, already_dead, accepted in [(73, False, True), (1, False, False), (73, True, False)]:
        system = mock.Mock()
        system.getppid.side_effect = [73, parent]
        system.pidfd_open.return_value = 42
        system.fork.return_value = 11
        with mock.patch.dict(ns, os=system, sys=SimpleNamespace(platform='linux'),
                             dead=lambda fd: already_dead, birth=lambda pid: 'same-stamp', audit=mock.Mock()):
            try:
                assert m['install_observer'](73, 'A-1.R-1') == 'same-stamp' and accepted
            except ValueError:
                assert not accepted
        system.fork.assert_not_called()
        system.close.assert_called_once_with(42)


def linux_watch_errors():
    ns = m['session_watch'].__globals__
    for invalid in (select.POLLNVAL, select.POLLERR):
        poller = mock.Mock()
        poller.poll.side_effect = [[(42, invalid)], [(42, select.POLLIN)]]
        native = SimpleNamespace(poll=lambda:poller, POLLIN=select.POLLIN,
                                 POLLNVAL=select.POLLNVAL, POLLERR=select.POLLERR)
        with mock.patch.dict(ns, sys=SimpleNamespace(platform='linux'), select=native,
                             os=SimpleNamespace(pidfd_open=lambda _:42)):
            watch = m['session_watch'](123)
            assert not watch() and not watch()  # lost pin never becomes exit proof


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


def long_foreground(base):
    # C-605: a command outliving many lifecycle re-reads keeps its supervisor
    # and its own exit status. Darwin failed at the first re-read (15 s).
    key = 'A-9.R-1.R-1'
    with subprocess.Popen([sys.executable, '-I', '-c', 'import time;time.sleep(20)']) as session:
        try:
            before = served[key, 'active']
            run = subprocess.run([sys.executable, '-IB', '-c', entry(cached_audit), str(source), TAG, key, str(session.pid), base,
                                  sys.executable, '-I', '-c', 'import time;time.sleep(1.5);raise SystemExit(9)'],
                                 capture_output=True, timeout=8)
            assert run.returncode == 9 and run.stderr == b'', run.stderr
            assert served[key, 'active'] - before >= 10  # re-read by the supervisor throughout
            assert session.poll() is None
        finally:
            session.terminate(); session.wait(timeout=3)


def lost_supervisor(base):
    # The supervisor dies uncatchably (as on Darwin). The entry must not
    # return a bare 125: it names the loss, and the participant sees EOF
    # without a settlement record. Nothing is signalled except the fixture's
    # own supervisor process, found as the task's parent.
    key = 'A-9.R-1.R-2'
    task = """import os,pathlib,socket
p=pathlib.Path(os.environ['TMPDIR'])
s=socket.socket(fileno=int(os.environ['CARDIGAN_PRIVATE_LIFETIME_FD']));s.settimeout(10)
(p/'supervisor').write_text(str(os.getppid()))
data=s.recv(128)
(p/'lifetime').write_text('eof' if data==b'' else repr(data))"""
    with subprocess.Popen([sys.executable, '-I', '-c', 'import time;time.sleep(20)']) as session:
        try:
            with subprocess.Popen([sys.executable, '-IB', '-c', entry(cached_audit), str(source), TAG, key, str(session.pid), base,
                                   sys.executable, '-I', '-c', task], stderr=subprocess.PIPE) as job:
                until(lambda: os.path.isdir(base) and os.listdir(base))
                _, parent = m['namespace'](TAG, False, base)
                scratch = pathlib.Path(parent)/m['scope_name'](key)/'tmp'
                os.close(_)
                until(lambda: (scratch/'supervisor').exists() and (scratch/'supervisor').read_text())
                supervisor = int((scratch/'supervisor').read_text())
                assert supervisor != job.pid
                os.kill(supervisor, 9)
                assert job.wait(timeout=5) == 125
                assert os.read(job.stderr.fileno(), 4096) == (b'cardigan: supervisor lost (SIGKILL); lifetime connection closed '
                                             b'without settlement, private task retained\n')
                until(lambda: (scratch/'lifetime').exists())
                assert (scratch/'lifetime').read_text() == 'eof'
                audit = (pathlib.Path(keydir.name)/'audit').read_text().splitlines()
                assert f'cardigan run_resource {key} supervisor_lost SIGKILL' in audit
        finally:
            session.terminate(); session.wait(timeout=3)


def slow_start(base):
    # C-605: startup on a busy link. A failed first read is retried; a slow
    # (3 s) answer is accepted; the command then runs normally.
    with subprocess.Popen([sys.executable, '-I', '-c', 'import time;time.sleep(30)']) as session:
        try:
            key = 'A-9.R-1.R-4'
            states[key] = 'unanswered'
            job = subprocess.Popen([sys.executable, '-IB', '-c', stub, str(source), TAG, key, str(session.pid), base,
                                    sys.executable, '-I', '-c', 'raise SystemExit(4)'], stderr=subprocess.PIPE)
            until(lambda: served[key, 'unanswered'] >= 2)
            assert job.poll() is None
            states[key] = 'active'
            assert job.wait(timeout=6) == 4 and os.read(job.stderr.fileno(), 4096) == b''
            job.stderr.close()
            key = 'A-9.R-1.R-5'
            states[key] = 'slow'
            run = subprocess.run([sys.executable, '-IB', '-c', stub, str(source), TAG, key, str(session.pid), base,
                                  sys.executable, '-I', '-c', 'raise SystemExit(5)'], capture_output=True, timeout=10)
            assert run.returncode == 5 and run.stderr == b'', run.stderr
        finally:
            session.terminate(); session.wait(timeout=3)


def inactive_run(base):
    # A Run that already ended starts nothing and says why.
    key = 'A-9.R-1.R-3'
    states[key] = 'ended'
    marker = pathlib.Path(base)/'started'
    with subprocess.Popen([sys.executable, '-I', '-c', 'import time;time.sleep(20)']) as session:
        try:
            run = subprocess.run([sys.executable, '-IB', '-c', stub, str(source), TAG, key, str(session.pid), base,
                                  sys.executable, '-I', '-c', f'open({str(marker)!r},"w")'], capture_output=True, timeout=4)
            assert run.returncode == 125 and run.stderr == b'cardigan: run not active (ended)\n', run.stderr
            assert not marker.exists()
        finally:
            session.terminate(); session.wait(timeout=3)


def fork_first():
    # C-605 regression guard (Darwin cannot run in CI): the entry forks before
    # any lifecycle read, scratch creation or system-log write. Those all run
    # in the supervisor, the first process to use name lookup, TLS or logging.
    ns = m['command'].__globals__
    events = []
    class Forked(Exception): pass
    class Probe:
        def state(self, fresh=False): events.append('state'); return 'active'
    class System:
        def __getattr__(self, name): return getattr(os, name)
        def fork(self): events.append('fork'); raise Forked
    with mock.patch.dict(ns, os=System(), birth=lambda _: 'same',
                         audit=lambda *a: events.append('audit'),
                         namespace=lambda *a: events.append('namespace')):
        try:
            m['command'](TAG, 'A-1.R-1.R-1', 123, ['true'], confirmation=Probe())
            raise AssertionError('did not fork')
        except Forked:
            pass
    assert events == ['fork'], events
    # Without an injected confirmation only the token digest is taken first.
    events.clear()
    with mock.patch.dict(ns, os=System(), birth=lambda _: 'same', audit=lambda *a: events.append('audit'),
                         Confirmation=lambda *a: events.append('confirmation')):
        try:
            m['command'](TAG, 'A-1.R-1.R-1', 123, ['true'])
        except Forked:
            pass
    assert events == ['fork'], events


if sys.argv[1:] == ['on-demand-vite']:
    try:
        with tempfile.TemporaryDirectory() as base: occupied_vite_port(base)
        for i, mode in enumerate(('demand-unused','demand-between','demand-config','demand-starting','demand-race'), 6):
            with tempfile.TemporaryDirectory() as base:
                vite_owner(base, mode, f'A-8.R-1.R-{i}')
    finally:
        http.shutdown(); http.server_close(); keydir.cleanup()
    print('on-demand listener lifecycle passed')
    sys.exit(0)

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
# Unexpected read errors are unknown too, never a supervisor crash.
check = m['Confirmation']('A-1.R-1.R-1', 'synthetic', read=mock.Mock(side_effect=[RuntimeError(), 'active']), interval=0)
assert [check.state() for _ in range(2)] == ['unknown', 'active']
fork_first()
darwin_watch()
linux_watch_errors()
observer_enrollment()
with tempfile.TemporaryDirectory(dir='/tmp', prefix='cr') as base:
    foreground_contracts(base)
with tempfile.TemporaryDirectory() as base:
    test_runs(base)
with tempfile.TemporaryDirectory() as base:
    session_bypass(base)
with tempfile.TemporaryDirectory() as base:
    long_foreground(base)
with tempfile.TemporaryDirectory() as base:
    lost_supervisor(base)
with tempfile.TemporaryDirectory() as base:
    inactive_run(base)
with tempfile.TemporaryDirectory() as base:
    slow_start(base)
for detached in (False, True):
    with tempfile.TemporaryDirectory(dir="/tmp", prefix="custody-") as base:
        registered_service(base, detached)
for i, mode in enumerate(('auxiliary', 'between', 'inflight', 'custom', 'unverified-unused'), 1):
    with tempfile.TemporaryDirectory() as base:
        vite_owner(base, mode, f'A-8.R-1.R-{i}')
http.shutdown(); http.server_close(); keydir.cleanup()
print('isolated run resources passed', sys.platform)
