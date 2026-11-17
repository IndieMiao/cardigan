/** Linux pidfds bind each signal to the inspected process, never to a recycled PID.
 * This helper has no fallback signal and never reads or returns terminal content.
 */
export const idleRetirementHelper = String.raw`
import json, os, pathlib, signal, sys
try:
    mode, raw_pid, terminal = sys.argv[1:4]
    pid = int(raw_pid)
    if pid <= 1 or not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
        raise ValueError()
    fd = os.pidfd_open(pid)
    try:
        root = pathlib.Path('/proc') / str(pid)
        uid = root.stat().st_uid
        raw = (root / 'stat').read_text()
        fields = raw[raw.rfind(')') + 2:].split()
        start = fields[19]
        boot = pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()
        marker = b'HC_TERMINAL_ID=' + terminal.encode()
        if uid != os.getuid() or marker not in (root / 'environ').read_bytes().split(b'\0') or fields[0] == 'Z':
            raise ValueError()
        identity = {'pid': pid, 'uid': uid, 'start': start, 'boot': boot}
        if mode == 'probe':
            print(json.dumps(identity))
        elif mode in ('HUP', 'TERM'):
            if identity != json.loads(sys.argv[4]):
                raise ValueError()
            signal.pidfd_send_signal(fd, signal.SIGHUP if mode == 'HUP' else signal.SIGTERM)
        else:
            raise ValueError()
    finally:
        os.close(fd)
except Exception:
    sys.exit(2)
`;
