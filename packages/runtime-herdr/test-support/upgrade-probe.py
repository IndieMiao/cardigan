#!/usr/bin/env python3
"""C-313: probe verified Linux binaries in a disposable core, never an installed hc."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import pty
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--old', type=Path, required=True)
    parser.add_argument('--new', type=Path, required=True)
    args = parser.parse_args()
    for binary, version in [(args.old, '0.1.18'), (args.new, '0.1.21')]:
        assert subprocess.check_output([binary, '--version'], text=True, timeout=5).strip() == f'hc {version}'
    root = Path(tempfile.mkdtemp(prefix='cg-upgrade-'))
    # Retain evidence and sockets on failure; never delete an uncertain live core.
    run_probe(args, root)
    shutil.rmtree(root)


def run_probe(args, root):
    for name in ['bin', 'runtime', 'config', 'state', 'data']:
        (root / name).mkdir(mode=0o700)
    binary = root / 'bin' / 'herdr-core'
    shutil.copyfile(args.old, binary)
    binary.chmod(0o700)
    env = {'PATH': os.defpath, 'HOME': str(root), 'TERM': 'dumb',
           'HC_SESSION': 'c313-probe', 'HC_SOCKET': str(root / 'runtime' / 'core.sock'),
           'C313_MARK': 'original'}
    for key, name in [('XDG_RUNTIME_DIR', 'runtime'), ('XDG_CONFIG_HOME', 'config'),
                      ('XDG_STATE_HOME', 'state'), ('XDG_DATA_HOME', 'data')]:
        env[key] = str(root / name)

    def hc(*argv, override=None):
        return json.loads(subprocess.check_output(
            [binary, *([argv[0], '--json', *argv[1:]] if argv[0] == 'run' else [*argv, '--json'])],
            env=override or env, cwd=root, text=True, timeout=20))

    def emit(name, **facts):
        print(json.dumps({'check': name, **facts}), flush=True)

    def until(read):
        end = time.monotonic() + 5
        while time.monotonic() < end:
            if read():
                return
            time.sleep(.02)
        raise AssertionError('probe readiness timeout')

    def marker(name, expected):
        path = root / name
        hc('run', '--bg', '--name', name, '--', '/bin/sh', '-c',
           f'printf "%s %s" "$C313_MARK" "$TERM" > {path}; exec /bin/cat',
           override={**env, 'C313_MARK': 'changed'})
        until(lambda: path.exists() and bool(path.read_text()))
        assert path.read_text() == expected
        emit(name, environment=expected)

    attached = []
    detached = None
    started = False
    try:
        hc('server', 'start')
        started = True
        hc('run', '--bg', '--name', 'kept', '--', '/bin/cat')
        original = hc('get', 'kept')['pid']
        hc('update', '--from', str(args.new.resolve()))
        assert hc('server', 'status')['version'] == '0.1.21'
        assert hc('get', 'kept')['pid'] == original
        emit('upgrade', version='0.1.21', original_program_preserved=True)
        marker('after-upgrade', 'original xterm-256color')
        changed = {**env, 'C313_MARK': 'changed'}
        hc('server', 'restart', override=changed)
        marker('after-restart', 'original xterm-256color')
        hc('server', 'restart', '--fresh', override=changed)
        marker('after-fresh', 'changed xterm-256color')

        pidfile = root / 'detached-pid'
        program = ('import subprocess,time,pathlib; '
                   'p=subprocess.Popen(["/bin/sleep","300"],start_new_session=True,'
                   'stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); '
                   f'pathlib.Path({str(pidfile)!r}).write_text(str(p.pid)); time.sleep(300)')
        hc('run', '--bg', '--name', 'detached', '--', '/usr/bin/python3', '-c', program)
        until(pidfile.exists)
        pid = int(pidfile.read_text())
        detached = (pid, Path(f'/proc/{pid}/stat').read_text().split()[21])
        hc('kill', 'detached')
        hc('rm', 'detached')
        assert Path(f'/proc/{pid}/stat').read_text().split()[21] == detached[1]
        emit('terminal-removal', detached_process_survived=True)

        hc('run', '--bg', '--name', 'draft', '--', '/bin/cat')
        before = hc('get', 'draft')
        for observe in [True, False]:
            master, slave = pty.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
            proc = subprocess.Popen([binary, 'attach', *(['--observe'] if observe else []), 'draft'],
                                    env={**env, 'TERM': 'xterm-256color'}, cwd=root,
                                    stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
            os.close(slave)
            attached.append((proc, master))
            # The attach client queries terminal capabilities before accepting input.
            time.sleep(1)
            assert proc.poll() is None
            if observe:
                after = hc('get', 'draft')
                assert (before['rows'], before['cols']) == (after['rows'], after['cols'])
                emit('observe', dimensions_unchanged=True)
                os.write(master, b'\x1c')
                proc.wait(timeout=5)
                continue
            until(lambda: hc('get', 'draft')['cols'] == 80)
            os.write(master, b'unsent')
            time.sleep(.1)
            sending = subprocess.Popen([binary, 'send', 'draft', 'bell', '--json'], env=env,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                sending.communicate(timeout=10)
                raise AssertionError('unfinished draft did not hold send')
            except subprocess.TimeoutExpired:
                emit('default-draft', exceeded_call_timeout_seconds=10)
            finally:
                if sending.poll() is None:
                    sending.kill()
                sending.communicate(timeout=5)
            os.write(master, b'\x15')
            time.sleep(.5)
            os.write(master, b'second-draft')
            (root / 'config' / 'herdr-core').mkdir(exist_ok=True)
            (root / 'config' / 'herdr-core' / 'config.toml').write_text('draft_wait = 0\n')
            start = time.monotonic()
            hc('send', 'draft', 'bell-zero')
            elapsed = time.monotonic() - start
            assert elapsed < 10
            emit('isolated-draft-zero', seconds=round(elapsed, 2))
            os.write(master, b'\x1c')
            proc.wait(timeout=5)

        hc('update', '--from', str(args.old.resolve()), '--force')
        assert hc('server', 'status')['version'] == '0.1.18'
        assert hc('get', 'kept')['pid'] == original
        emit('rollback', version='0.1.18', original_program_preserved=True)
    finally:
        for proc, master in attached:
            if proc.poll() is None:
                proc.terminate()
                proc.wait(timeout=5)
            os.close(master)
        if detached:
            pid, identity = detached
            path = Path(f'/proc/{pid}/stat')
            if path.exists() and path.read_text().split()[21] == identity:
                os.kill(pid, signal.SIGTERM)
                until(lambda: not path.exists() or path.read_text().split()[2] == 'Z'
                      or path.read_text().split()[21] != identity)
        if started:
            for terminal in hc('ls', '--all')['terminals']:
                if terminal['state'] == 'live':
                    hc('kill', terminal['address'])
                hc('rm', terminal['address'])
            hc('server', 'stop')
            until(lambda: not (root / 'runtime' / 'core.sock').exists())
            emit('cleanup', core_stopped=True)

if __name__ == '__main__':
    main()
