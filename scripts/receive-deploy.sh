#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
export PATH=/usr/local/bin:/usr/bin:/bin
unset NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH

APP_ROOT=/home/ubuntu/zhuge-ai-lab/zijintaizhang
if [[ $# -ne 0 || ! ${SSH_ORIGINAL_COMMAND:-} =~ ^deploy\ ([0-9a-f]{40})$ ]]; then
  echo 'Only deploy <40-character commit SHA> is accepted.' >&2
  exit 64
fi
commit=${BASH_REMATCH[1]}
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || { echo 'Linux x86_64 is required.' >&2; exit 1; }
[[ -f "$APP_ROOT/shared/config.json" && -x "$APP_ROOT/bin/deploy-release.sh" ]] || { echo 'Deployment bootstrap is incomplete.' >&2; exit 1; }
mkdir -p "$APP_ROOT/incoming"
exec 9>"$APP_ROOT/.deploy.lock"
flock -w 10 9 || { echo 'Another deployment is running.' >&2; exit 1; }
archive=$(mktemp "$APP_ROOT/incoming/archive.XXXXXX")
staging=$(mktemp -d "$APP_ROOT/incoming/release.$commit.XXXXXX")
cleanup() { rm -f -- "$archive"; [[ ! -d "$staging" ]] || rm -rf -- "$staging"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

# Read at most 128 MiB plus one byte, including a bounded receive time.
python3 - "$APP_ROOT" <<'PY_RECEIVE_SPACE'
import os, sys
disk = os.statvfs(sys.argv[1])
if disk.f_bavail * disk.f_frsize < 256 * 1024 * 1024:
    raise SystemExit('Insufficient free space to receive a bounded release archive.')
PY_RECEIVE_SPACE
timeout 300s head -c 134217729 > "$archive"
python3 - "$archive" "$staging" "$commit" <<'PY_VALIDATE'
import hashlib, json, os, pathlib, sys, tarfile

archive, destination, commit = sys.argv[1:]
root = pathlib.Path(destination)
allowed = {'dist', 'server', 'shared', 'scripts', 'node_modules', 'runtime',
           'package.json', 'package-lock.json', 'ecosystem.config.cjs', 'release.json'}
required = ['dist/index.html', 'server/index.js', 'server/app.js', 'shared/constants.js',
            'scripts/admin-init.js', 'package.json', 'package-lock.json',
            'ecosystem.config.cjs', 'runtime/node', 'release.json']
if not 0 < os.path.getsize(archive) <= 128 * 1024 * 1024:
    raise SystemExit('Archive is empty or exceeds 128 MiB.')
seen, total = set(), 0
with tarfile.open(archive, 'r:gz') as package:
    for member in package:
        name = member.name.rstrip('/')
        parts = name.split('/')
        if (not name or name.startswith('/') or '\\' in name or
                any(part in ('', '.', '..') for part in parts) or parts[0] not in allowed):
            raise SystemExit('Unsafe or unexpected archive path.')
        if name in seen or len(seen) >= 30000:
            raise SystemExit('Duplicate path or too many archive entries.')
        seen.add(name)
        if not (member.isdir() or member.isfile()):
            raise SystemExit('Links and special files are not accepted.')
        if member.size < 0 or member.size > 160 * 1024 * 1024:
            raise SystemExit('Archive member exceeds the size limit.')
        total += member.size
        if total > 512 * 1024 * 1024:
            raise SystemExit('Expanded archive exceeds 512 MiB.')
        target = root.joinpath(*parts)
        if member.isdir():
            target.mkdir(parents=True, exist_ok=True)
            target.chmod(0o755)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        disk = os.statvfs(root)
        if disk.f_bavail * disk.f_frsize < member.size + 128 * 1024 * 1024:
            raise SystemExit('Insufficient free space to safely expand the release.')
        source = package.extractfile(member)
        if source is None:
            raise SystemExit('Missing archive member contents.')
        remaining = member.size
        with source, target.open('xb') as output:
            while remaining:
                chunk = source.read(min(1024 * 1024, remaining))
                if not chunk:
                    raise SystemExit('Truncated archive member.')
                output.write(chunk)
                remaining -= len(chunk)
        target.chmod(0o755 if member.mode & 0o111 else 0o644)
if not all(root.joinpath(name).is_file() for name in required):
    raise SystemExit('Required release files are missing.')
manifest = json.loads(root.joinpath('release.json').read_text())
if manifest.get('commit') != commit or manifest.get('platform') != 'linux' or manifest.get('arch') != 'x64':
    raise SystemExit('Release provenance or platform does not match.')
with root.joinpath('runtime/node').open('rb') as runtime:
    checksum = hashlib.sha256()
    for chunk in iter(lambda: runtime.read(1024 * 1024), b''):
        checksum.update(chunk)
    runtime_hash = checksum.hexdigest()
if manifest.get('runtimeSha256') != runtime_hash:
    raise SystemExit('Bundled Node runtime checksum does not match.')
if root.joinpath('runtime/node').stat().st_mode & 0o111 == 0:
    raise SystemExit('Bundled Node runtime is not executable.')
PY_VALIDATE

# Use the reviewed bootstrap script, never the deployment script inside the uploaded package.
"$APP_ROOT/bin/deploy-release.sh" "$commit" "$staging"
