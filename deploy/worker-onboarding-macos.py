"""Read-only Darwin probes, shipped inline by the Linux controller.

`native` is the controller's worker-primitives module, never a worker import.
Shared require/protected functions are defined by worker-onboarding-probes.ts.
"""
import ctypes
import os
import pathlib
import plistlib
import re
import shutil
import subprocess
import sys

APP = '/Applications/Herdr Core.app'
CORE = APP + '/Contents/MacOS/herdr-core'


def command(c, argv):
    result = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True,
                            timeout=c['timeout'], env=dict(PATH=c['path'], HOME=c['home'], LC_ALL='C'))
    require(result.returncode == 0 and len(result.stdout) <= 65536)
    return result.stdout


def macos_account(c):
    data = plistlib.loads(command(c, ['/usr/bin/dscl', '-plist', '.', '-read', '/Users/' + c['user'],
                                     'UniqueID', 'PrimaryGroupID', 'NFSHomeDirectory']))
    for key, value in [('UniqueID', str(c['uid'])), ('PrimaryGroupID', str(c['gid'])), ('NFSHomeDirectory', c['home'])]:
        require(data.get('dsAttrTypeStandard:' + key) == [value])


def native_binary(c, path):
    # Inspect before execution: an x86-only tool must never invoke Rosetta.
    actual = os.path.realpath(path)
    architectures = command(c, ['/usr/bin/lipo', '-archs', actual]).decode().split()
    # arm64e is Apple's native ARM64 subtype, used by system tools such as Git.
    require(bool({'arm64', 'arm64e'} & set(architectures)))
    return actual


def macos_tools(c):
    require(os.environ['PATH'] == c['path'])
    require('/opt/homebrew/bin' in c['path'].split(':'))
    resolved = {}
    for name in ('node', 'git', 'hc', 'herdr-core'):
        path = shutil.which(name, path=c['path'])
        require(path is not None)
        resolved[name] = native_binary(c, path)
    require(resolved['hc'] == resolved['herdr-core'] == CORE)
    require(os.path.realpath(c['launchd']['hc_path']) == CORE)
    native_binary(c, sys.executable)
    native_binary(c, c['python'])
    require(command(c, [resolved['node'], '-p', 'process.arch']).strip() == b'arm64')
    # pnpm is a Node entry script, or a native standalone binary. Inspect its
    # interpreter too, rather than treating an arbitrary script as architecture proof.
    pnpm = shutil.which('pnpm', path=c['path'])
    require(pnpm is not None)
    with open(pnpm, 'rb') as file:
        first = file.readline(256).strip()
    if first != b'#!/usr/bin/env node':
        native_binary(c, pnpm)
    command(c, ['/usr/bin/codesign', '--verify', '--deep', '--strict', '-R',
                '=anchor apple generic and identifier "dev.herdr.core" and certificate leaf[subject.OU] = "2W9652Q7QR"', APP])
    with open(APP + '/Contents/Info.plist', 'rb') as file:
        info = plistlib.load(file)
    require(info.get('CFBundleIdentifier') == 'dev.herdr.core'
            and info.get('CFBundleShortVersionString') == c['hc_version'])


def process_path(pid):
    libproc = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
    libproc.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
    buffer = ctypes.create_string_buffer(4096)
    require(libproc.proc_pidpath(pid, buffer, len(buffer)) > 0)
    return buffer.value.decode()


def process_credentials(pid, identity):
    # Read the running process, not its account's current directory-service
    # membership or its process group (pgid is unrelated to permission groups).
    libproc = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
    info = native['ProcBSDInfo']()
    libproc.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
    require(libproc.proc_pidinfo(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info)) == ctypes.sizeof(info))
    require(info.pid == pid and info.status != 5 and info.start_sec > 0
            and f'{info.start_sec}:{info.start_usec}' == identity['start']
            and info.pgid == identity['process_group'])
    return (info.uid, info.ruid, info.svuid, info.gid, info.rgid, info.svgid)


def macos_resources(c):
    # No XDG/HC_SOCKET overrides in the supported LaunchDaemon environment.
    base = c['home'] + '/.local/state/herdr-core/' + c['session'] + '/' + c['session']
    require(all(len(path.encode('utf-8')) <= 103 for path in
                (base + '.sock', base + '.holder.00000000.sock')))
    service = c['launchd']
    label = service['label']
    path = '/Library/LaunchDaemons/' + label + '.plist'
    # System LaunchDaemon + UserName runs without a desktop login. Never bootstrap
    # or kickstart from a probe; failed observations leave operator action pending.
    protected(path, 0, 0, 0o644, True)
    with open(path, 'rb') as file:
        plist = plistlib.load(file)
    arguments = [CORE, 'serve']
    require(plist.get('Label') == label and plist.get('ProgramArguments') == arguments)
    require(plist.get('Program', CORE) == CORE and plist.get('UserName') == c['user'])
    require(plist.get('WorkingDirectory') == c['home'])
    environment = dict(PATH=c['path'], HOME=c['home'], HC_SESSION=c['session'], HC_RUNTIME='1')
    require(plist.get('EnvironmentVariables') == environment)
    require(plist.get('RunAtLoad') is True and plist.get('KeepAlive') is True)
    require(plist.get('InitGroups') is False and plist.get('ProcessType') == 'Background')
    require(not any(key in plist for key in ('RootDirectory', 'GroupName', 'LimitLoadToSessionType', 'Disabled')))
    output = command(c, ['/bin/launchctl', 'print', 'system/' + label]).decode()

    def field(name):
        matches = re.findall(r'^\t' + re.escape(name) + r' = (.+)$', output, re.M)
        require(len(matches) == 1)
        return matches[0]

    require(field('path') == path and field('program') == CORE and field('state') == 'running')
    require(field('username') == c['user'] and field('working directory') == c['home'])
    args = re.search(r'^\targuments = \{\n(.*?)^\t\}', output, re.M | re.S)
    require(args is not None and [line.strip() for line in args[1].splitlines()] == arguments)
    env = re.search(r'^\tenvironment = \{\n(.*?)^\t\}', output, re.M | re.S)
    require(env is not None)
    for key, value in environment.items():
        require(re.findall(r'^\s+' + key + r' => (.+)$', env[1], re.M) == [value])
    require(not re.search(r'^\s+(?:HC_SOCKET|XDG_RUNTIME_DIR|XDG_STATE_HOME|XDG_CONFIG_HOME) =>', env[1], re.M))
    pid = int(field('pid'))
    require(pid > 0)
    process_group = os.getpgid(pid)
    before = native['identity'](label, pid, label, process_group)
    require(before is not None and before['uid'] == c['uid'])
    credentials = (c['uid'], c['uid'], c['uid'], c['gid'], c['gid'], c['gid'])
    require(process_credentials(pid, before) == credentials)
    require(process_path(pid) == CORE)
    require(process_credentials(pid, before) == credentials)
    require(native['identity'](label, pid, label, process_group) == before)
