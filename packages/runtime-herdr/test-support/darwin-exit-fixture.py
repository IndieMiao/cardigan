"""Isolated terminal manager for the signal-free exit fallback.

`core ROOT SESSION AGENT RUN GENERATION PROJECT ASSIGNMENT TARGET`: a synthetic core
socket that owns one real harness child; hc's send writes its text to the child's
stdin. `worker ROOT SCRIPT INSPECTOR OWNER CONFIG`: the shipped worker script with
only the account and platform substituted. Workspace checks, native birth, the
single core connection and the child's own exit are real.
"""
import json
import os
import pwd
import socketserver
import subprocess
import sys
import threading
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

uid = os.getuid() or 1234  # Unprivileged synthetic account even under a root CI runner.
native = Path(__file__).resolve().parents[3] / 'deploy' / 'worker-primitives.py'


def core(root, session, agent, run, generation, project, assignment, target):
    root = Path(root)
    (root / 'native.py').write_text(
        f"import os,runpy\nbirth=runpy.run_path({str(native)!r})['darwin_identity' if os.uname().sysname=='Darwin' else 'linux_identity']\n"
        f"def darwin_identity(pid):\n b,_,s,g=birth(pid);return b,{uid},s,g")
    script = ("import os,sys,runpy,json; from pathlib import Path\n"
              "p=runpy.run_path(sys.argv[1])['identity'](sys.argv[2],os.getpid(),sys.argv[3],os.getpgrp()); p['uid']=int(sys.argv[5])\n"
              "Path(sys.argv[4]).write_text(json.dumps(p))\n"
              "for line in sys.stdin:\n"
              " open(sys.argv[6],'a').write(line)\n"
              " if line.strip() in ('/exit','/quit'): sys.exit(0)\n")
    child = subprocess.Popen([sys.executable, '-IB', '-c', script, str(native), target, generation,
                              str(root / 'child'), str(uid), str(root / 'typed')],
                             stdin=subprocess.PIPE, text=True, start_new_session=True)
    lock = threading.Lock()

    def terminal():
        mode = (root / 'state').read_text()
        live = child.poll() is None
        reused = mode == 'reused'  # a new manager handed this address to another terminal
        return dict(address='t1', created_ms=2 if reused else 1, pid=child.pid if live else None,
                    name=agent, cwd=str(root), foreground=dict(pid=child.pid) if live else None,
                    rm=False, keep=mode == 'keep', state='live' if live else 'finished',
                    status={'state': 'working' if mode == 'working' else 'idle'} if live else None,
                    labels=dict(cardigan='1', project=project, assignment=assignment, run=run,
                                generation='next' if reused else generation))

    class Handler(socketserver.StreamRequestHandler):
        def handle(self):
            for line in self.rfile:
                req = json.loads(line)
                method, params = req['method'], req['params']
                reply = dict(jsonrpc='2.0', id=req['id'])
                with lock:
                    mode = (root / 'state').read_text()
                    if method == 'hello':
                        reply['result'] = dict(generation=1, framed=False, version='fixture',
                                               core=dict(id='fixture', name='fixture'), methods=[], features=[])
                    elif method == 'terminal.get':
                        reply['result'] = terminal()
                    elif method == 'terminal.send':
                        assert params['terminal'] == 't1' and params['if'] == 'idle', params
                        if mode == 'drop':
                            return  # receipt lost after the request: delivery unknown
                        if child.poll() is not None:
                            reply['error'] = dict(code=-32000, message='finished', data=dict(kind='finished'))
                        elif mode in ('working', 'flip'):  # flip: turned busy just before typing
                            reply['error'] = dict(code=-32000, message='status_mismatch',
                                                  data=dict(kind='status_mismatch'))
                        else:
                            with open(root / 'sends', 'a') as f:
                                f.write(params['text'] + '\n')
                            child.stdin.write(params['text'] + '\n')
                            child.stdin.flush()
                            reply['result'] = dict(turn=1, status='idle', started=None)
                    else:
                        raise ValueError(method)
                self.wfile.write((json.dumps(reply) + '\n').encode())

    directory = root / '.local/state/herdr-core' / session
    directory.mkdir(parents=True, mode=0o700)
    path = directory / (session + '.sock')
    with socketserver.ThreadingUnixStreamServer(str(path), Handler) as server:
        if os.getuid() == 0:
            os.chown(path, uid, -1)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        child.wait()
        (root / 'exited').write_text(str(child.returncode))
        sys.stdin.read()  # keep the finished terminal readable until the test ends


def worker(root, script, inspector, owner, config):
    root = Path(root)
    c = json.loads(config)
    c.update(user='fixture', gid=1234, primitive=str(root / 'native.py'))
    sys.argv = ['darwin-harness-exit', inspector, owner, json.dumps(c)]
    with patch('platform.system', return_value='Darwin'), \
            patch.object(os, 'getuid', return_value=uid), patch.object(os, 'geteuid', return_value=uid), \
            patch.object(os, 'getegid', return_value=1234), \
            patch.object(pwd, 'getpwuid', return_value=SimpleNamespace(pw_name='fixture', pw_gid=1234, pw_dir=str(root))):
        exec(compile(script, '<darwin-harness-exit>', 'exec'), {'__name__': '__main__'})


if __name__ == '__main__':
    {'core': core, 'worker': worker}[sys.argv[1]](*sys.argv[2:])
