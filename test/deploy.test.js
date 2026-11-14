import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = fileURLToPath(new URL('..', import.meta.url));
const receiver = readFileSync(join(root, 'scripts/receive-deploy.sh'), 'utf8');
const deploy = readFileSync(join(root, 'scripts/deploy-release.sh'), 'utf8');
const commit = 'a'.repeat(40);
const heredoc = (source, marker) => source.split(`<<'${marker}'\n`)[1].split(`\n${marker}`)[0];
const validateCode = heredoc(receiver, 'PY_VALIDATE');
const downloadCode = heredoc(receiver, 'PY_DOWNLOAD');
const ownershipCode = heredoc(deploy, 'PY_OWNERSHIP');
const runPython = (code, args = [], input) => spawnSync('python3', ['-c', code, ...args], { input, encoding: 'utf8' });

function checkDownload(code, data = {}) {
  const result = runPython(`
import json, sys
payload = json.load(sys.stdin)
scope = {'__name__': 'receiver_test', 'test_data': payload['data']}
exec(payload['source'], scope)
exec(payload['test'], scope)
`, [], JSON.stringify({ source: downloadCode, test: code, data }));
  assert.equal(result.status, 0, result.stderr);
}

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'zijintaizhang-deploy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function packageEntries() {
  const runtime = 'synthetic-node-runtime';
  return [
    ...['dist/index.html', 'server/index.js', 'server/app.js', 'shared/constants.js',
      'scripts/admin-init.js', 'package.json', 'package-lock.json', 'ecosystem.config.cjs']
      .map((name) => ({ name, text: '{}' })),
    { name: 'runtime/node', text: runtime, mode: 0o755 },
    { name: 'release.json', text: JSON.stringify({ commit, platform: 'linux', arch: 'x64',
      runtimeSha256: createHash('sha256').update(runtime).digest('hex') }) },
  ];
}

function validatePackage(dir, entries) {
  const archive = join(dir, 'release.tgz');
  const destination = join(dir, `unpacked-${Math.random().toString(36).slice(2)}`);
  mkdirSync(destination);
  const makeArchive = runPython(`
import io, json, sys, tarfile
with tarfile.open(sys.argv[1], 'w:gz') as package:
    for entry in json.load(sys.stdin):
        info = tarfile.TarInfo(entry['name'])
        info.mode = entry.get('mode', 0o644)
        content = entry.get('text', '').encode()
        info.size = entry.get('size', len(content))
        kind = entry.get('type', 'file')
        if kind == 'symlink': info.type, info.linkname = tarfile.SYMTYPE, entry.get('link', '/tmp/escape')
        if kind == 'hardlink': info.type, info.linkname = tarfile.LNKTYPE, entry.get('link', '/tmp/escape')
        if kind == 'device': info.type = tarfile.CHRTYPE
        package.addfile(info, io.BytesIO(content) if kind == 'file' and 'size' not in entry else None)
`, [archive], JSON.stringify(entries));
  assert.equal(makeArchive.status, 0, makeArchive.stderr);
  return runPython(validateCode, [archive, destination, commit]);
}

