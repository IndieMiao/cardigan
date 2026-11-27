/**
 * C-823: Claude Code keeps onboarding and folder trust in
 * `<CLAUDE_CONFIG_DIR>/.claude.json` (`projects.<cwd>.hasTrustDialogAccepted`)
 * and theme / bypass confirmation in `settings.json`. A local Assignment keeps
 * one config directory across Runs, so the file written on the first launch
 * can trust a different cwd than a later one (an Assignment that moved from
 * its run directory to a worktree). Claude then stops at "Quick safety check:
 * Is this a project you created or one you trust?" and never starts MCP.
 *
 * This script runs on every launch (new session, resume, replacement), as the
 * CLI user, before the CLI starts. It adds trust for the exact cwd (and its
 * resolved form) to the existing state and keeps every other key; it never
 * widens trust to a parent or touches the user's own configuration.
 *
 * argv: <config dir> <cwd>...
 */
export const CLAUDE_TRUST_SCRIPT = String.raw`import json, os, stat, sys
directory, cwds = sys.argv[1], sys.argv[2:]
def fail(message):
    sys.stderr.write('cardigan: ' + message + '\n')
    sys.exit(78)
def load(name):
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=dirfd)
    except FileNotFoundError:
        return None
    except OSError:
        fail('Claude ' + name + ' must be a regular file, not a symlink')
    with os.fdopen(fd, 'rb') as f:
        if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):
            fail('Claude ' + name + ' must be a regular file, not a symlink')
        raw = f.read(16 * 1024 * 1024)
    try:
        value = json.loads(raw) if raw.strip() else {}
    except ValueError:
        fail('Claude ' + name + ' is not valid JSON')
    if not isinstance(value, dict):
        fail('Claude ' + name + ' is not a JSON object')
    return value
def save(name, value, replace):
    data = (json.dumps(value, indent=2) + '\n').encode()
    temporary = '.' + name + '.cardigan-' + str(os.getpid())
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=dirfd)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        if replace:
            os.replace(temporary, name, src_dir_fd=dirfd, dst_dir_fd=dirfd)
        else:
            # Never replace a file another process created meanwhile.
            os.link(temporary, name, src_dir_fd=dirfd, dst_dir_fd=dirfd, follow_symlinks=False)
            os.unlink(temporary, dir_fd=dirfd)
    except BaseException:
        try:
            os.unlink(temporary, dir_fd=dirfd)
        except OSError:
            pass
        raise
dirfd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    try:
        os.stat('settings.json', dir_fd=dirfd, follow_symlinks=False)
    except FileNotFoundError:
        save('settings.json', dict(theme='dark', skipDangerousModePermissionPrompt=True, autoMemoryEnabled=False), False)
    state = load('.claude.json')
    before = json.dumps(state, sort_keys=True)
    state = state if state is not None else {}
    state['hasCompletedOnboarding'] = True
    state.setdefault('lastOnboardingVersion', '2.1.318')
    projects = state.get('projects')
    if not isinstance(projects, dict):
        projects = state['projects'] = {}
    for cwd in cwds:
        for path in dict.fromkeys([cwd, os.path.realpath(cwd)]):
            entry = projects.get(path)
            if not isinstance(entry, dict):
                entry = projects[path] = {}
            entry['hasTrustDialogAccepted'] = True
    if json.dumps(state, sort_keys=True) != before:
        save('.claude.json', state, before != 'null')
finally:
    os.close(dirfd)
`;
