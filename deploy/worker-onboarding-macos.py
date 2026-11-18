"""Read-only Darwin probes, shipped inline by the Linux controller.

`native` is the controller's worker-primitives module, never a worker import.
Shared require/protected functions are defined by worker-onboarding-probes.ts.
"""
import os
import plistlib
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



def macos_resources(c):
    base = c['home'] + '/.local/state/herdr-core/' + c['session'] + '/' + c['session']
    require(all(len(path.encode('utf-8')) <= 103 for path in
                (base + '.sock', base + '.holder.00000000.sock')))
    # hc owns core.lock and crash recovery. A second supervisor is forbidden,
    # even if currently stopped: a remaining plist can return at the next boot.
    label = c['launchd']['label']
    try:
        os.lstat('/Library/LaunchDaemons/' + label + '.plist')
    except FileNotFoundError:
        pass
    except OSError:
        require(False)
    else:
        require(False)
    result = subprocess.run(['/bin/launchctl', 'print', 'system/' + label],
                            stdin=subprocess.DEVNULL, capture_output=True,
                            timeout=c['timeout'], env=dict(PATH='/usr/bin:/bin', LC_ALL='C'))
    require(result.returncode == 113 and
            ('Could not find service "' + label + '" in domain for system') in result.stderr.decode())
