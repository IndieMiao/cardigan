/** Linux pidfds bind each signal to the inspected process, never to a recycled PID.
 * This helper has no fallback signal and never reads or returns terminal content.
 */
export const idleRetirementHelper = String.raw`
import errno, json, os, pathlib, signal, sys
try:
    mode, raw_pid, terminal = sys.argv[1:4]
    pid = int(raw_pid)
    if pid <= 1: sys.exit(2)
    if not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
        sys.exit(20)
    fd = os.pidfd_open(pid)
    try:
        root = pathlib.Path('/proc') / str(pid)
        uid = root.stat().st_uid
        raw = (root / 'stat').read_text()
        fields = raw[raw.rfind(')') + 2:].split()
        start = fields[19]
        boot = pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()
        marker = b'HC_TERMINAL_ID=' + terminal.encode()
        if uid != os.getuid(): sys.exit(21)
        if fields[0] == 'Z': sys.exit(23)
        if marker not in (root / 'environ').read_bytes().split(b'\0'): sys.exit(22)
        identity = {'pid': pid, 'uid': uid, 'start': start, 'boot': boot}
        if mode == 'probe':
            print(json.dumps(identity))
        elif mode in ('HUP', 'TERM'):
            if identity != json.loads(sys.argv[4]):
                sys.exit(24)
            signal.pidfd_send_signal(fd, signal.SIGHUP if mode == 'HUP' else signal.SIGTERM)
        else:
            raise ValueError()
    finally:
        os.close(fd)
except PermissionError:
    sys.exit(21)
except (FileNotFoundError, ProcessLookupError):
    sys.exit(23)
except OSError as e:
    sys.exit(20 if e.errno == errno.ENOSYS else 2)
except Exception:
    sys.exit(2)
`;
