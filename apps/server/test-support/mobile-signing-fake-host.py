"""Stand-in for host.py's request and check protocol in server job tests; never signs."""
from pathlib import Path
import signal
import sys
import time

ctl = Path(sys.argv[1])
rid = '1' * 32
if not sys.argv[2].endswith('mobile-signing'):
    sys.exit(1)
command = sys.argv[3:]
kind = (ctl / 'kind').read_text() if command == ['request'] else 'check' if command == ['check', rid] else 'invalid'
with (ctl / 'spawns').open('a') as f:
    f.write(kind + '\n')


def term(*_):
    (ctl / 'terminated').write_text('1')
    sys.exit(3)


signal.signal(signal.SIGTERM, term)


def wait(name):
    while not (ctl / name).exists():
        time.sleep(0.02)


if kind == 'invalid' or not sys.stdin.readline().endswith('}\n'):
    sys.exit(1)
if kind == 'check':
    # The ledger no longer releases a revoked or expired grant.
    if (ctl / 'revoked').exists():
        sys.exit(1)
    print(rid, 'a' * 64, flush=True)
    sys.exit(0)
if kind == 'refused':
    sys.exit(1)
if kind == 'unclaimed':
    wait('claim')
if kind in ('hang', 'transfer'):
    # transfer: a long deadline, still sending the input when the server stops.
    print(f'accepted {rid} {1 if kind == "hang" else 900} sign', flush=True)
    time.sleep(60)
    sys.exit(1)
mode = kind if kind in ('stored', 'lookup', 'resume') else 'sign'
print(f'accepted {rid} {600 if kind == "stored" else 900} {mode}', flush=True)
if kind == 'slow':
    wait('ready')
print('ready', flush=True)
if sys.stdin.readline() != 'commit\n':
    sys.exit(1)
(ctl / 'committed').write_text('1')
if kind == 'slow':
    wait('signed')
if kind == 'lost':
    # Interrupted after the signer finished: no result reaches the server.
    sys.exit(3)
print(rid, 'a' * 64, flush=True)