test('部署脚本通过 Bash 语法检查，接收入口只允许精确部署命令', () => {
  for (const script of ['receive-deploy.sh', 'deploy-release.sh']) {
    const result = spawnSync('bash', ['-n', join(root, 'scripts', script)], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  for (const command of ['', 'bash', `deploy ${commit}; whoami`, `deploy ${commit} extra`]) {
    const result = spawnSync('bash', [join(root, 'scripts/receive-deploy.sh')], {
      env: { ...process.env, SSH_ORIGINAL_COMMAND: command }, encoding: 'utf8',
    });
    assert.equal(result.status, 64, result.stderr);
  }
});

test('Artifact清单限制体积、提交、摘要与类型，不接受未知字段', () => {
  checkDownload(`
import io
manifest = dict(version=1, commit='a' * 40, url='https://productionresultssa1.blob.core.windows.net/a', zipSha256='b' * 64, tgzSha256='c' * 64, size=42)
def read(value):
    return read_manifest(io.BytesIO(json.dumps(value).encode()), 'a' * 40)
assert read(manifest) == manifest
for changes in ({'version': True}, {'commit': 'd' * 40}, {'size': True}, {'size': 0}, {'size': MAX_TGZ + 1}, {'tgzSha256': 'z' * 64}, {'extra': 'no'}):
    try:
        read(dict(manifest, **changes))
        raise AssertionError(changes)
    except Rejected:
        pass
try:
    read_manifest(io.BytesIO(b' ' * 16385), 'a' * 40)
    raise AssertionError('oversized manifest accepted')
except Rejected as error:
    assert str(error) == 'MANIFEST_SIZE'
`);
});

test('Artifact地址只允许固定HTTPS域，拒绝私网DNS并固定连接IP和TLS主机名', () => {
  checkDownload(`
public_ip = '93.184.216.34'
socket.getaddrinfo = lambda *args, **kwargs: [(socket.AF_INET, socket.SOCK_STREAM, 6, '', (public_ip, 443))]
host = 'productionresultssa123.blob.core.windows.net'
assert validated_target('https://' + host + '/package?signature=synthetic') == (host, public_ip, '/package?signature=synthetic')
for url in ('http://' + host, 'https://name:secret@' + host, 'https://' + host + ':8443/a', 'https://127.0.0.1/a', 'https://other.blob.core.windows.net/a', 'https://' + host + '.attacker.example/a', 'https://' + host + '/a#fragment', 'https://' + host + '/a\\n'):
    try:
        validated_target(url)
        raise AssertionError('unsafe URL accepted')
    except Rejected:
        pass
for address in ('127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', 'fc00::1'):
    socket.getaddrinfo = lambda *args, **kwargs: [(2, 1, 6, '', (public_ip, 443)), (2, 1, 6, '', (address, 443))]
    try:
        validated_target('https://' + host)
        raise AssertionError('unsafe DNS accepted')
    except Rejected as error:
        assert str(error) == 'DNS_ADDRESS'
calls = []
raw = object()
socket.create_connection = lambda target, timeout: calls.append((target, timeout)) or raw
class Context:
    def wrap_socket(self, stream, server_hostname):
        assert stream is raw and server_hostname == host
        return 'tls-socket'
connection = object.__new__(PinnedHTTPSConnection)
connection.address, connection.host, connection._context = public_ip, host, Context()
connection.connect()
assert calls == [((public_ip, 443), 10)] and connection.sock == 'tls-socket'
`);
});

test('Artifact并行分段完整重组，拒绝重定向、越界、范围错位、截断和摘要错误', (t) => {
  const dir = fixture(t);
  checkDownload(`
import io
body = b'bounded test archive'
manifest = dict(url='synthetic', zipSha256=hashlib.sha256(body).hexdigest())
validated_target = lambda url: ('productionresultssa1.blob.core.windows.net', '93.184.216.34', '/package')
state = {}
requests = []
class Response:
    def __init__(self, method, headers):
        self.status = state.get('status', 200 if method == 'HEAD' else 206)
        data = state.get('body', body)
        self.headers = {'Content-Length': str(len(body))}
        if method == 'GET':
            start, end = map(int, headers['Range'][6:].split('-'))
            self.headers = {'Content-Length': str(end - start + 1), 'Content-Range': f'bytes {start}-{end}/{len(body)}'}
            data = data[start:end + 1]
            if state.get('truncate'): data = data[:-1]
        self.headers.update(state.get('headers', {}))
        self.stream = io.BytesIO(data)
    def getheader(self, name): return self.headers.get(name)
    def read(self, size): return self.stream.read(size)
class Connection:
    sock = None
    def __init__(self, *args): pass
    def request(self, method, target, headers):
        self.method, self.headers = method, headers
        requests.append((method, headers.get('Range')))
    def getresponse(self): return Response(self.method, self.headers)
    def close(self): pass
PinnedHTTPSConnection = Connection
destination = os.path.join(test_data['dir'], 'download.zip')
fetch_zip(manifest, destination)
assert open(destination, 'rb').read() == body
assert requests[0] == ('HEAD', None) and len(requests) == 8
for changes, expected in ((dict(status=302), 'REDIRECT_NOT_ALLOWED'), (dict(headers={'Content-Length': str(MAX_ZIP + 1)}), 'ZIP_SIZE'), (dict(headers={'Content-Encoding': 'gzip'}), 'CONTENT_ENCODING'), (dict(truncate=True), 'INCOMPLETE_DOWNLOAD'), (dict(headers={'Content-Range': 'bytes 0-0/1'}), 'CONTENT_RANGE')):
    state = changes
    try:
        fetch_zip(manifest, destination)
        raise AssertionError(expected)
    except Rejected as error:
        assert str(error) == expected
state = dict(body=b'x' * len(body))
try:
    fetch_zip(manifest, destination)
    raise AssertionError('digest mismatch accepted')
except Rejected as error:
    assert str(error) == 'ZIP_CHECKSUM'
MAX_ZIP = 8
try:
    fetch_zip(manifest, destination)
    raise AssertionError('stream limit exceeded')
except Rejected as error:
    assert str(error) == 'ZIP_SIZE'
`, { dir });
});

test('Artifact ZIP仅允许唯一预期普通文件并校验大小和TGZ摘要；错误不泄露签名URL', (t) => {
  const dir = fixture(t);
  checkDownload(`
content = b'synthetic tgz bytes'
manifest = dict(commit='a' * 40, size=len(content), tgzSha256=hashlib.sha256(content).hexdigest())
name = 'zijintaizhang-' + manifest['commit'] + '.tar.gz'
archive, destination = os.path.join(test_data['dir'], 'artifact.zip'), os.path.join(test_data['dir'], 'release.tgz')
def create(names, mode=stat.S_IFREG, data=content):
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_STORED) as package:
        for entry in names:
            info = zipfile.ZipInfo(entry)
            info.external_attr = (mode | 0o644) << 16
            package.writestr(info, data)
create([name])
extract_package(archive, destination, manifest)
assert open(destination, 'rb').read() == content
for names, mode, data in (([name, 'extra'], stat.S_IFREG, content), (['../' + name], stat.S_IFREG, content), ([name], stat.S_IFLNK, content), ([name], stat.S_IFCHR, content), ([name], stat.S_IFREG, b'x'), ([name], stat.S_IFREG, b'x' * len(content))):
    create(names, mode, data)
    try:
        extract_package(archive, destination, manifest)
        raise AssertionError('invalid ZIP accepted')
    except Rejected:
        pass
`, { dir });
  const secret = 'synthetic-signature-must-not-appear';
  const invalid = runPython(downloadCode, [join(dir, 'unused'), commit], JSON.stringify({
    version: 1, commit, url: `https://unapproved.example/file?signature=${secret}`,
    zipSha256: 'b'.repeat(64), tgzSha256: 'c'.repeat(64), size: 1,
  }));
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /URL_HOST/);
  assert.ok(!`${invalid.stdout}${invalid.stderr}`.includes(secret));
});

test('接收器提取合法发布包并核验来源与runtime摘要', (t) => {
  const dir = fixture(t);
  const valid = validatePackage(dir, packageEntries());
  assert.equal(valid.status, 0, valid.stderr);
  const wrongHash = packageEntries();
  wrongHash.find((entry) => entry.name === 'runtime/node').text = 'changed-runtime';
  const invalid = validatePackage(dir, wrongHash);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /checksum/);
});

