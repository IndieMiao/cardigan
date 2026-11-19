"""Synthetic Darwin observations only; never contacts a Mac, launchd or sudo."""
import builtins
import ctypes
import errno
import io
import json
import os
import platform
import plistlib
import shutil
import subprocess
import sys
import types
import urllib.error
import urllib.request

c = json.loads(sys.argv[1])
fault = c.get('fixture', 'safe')
platform.system = lambda: 'Darwin'
platform.machine = lambda: 'x86_64' if fault == 'intel' else 'arm64'
os.environ['PATH'] = c['path']


def forbidden(*args, **kwargs):
    raise AssertionError('Linux-only operation or unexpected IO')


if c['step'] in ('account', 'directories', 'helpers'):
    if c['step'] == 'account':
        policy = subprocess.run
        install_group_observations(native, account, fault)
        scenario = fault if fault in ('allowed', 'password') else 'safe'

        def run(argv, **kwargs):
            if argv[0] == '/usr/bin/dscl':
                assert argv == ['/usr/bin/dscl', '-plist', '.', '-read', '/Users/' + c['user'],
                                'UniqueID', 'PrimaryGroupID', 'NFSHomeDirectory']
                value = {'dsAttrTypeStandard:UniqueID': [str(c['uid'])],
                         'dsAttrTypeStandard:PrimaryGroupID': [str(c['gid'])],
                         'dsAttrTypeStandard:NFSHomeDirectory': [c['home']]}
                if fault == 'dscl-uid': value['dsAttrTypeStandard:UniqueID'] = ['0']
                return types.SimpleNamespace(returncode=0, stdout=plistlib.dumps(value))
            return policy(argv, **kwargs)
        subprocess.run = run
    else:
        native['acl_safe'] = lambda fd: not attributes(fd)
        def physical_pwd(argv, *, cwd, **kwargs):
            assert argv == ['/bin/pwd', '-P']
            return types.SimpleNamespace(stdout=os.fsencode(str(cwd).removeprefix('/System/Volumes/Data')) + b'\n')
        subprocess.run = physical_pwd
    os.listxattr = forbidden
elif c['step'] == 'tools':
    actual_open = builtins.open
    paths = {name: '/opt/homebrew/bin/' + name for name in ('node', 'git', 'pnpm')}
    if fault == 'arm64e-git': paths['git'] = '/usr/bin/git'
    paths.update(hc=c['launchd']['hc_path'], **{'herdr-core': c['home'] + '/.local/bin/herdr-core'})
    shutil.which = lambda name, **kwargs: paths.get(name)
    original_realpath = os.path.realpath
    os.path.realpath = lambda path: CORE if path in (paths['hc'], paths['herdr-core']) else path

    def opened(path, *args, **kwargs):
        if path == paths['pnpm']: return io.BytesIO(b'#!/usr/bin/env node\n')
        if path == APP + '/Contents/Info.plist':
            return io.BytesIO(plistlib.dumps(dict(CFBundleIdentifier='dev.herdr.core',
                                                   CFBundleShortVersionString=c['hc_version'])))
        return actual_open(path, *args, **kwargs)
    builtins.open = opened
    checked = set()

    def run(argv, **kwargs):
        assert kwargs['env']['PATH'] == c['path'] and kwargs['env']['HOME'] == c['home']
        assert kwargs['stdin'] == subprocess.DEVNULL
        if argv[0] == '/usr/bin/lipo':
            assert argv[1] == '-archs'
            checked.add(argv[2])
            arch = b'x86_64' if fault == 'intel-tool' else b'arm64 x86_64'
            if fault == 'arm64e-tools': arch = b'arm64e'
            if fault == 'arm64e-git' and argv[2] == paths['git']: arch = b'x86_64 arm64e'
            if fault == 'unknown-arch': arch = b'arm64_unknown'
            return types.SimpleNamespace(returncode=0, stdout=arch)
        if argv[0] == '/usr/bin/codesign':
            assert argv == ['/usr/bin/codesign', '--verify', '--deep', '--strict', '-R',
                            '=anchor apple generic and identifier "dev.herdr.core" and certificate leaf[subject.OU] = "2W9652Q7QR"', APP]
            return types.SimpleNamespace(returncode=1 if fault == 'signature' else 0, stdout=b'')
        if argv == [paths['node'], '-p', 'process.arch']:
            assert paths['node'] in checked
            return types.SimpleNamespace(returncode=0, stdout=b'x64' if fault == 'rosetta' else b'arm64')
        name = argv[0]
        assert argv[1:] == ['--version']
        if name in ('node', 'git', 'hc'): assert os.path.realpath(paths[name]) in checked
        versions = {'hc': 'hc ' + c['hc_version'], 'git': 'git version 2.49.0', 'node': 'v24.0.0', 'pnpm': '11.7.0'}
        if fault == 'version': versions['hc'] = 'hc 0.0.0'
        return types.SimpleNamespace(returncode=0, stdout=versions[name].encode())
    subprocess.run = run
elif c['step'] == 'resources':
    label = c['launchd']['label']
    original_lstat = os.lstat
    def lstat(filename, *args, **kwargs):
        if str(filename) != '/Library/LaunchDaemons/' + label + '.plist':
            return original_lstat(filename, *args, **kwargs)
        if fault in ('plist-present', 'plist-symlink'):
            return types.SimpleNamespace(st_mode=0o120777 if fault == 'plist-symlink' else 0o100644)
        errors = {'plist-eacces': errno.EACCES, 'plist-eio': errno.EIO,
                  'plist-enotdir': errno.ENOTDIR, 'plist-eloop': errno.ELOOP}
        raise OSError(errors.get(fault, errno.ENOENT), 'synthetic metadata observation', str(filename))
    os.lstat = lstat
    def run(argv, **kwargs):
        assert argv == ['/bin/launchctl', 'print', 'system/' + label]
        assert kwargs['env'] == dict(PATH='/usr/bin:/bin', LC_ALL='C')
        if fault == 'timeout': raise subprocess.TimeoutExpired(argv, 1)
        code = 0 if fault == 'loaded' else 113
        error = ('Could not find service "' + label + '" in domain for system').encode()
        if fault == 'permission-denied': error = b'Operation not permitted'
        if fault == 'wrong-label': error = b'Could not find service "other" in domain for system'
        return types.SimpleNamespace(returncode=code, stdout=b'', stderr=error)
    subprocess.run = run
elif c['step'] == 'mcp':
    class Endpoint:
        def open(self, request, timeout):
            assert request.full_url == c['mcp_url'] and not request.has_header('Authorization')
            raise urllib.error.HTTPError(request.full_url, 401 if fault == 'safe' else 403, 'SECRET', {}, None)
    urllib.request.build_opener = lambda *args: Endpoint()
