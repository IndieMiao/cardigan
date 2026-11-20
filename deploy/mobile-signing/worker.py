"""SSH forced command for the dedicated signing UID. No shell command protocol."""
import fcntl
import os
from pathlib import Path
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (canonical, config, database, digest, directory, json, line, manifest,
                    persist, private_dir, require, send, transfer)
from platforms import android, ios


def serve(root, src, dst, adapters=None):
    req=json.loads(line(src)); s=req['grant']; manifest(s)
    require(req['mode'] in ('sign','lookup'))
    def policy():
        c=config(root/'identity.json')
        require(all(c[k]==s[k] for k in ('project','machine','platform','app','version')))
        require(s['worker_uid'] != os.getuid() and os.getuid() != 0)
        return c
    c=policy(); rid=s['id']; spec=canonical(s)
    # One account / policy / private keychain. Never race signing or keychain lock.
    with (root/'serial.lock').open('ab') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        db=database(root, 'CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY,spec TEXT,state TEXT,sha TEXT)')
        output=directory(root,'outputs')/rid
        with tempfile.TemporaryDirectory(dir=root) as d:
            tmp=Path(d); candidate=tmp/('input.apk' if s['platform']=='android' else 'input.zip')
            if req['mode']=='sign':
                db.execute("INSERT INTO receipts VALUES(?,?,'pending',NULL)",(rid,spec))
                with candidate.open('xb') as f:
                    require(transfer(src,f,req['size'])==s['sha256'])
            else:
                require(req['size']==0)
            send(dst,b'ready'); require(line(src)==b'commit'); manifest(s); require(policy()==c)
            if req['mode']=='sign':
                try:
                    signed=tmp/('signed.apk' if s['platform']=='android' else 'signed.zip')
                    (adapters or {'android':android,'ios':ios})[s['platform']](c,candidate,signed,tmp)
                    sha=digest(signed); persist(signed,output)
                except Exception:
                    db.execute("UPDATE receipts SET state='failed' WHERE id=?",(rid,)); send(dst,b'{"status":"failed"}'); return
                db.execute("UPDATE receipts SET state='signed',sha=? WHERE id=?", (sha,rid))
            row=db.execute('SELECT state,sha FROM receipts WHERE id=? AND spec=?',(rid,spec)).fetchone()
            require(row)
            if row[0]=='failed':
                send(dst,b'{"status":"failed"}'); return
            require(row[0]=='signed' and digest(output)==row[1]); size=output.stat().st_size
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
        sys.exit(1)  # never reflect paths, private labels or tool output to host