test('接收器拒绝路径逃逸、重复文件、链接、设备、越界大小和非白名单目录', (t) => {
  const dir = fixture(t);
  for (const entry of [
    { name: '../shared/config.json' },
    { name: '/tmp/escape' },
    { name: 'dist/../../shared/config.json' },
    { name: 'dist\\escape' },
    { name: 'data/business.sqlite' },
    { name: '.env' },
    { name: 'dist/index.html' },
    { name: 'node_modules/link', type: 'symlink' },
    { name: 'node_modules/link', type: 'hardlink' },
    { name: 'runtime/device', type: 'device' },
    { name: 'dist/oversized', size: 160 * 1024 * 1024 + 1 },
  ]) {
    const result = validatePackage(dir, [...packageEntries(), entry]);
    assert.notEqual(result.status, 0, `must reject ${JSON.stringify(entry)}`);
  }
  const missing = validatePackage(dir, packageEntries().filter((entry) => entry.name !== 'server/index.js'));
  assert.notEqual(missing.status, 0);
});

test('端口归属保护只允许新空端口或本项目PM2进程，拒绝无PID和其他目录', (t) => {
  const dir = fixture(t);
  const project = join(dir, 'zijintaizhang');
  const cwd = join(project, 'releases', commit);
  const stateFile = join(dir, 'pm2.json');
  const listenersFile = join(dir, 'listeners.txt');
  const own = { pid: 123, cwd, script: join(cwd, 'server/index.js') };
  function check(apps, listeners) {
    writeFileSync(stateFile, JSON.stringify(apps));
    writeFileSync(listenersFile, listeners);
    return runPython(ownershipCode, [stateFile, listenersFile, project, cwd]);
  }
  assert.equal(check([], '').status, 0);
  assert.equal(check([own], 'LISTEN 0 511 127.0.0.1:4010 users:(("node",pid=123,fd=20))').status, 0);
  assert.notEqual(check([], 'LISTEN 0 511 127.0.0.1:4010 users:(("node",pid=999,fd=20))').status, 0);
  assert.notEqual(check([own], 'LISTEN 0 511 127.0.0.1:4010').status, 0);
  assert.notEqual(check([{ ...own, cwd: '/home/ubuntu/another-project' }], '').status, 0);
  assert.notEqual(check([own, own], '').status, 0);
  assert.notEqual(check([own], 'LISTEN users:(("node",pid=123,fd=20),("node",pid=999,fd=21))').status, 0);
});

