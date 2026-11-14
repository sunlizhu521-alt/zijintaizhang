import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { openDatabase } from '../server/db.js';
import { initAdmin } from '../server/auth.js';
import { PASSWORD_MESSAGE } from '../shared/password.js';

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('请在交互式 Terminal 中运行 npm run admin:init，密码需要隐藏输入。');
  process.exitCode = 1;
} else {
  let muted = false;
  const output = new Writable({ write(chunk, encoding, callback) {
    if (!muted) process.stdout.write(chunk, encoding);
    callback();
  } });
  output.isTTY = true;
  output.columns = process.stdout.columns;
  const rl = createInterface({ input: process.stdin, output, terminal: true, crlfDelay: Infinity, historySize: 0 });
  const ask = (prompt, hidden = false) => new Promise((resolveAnswer, reject) => {
    muted = hidden;
    if (hidden) process.stdout.write(prompt);
    const interrupted = () => {
      process.stdout.write('\n');
      reject(new Error('已取消初始化'));
    };
    rl.once('SIGINT', interrupted);
    rl.question(hidden ? '' : prompt, (answer) => {
      rl.off('SIGINT', interrupted);
      if (hidden) process.stdout.write('\n');
      resolveAnswer(answer);
    });
  });
  let db;
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const dataDir = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : join(root, 'data');
    db = openDatabase(join(dataDir, 'zijintaizhang.sqlite'));
    if (db.prepare('SELECT id FROM users WHERE is_admin=1 LIMIT 1').get()) throw new Error('管理员已初始化，请在系统内管理账号。');
    console.log(`初始化资金台账管理员。密码不会显示或写入代码；${PASSWORD_MESSAGE}。`);
    const username = await ask('管理员账号：');
    const displayName = await ask('显示姓名：');
    const password = await ask('管理员密码：', true);
    const confirmation = await ask('再次输入密码：', true);
    if (password !== confirmation) throw new Error('两次密码不一致，未创建账号。');
    const user = await initAdmin(db, { username, displayName, password });
    console.log(`管理员 ${user.displayName}（${user.username}）已创建。`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    rl.close();
    muted = false;
    db?.close();
  }
}
