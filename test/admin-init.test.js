import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('../scripts/admin-init.js', import.meta.url));
const driveTerminal = String.raw`
import json, os, pty, select, sqlite3, subprocess, sys, time

node, script, directory, scenario = sys.argv[1:]
password, different = b'Synthetic-A1', b'Different-B2'
master, slave = pty.openpty()
process = subprocess.Popen([node, script], stdin=slave, stdout=slave, stderr=slave,
    env=dict(os.environ, DATA_DIR=directory, NODE_NO_WARNINGS='1'), close_fds=True)
os.close(slave)
output = bytearray()

def read_available(timeout=0.05):
    if select.select([master], [], [], timeout)[0]:
        try:
            chunk = os.read(master, 65536)
        except OSError:
            return False
        output.extend(chunk)
        return bool(chunk)
    return True

def wait_for(prompt):
    deadline = time.monotonic() + 5
    while prompt.encode() not in output and time.monotonic() < deadline:
        if not read_available(): break
    if prompt.encode() not in output:
        raise RuntimeError('CLI did not reach the expected prompt: ' + prompt)

try:
    wait_for('管理员账号：'); os.write(master, b'synthetic-user\r')
    wait_for('显示姓名：'); os.write(master, '合成测试用户\r'.encode())
    wait_for('管理员密码：')
    expected = '已创建。'
    if scenario == 'cancel':
        os.write(master, b'\x03' + password + b'\r')
        expected = '已取消初始化'
    elif scenario == 'two_lines':
        os.write(master, password + b'\r' + password + b'\r')
        wait_for('再次输入密码：')
        os.write(master, b'\r')
        expected = '两次密码不一致'
    else:
        ending = b'\r\n' if scenario == 'crlf' else b'\r'
        os.write(master, password + ending)
        wait_for('再次输入密码：')
        if scenario == 'delayed_lf':
            time.sleep(0.2)
            os.write(master, b'\n')
            time.sleep(0.1)
            if process.poll() is not None:
                raise RuntimeError('A delayed LF submitted an empty password confirmation')
        if scenario == 'history':
            os.write(master, b'\x1b[A\r')
            expected = '两次密码不一致'
        else:
            os.write(master, (different if scenario == 'mismatch' else password) + ending)
            if scenario == 'mismatch': expected = '两次密码不一致'
    wait_for(expected)
    process.wait(timeout=3)
    while read_available(0):
        if not select.select([master], [], [], 0)[0]: break
    with sqlite3.connect(os.path.join(directory, 'zijintaizhang.sqlite')) as database:
        users = database.execute('SELECT username, display_name, is_admin FROM users').fetchall()
    print(json.dumps(dict(exit=process.returncode, users=users,
        echoed_password=password in output or different in output)))
finally:
    if process.poll() is None:
        process.terminate()
        try: process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill(); process.wait(timeout=3)
    os.close(master)
`;

for (const [scenario, description, success] of [
  ['normal', '逐步输入相同密码成功且不回显', true],
  ['crlf', '同包CRLF输入成功且不回显', true],
  ['delayed_lf', '延迟LF不会被当成空确认', true],
  ['two_lines', '一次粘贴两行不回显密码且不创建错误账号', false],
  ['mismatch', '两次密码不一致时不创建账号', false],
  ['history', '确认处的上箭头不能取回上一条隐藏密码', false],
  ['cancel', '取消后排队的输入不回显且不创建账号', false],
]) {
  test(`管理员初始化终端：${description}`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'zijintaizhang-cli-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const result = spawnSync('python3', ['-c', driveTerminal, process.execPath, script, directory, scenario], {
      encoding: 'utf8', timeout: 12_000, maxBuffer: 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const outcome = JSON.parse(result.stdout);
    assert.equal(outcome.echoed_password, false);
    assert.equal(outcome.exit, success ? 0 : 1);
    assert.deepEqual(outcome.users, success ? [['synthetic-user', '合成测试用户', 1]] : []);
  });
}
