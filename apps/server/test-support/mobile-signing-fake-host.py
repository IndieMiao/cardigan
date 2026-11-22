"""Stand-in for host.py's request protocol in server job tests; never signs."""
from pathlib import Path
import signal
import sys
import time

ctl = Path(sys.argv[1])
require_args = sys.argv[3:] == ['request'] and sys.argv[2].endswith('mobile-signing')
kind = (ctl / 'kind').read_text() if require_args else 'invalid'
with (ctl / 'spawns').open('a') as f:
    f.write(kind + '\n')
rid = '1' * 32


def term(*_):
    (ctl / 'terminated').write_text('1')
    sys.exit(3)


signal.signal(signal.SIGTERM, term)


def wait(name):
    while not (ctl / name).exists():
        time.sleep(0.02)


if kind == 'invalid' or not sys.stdin.readline().endswith('}\n'):
    sys.exit(1)
if kind == 'hang':
    print(f'accepted {rid} 1 sign', flush=True)
    time.sleep(60)
    sys.exit(1)
print(f'accepted {rid} {600 if kind == "stored" else 900} {"stored" if kind == "stored" else "sign"}', flush=True)
if kind == 'slow':
    wait('ready')
print('ready', flush=True)
if sys.stdin.readline() != 'commit\n':
    sys.exit(1)
(ctl / 'committed').write_text('1')
if kind == 'slow':
    wait('signed')
print(rid, 'a' * 64, flush=True)