test('发布前SQLite备份包含WAL中的提交且通过完整性检查', (t) => {
  const dir = fixture(t);
  const source = join(dir, 'source.sqlite');
  const destination = join(dir, 'backup.sqlite');
  const code = heredoc(deploy, 'JS_BACKUP');
  const db = new DatabaseSync(source);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE sample(id INTEGER); INSERT INTO sample VALUES(7);');
    assert.ok(readFileSync(`${source}-wal`).length > 32);
    const backup = spawnSync(process.execPath, ['--input-type=module', '-', source, destination], { input: code, encoding: 'utf8' });
    assert.equal(backup.status, 0, backup.stderr);
  } finally { db.close(); }
  const inspect = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import {DatabaseSync} from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1], {readOnly:true});
    if (db.prepare('SELECT id FROM sample').get().id !== 7) process.exit(1);
    db.close();
  `, destination], { encoding: 'utf8' });
  assert.equal(inspect.status, 0, inspect.stderr);
});

test('失败回切保留共享数据，只恢复本项目PM2及previous软链', (t) => {
  const dir = fixture(t);
  const oldRelease = join(dir, 'releases', commit);
  const newRelease = join(dir, 'releases', 'b'.repeat(40));
  mkdirSync(oldRelease, { recursive: true });
  mkdirSync(newRelease, { recursive: true });
  mkdirSync(join(dir, 'shared/data'), { recursive: true });
  writeFileSync(join(dir, 'shared/data/keep.txt'), 'retained');
  symlinkSync(newRelease, join(dir, 'current'));
  const switchCode = deploy.slice(deploy.indexOf('switch_current() {'), deploy.indexOf('\nfinish() {'));
  const finishCode = deploy.slice(deploy.indexOf('finish() {'), deploy.indexOf('\ntrap finish EXIT'));
  const shell = `
APP_ROOT=$1
APP_NAME=zijintaizhang
previous=$2
release=$3
state_file="$APP_ROOT/state"
listeners_file="$APP_ROOT/listeners"
switched=1
touched_pm2=1
pm2() { printf '%s\\n' "$*" >> "$APP_ROOT/pm2-calls"; }
health_matches() { [[ "$1" == "${commit}" ]]; }
# macOS lacks GNU mv -T; os.replace gives the same atomic symlink replacement.
mv() { [[ "$1" == '-Tf' ]] || return 90; python3 -c 'import os,sys;os.replace(sys.argv[1],sys.argv[2])' "$2" "$3"; }
${switchCode}
${finishCode}
false
finish
`;
  const result = spawnSync('bash', ['-c', shell, 'rollback-test', dir, oldRelease, newRelease], { encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(readlinkSync(join(dir, 'current')), oldRelease);
  assert.equal(readFileSync(join(dir, 'shared/data/keep.txt'), 'utf8'), 'retained');
  const calls = readFileSync(join(dir, 'pm2-calls'), 'utf8').trim().split('\n');
  assert.deepEqual(calls, ['delete zijintaizhang', `start ${oldRelease}/ecosystem.config.cjs --only zijintaizhang --update-env`, 'save']);
  assert.equal(existsSync(newRelease), true);
});
