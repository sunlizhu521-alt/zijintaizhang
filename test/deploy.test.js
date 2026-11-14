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
const ownershipCode = heredoc(deploy, 'PY_OWNERSHIP');
const runPython = (code, args = [], input) => spawnSync('python3', ['-c', code, ...args], { input, encoding: 'utf8' });

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
