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
cleanup() { rm -f -- "$archive" "$archive.zip"; [[ ! -d "$staging" ]] || rm -rf -- "$staging"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

# SSH carries only a small manifest. The signed artifact URL stays in process memory.
download_code=$(cat <<'PY_DOWNLOAD'
import hashlib, http.client, ipaddress, json, os, re, signal, socket, ssl, stat, struct, sys, time, urllib.parse, zipfile

MAX_TGZ = 128 * 1024 * 1024
MAX_ZIP = MAX_TGZ + 1024 * 1024
class Rejected(Exception):
    pass

def reject(code):
    raise Rejected(code)

def read_manifest(stream, commit):
    payload = stream.read(16385)
    if not payload or len(payload) > 16384:
        reject('MANIFEST_SIZE')
    manifest = json.loads(payload)
    if not isinstance(manifest, dict) or set(manifest) != {'version', 'commit', 'url', 'zipSha256', 'tgzSha256', 'size'}:
        reject('MANIFEST_FIELDS')
    if type(manifest['version']) is not int or manifest['version'] != 1 or manifest['commit'] != commit:
        reject('MANIFEST_COMMIT')
    if type(manifest['size']) is not int or not 0 < manifest['size'] <= MAX_TGZ:
        reject('TGZ_SIZE')
    for field in ('zipSha256', 'tgzSha256'):
        if not isinstance(manifest[field], str) or not re.fullmatch(r'[0-9a-f]{64}', manifest[field]):
            reject('MANIFEST_DIGEST')
    return manifest

def validated_target(raw_url):
    if not isinstance(raw_url, str) or len(raw_url) > 8192 or any(ord(c) <= 32 or ord(c) == 127 for c in raw_url) or '\\' in raw_url:
        reject('URL_FORMAT')
    url = urllib.parse.urlsplit(raw_url)
    if (url.scheme != 'https' or url.username is not None or url.password is not None or
            url.port not in (None, 443) or url.fragment or
            not re.fullmatch(r'productionresultssa[0-9]{1,5}\.blob\.core\.windows\.net', url.hostname or '')):
        reject('URL_HOST')
    addresses = list(dict.fromkeys(item[4][0] for item in socket.getaddrinfo(url.hostname, 443, type=socket.SOCK_STREAM)))
    if not addresses or any(not ipaddress.ip_address(value).is_global or ipaddress.ip_address(value).is_multicast for value in addresses):
        reject('DNS_ADDRESS')
    address = next((value for value in addresses if ':' not in value), addresses[0])
    return url.hostname, address, urllib.parse.urlunsplit(('', '', url.path or '/', url.query, ''))

class PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host, address):
        super().__init__(host, port=443, timeout=10, context=ssl.create_default_context())
        self.address = address
    def connect(self):
        raw = socket.create_connection((self.address, 443), timeout=10)
        try:
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
        except Exception:
            raw.close()
            raise

def fetch_zip(manifest, destination):
    host, address, target = validated_target(manifest['url'])
    connection = PinnedHTTPSConnection(host, address)
    deadline = time.monotonic() + 180
    checksum, total = hashlib.sha256(), 0
    try:
        connection.request('GET', target, headers={'Host': host, 'Accept-Encoding': 'identity', 'User-Agent': 'zijintaizhang-deploy/1'})
        response = connection.getresponse()
        if 300 <= response.status < 400:
            reject('REDIRECT_NOT_ALLOWED')
        if response.status != 200:
            reject('HTTP_STATUS_' + str(response.status))
        length = response.getheader('Content-Length')
        if length is not None and (not length.isdigit() or not 0 < int(length) <= MAX_ZIP):
            reject('ZIP_SIZE')
        if response.getheader('Content-Encoding') not in (None, '', 'identity'):
            reject('CONTENT_ENCODING')
        with open(destination, 'wb') as output:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    reject('DOWNLOAD_TIMEOUT')
                if connection.sock:
                    connection.sock.settimeout(min(10, remaining))
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_ZIP:
                    reject('ZIP_SIZE')
                checksum.update(chunk)
                output.write(chunk)
        if not total or (length is not None and total != int(length)):
            reject('INCOMPLETE_DOWNLOAD')
        if checksum.hexdigest() != manifest['zipSha256']:
            reject('ZIP_CHECKSUM')
    finally:
        connection.close()

def extract_package(zip_path, destination, manifest):
    # Check the central-directory count before ZipFile allocates entry objects.
    size = os.path.getsize(zip_path)
    if not 22 <= size <= MAX_ZIP:
        reject('ZIP_SIZE')
    with open(zip_path, 'rb') as source:
        source.seek(max(0, size - 65557))
        tail = source.read()
    end = tail.rfind(b'PK\x05\x06')
    if end < 0 or end + 22 > len(tail):
        reject('ZIP_DIRECTORY')
    _, disk, directory_disk, disk_entries, entries, directory_size, offset, comment = struct.unpack('<4s4H2LH', tail[end:end + 22])
    end_position = size - len(tail) + end
    if disk or directory_disk or disk_entries != 1 or entries != 1 or directory_size > 65536 or offset + directory_size != end_position or end + 22 + comment != len(tail):
        reject('ZIP_DIRECTORY')
    with zipfile.ZipFile(zip_path) as package:
        members = package.infolist()
        if len(members) != 1:
            reject('ZIP_ENTRIES')
        member = members[0]
        expected = 'zijintaizhang-' + manifest['commit'] + '.tar.gz'
        mode = stat.S_IFMT(member.external_attr >> 16)
        if (member.filename != expected or member.is_dir() or mode not in (0, stat.S_IFREG) or
                member.flag_bits & 1 or member.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED) or
                member.file_size != manifest['size'] or member.compress_size > MAX_ZIP):
            reject('ZIP_MEMBER')
        checksum, total = hashlib.sha256(), 0
        with package.open(member) as source, open(destination, 'wb') as output:
            while True:
                chunk = source.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > manifest['size']:
                    reject('TGZ_SIZE')
                checksum.update(chunk)
                output.write(chunk)
        if total != manifest['size'] or checksum.hexdigest() != manifest['tgzSha256']:
            reject('TGZ_CHECKSUM')

def main():
    archive, commit = sys.argv[1:]
    signal.signal(signal.SIGALRM, lambda *_: reject('DOWNLOAD_TIMEOUT'))
    signal.alarm(180)
    manifest = read_manifest(sys.stdin.buffer, commit)
    disk = os.statvfs(os.path.dirname(archive))
    if disk.f_bavail * disk.f_frsize < MAX_ZIP + manifest['size'] + 128 * 1024 * 1024:
        reject('DISK_SPACE')
    fetch_zip(manifest, archive + '.zip')
    extract_package(archive + '.zip', archive, manifest)
    os.unlink(archive + '.zip')
    signal.alarm(0)
    print('Artifact downloaded and checksums verified.')

if __name__ == '__main__':
    try:
        main()
    except Rejected as error:
        print('Artifact transfer rejected: ' + str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        # Exceptions from HTTP/TLS/ZIP libraries may contain the signed URL.
        print('Artifact transfer failed; no release was activated.', file=sys.stderr)
        sys.exit(1)
PY_DOWNLOAD
)
timeout 190s python3 -c "$download_code" "$archive" "$commit"
unset download_code
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
