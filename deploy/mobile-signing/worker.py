"""SSH forced command for the dedicated signing UID. No shell command protocol."""
from contextlib import closing, contextmanager, nullcontext
import fcntl
import os
from pathlib import Path
import sqlite3
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (canonical, config, database, digest, directory, json, line, manifest,
                    persist, private_dir, require, send, transfer)
from platforms import android, ios, lock_keychain


@contextmanager
def signing_session(c, root):
    try:
        yield
    finally:
        if c['platform'] == 'ios':
            lock_keychain(c, root)


def receipt(root, spec):
    # Metadata only: no signing policy/key access, no output bytes, no journal mutation.
    with closing(sqlite3.connect((root/'audit.sqlite').as_uri()+'?mode=ro', uri=True)) as db:
        row = db.execute('SELECT state,sha FROM receipts WHERE id=? AND spec=?',
                         (spec['id'], canonical(spec))).fetchone()
        require(row)
        return {'state': row[0], 'sha256': row[1]}


def serve(root, src, dst, adapters=None):
    req = json.loads(line(src))
    s, mode = req['grant'], req['mode']
    manifest(s, live=False)
    require(s['worker_uid'] != os.getuid() and os.getuid() != 0)
    if mode == 'receipt':
        require(req['size'] == 0)
        send(dst, canonical(receipt(root, s)).encode())
        return
    require(mode in ('sign', 'lookup'))
    with (root/'serial.lock').open('ab') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        c = config(root/'identity.json')
        # Hold the serial lock through cleanup; do not publish a receipt or bytes
        # unless the lock-back succeeded. Read-only lookups never use an identity.
        with signing_session(c, root) if mode == 'sign' else nullcontext():
            require(all(c[k] == s[k] for k in ('project','machine','platform','app','version')))
            manifest(s)
            db = database(root, 'CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY,spec TEXT,state TEXT,sha TEXT)')
            rid, spec = s['id'], canonical(s)
            output = directory(root,'outputs')/rid
            with tempfile.TemporaryDirectory(dir=root) as d:
                tmp = Path(d)
                if mode == 'sign':
                    candidate = tmp/('input.apk' if s['platform']=='android' else 'input.zip')
                    db.execute("INSERT INTO receipts VALUES(?,?,'pending',NULL)", (rid,spec))
                    with candidate.open('xb') as f:
                        require(transfer(src, f, req['size']) == s['sha256'])
                else:
                    require(req['size'] == 0)
                send(dst,b'ready')
                require(line(src)==b'commit')
                manifest(s)
                require(config(root/'identity.json') == c)
                if mode == 'sign':
                    try:
                        signed = tmp/('signed.apk' if s['platform']=='android' else 'signed.zip')
                        (adapters or {'android':android,'ios':ios})[s['platform']](c,candidate,signed,tmp)
                        sha = digest(signed)
                        persist(signed, output)
                    except Exception:
                        db.execute("UPDATE receipts SET state='failed' WHERE id=?", (rid,))
                        sha = None
        if mode == 'sign' and sha is not None:
            db.execute("UPDATE receipts SET state='signed',sha=? WHERE id=?", (sha,rid))
        row = db.execute('SELECT state,sha FROM receipts WHERE id=? AND spec=?',(rid,spec)).fetchone()
        require(row)
        if row[0]=='failed':
            send(dst,b'{"status":"failed"}')
            return
        require(row[0]=='signed' and digest(output)==row[1])
        size=output.stat().st_size
        send(dst,canonical({'size':size,'sha256':row[1]}).encode())
        with output.open('rb') as f:
            transfer(f,dst,size)
        dst.flush()


if __name__=='__main__':
    try:
        os.umask(0o077)
        require(not os.environ.get('SSH_ORIGINAL_COMMAND'))
        serve(private_dir(Path(sys.argv[1])),sys.stdin.buffer,sys.stdout.buffer)
    except Exception:
        sys.exit(1)
