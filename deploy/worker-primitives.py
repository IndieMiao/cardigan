#!/usr/bin/env python3
"""Worker-only native identity and inherited-FD locking. No signals or cleanup."""
import ctypes
import fcntl
import json
import os
import platform
import stat
import sys
import time
from pathlib import Path


def lock_fd(fd, budget_ms=0):
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size != 0:
        raise ValueError('invalid_lock')
    deadline = time.monotonic() + budget_ms / 1000
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return
        except BlockingIOError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(min(0.01, max(0, deadline - time.monotonic())))


class ProcBSDInfo(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint32) for name in (
        'flags', 'status', 'xstatus', 'pid', 'ppid', 'uid', 'gid',
        'ruid', 'rgid', 'svuid', 'svgid', 'reserved')]
    _fields_ += [('comm', ctypes.c_char * 16), ('name', ctypes.c_char * 32)]
    _fields_ += [(name, ctypes.c_uint32) for name in (
        'nfiles', 'pgid', 'pjobc', 'tdev', 'tpgid')]
    _fields_ += [('nice', ctypes.c_int32), ('start_sec', ctypes.c_uint64),
                ('start_usec', ctypes.c_uint64)]


def darwin_identity(pid):
    libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
    boot = ctypes.create_string_buffer(128)
    size = ctypes.c_size_t(len(boot))
    if libc.sysctlbyname(b'kern.bootsessionuuid', boot, ctypes.byref(size), None, 0):
        raise OSError('boot_unknown')
    libproc = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
    info = ProcBSDInfo()
    libproc.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
    if libproc.proc_pidinfo(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info)) != ctypes.sizeof(info):
        raise OSError('identity_unknown')
    if info.pid != pid or info.status == 5 or not info.start_sec:
        raise ValueError('identity_unknown')
    return boot.value.decode(), info.uid, f'{info.start_sec}:{info.start_usec}', info.pgid


def linux_identity(pid):
    fields = Path(f'/proc/{pid}/stat').read_text().rsplit(') ', 1)[1].split()
    if fields[0] in ('Z', 'X'):
        raise ValueError('identity_unknown')
    uid = Path(f'/proc/{pid}').stat().st_uid
    boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    return boot, uid, fields[19], int(fields[2])


def identity(machine, pid, terminal, pgid):
    try:
        if not machine or not terminal or pid <= 0 or pgid <= 0:
            raise ValueError('identity_unknown')
        probe = {'Linux': linux_identity, 'Darwin': darwin_identity}[platform.system()]
        first = probe(pid)
        if first != probe(pid) or not first[0] or not first[2] or first[3] != pgid:
            raise ValueError('identity_unknown')
        return dict(machine=machine, boot=first[0], uid=first[1], pid=pid,
                    start=first[2], process_group=first[3], terminal=terminal)
    except (OSError, ValueError, KeyError, IndexError):
        return None


if __name__ == '__main__':
    try:
        if sys.argv[1] == 'lock':
            lock_fd(3, int(sys.argv[2]))
        elif sys.argv[1] == 'identity':
            request = json.load(sys.stdin)
            print(json.dumps(identity(**request)))
        else:
            raise ValueError('invalid_operation')
    except Exception:
        print('worker_primitive_unavailable', file=sys.stderr)
        sys.exit(75)
