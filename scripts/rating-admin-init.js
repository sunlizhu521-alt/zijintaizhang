// One-time copy of the explicitly selected administrator. Never synchronizes accounts afterwards.
import { DatabaseSync, backup } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { openDatabase, transaction, audit } from '../server/db.js';
import { initializeRating } from '../server/rating-store.js';
const dataDir = resolve(process.env.DATA_DIR || 'data');
const source = new DatabaseSync(join(dataDir, 'zijintaizhang.sqlite'), { readOnly: true });
let target;
try {
  const sourceUsername = process.argv[2];
  if (!sourceUsername) {
    console.log(JSON.stringify({ candidates: source.prepare("SELECT username,display_name FROM users WHERE active=1 AND is_admin=1 AND (display_name='孙立柱' OR username='孙立柱')").all() }));
  } else {
    const user = source.prepare("SELECT * FROM users WHERE username=? AND active=1 AND is_admin=1 AND (display_name='孙立柱' OR username='孙立柱')").get(sourceUsername);
    if (!user) throw new Error('未找到明确匹配孙立柱的启用管理员，未初始化');
    target = openDatabase(join(dataDir, 'gongyingshangpingji.sqlite')); initializeRating(target);
    transaction(target, () => {
      if (target.prepare('SELECT id FROM users LIMIT 1').get()) throw new Error('评级系统已有用户，不能重复初始化');
      const stamp = new Date().toISOString(), id = randomUUID();
      target.prepare('INSERT INTO users(id,username,display_name,password_hash,is_admin,permissions_json,must_change_password,created_at,updated_at) VALUES(?,?,?,?,1,?,?,?,?)').run(id, user.username, user.display_name, user.password_hash, '[]', user.must_change_password, stamp, stamp);
      audit(target, { kind: 'operation', actor: { id, username: user.username }, action: '一次性初始化评级管理员', outcome: 'success' });
    });
    const dir = resolve(dataDir, '../backups'); mkdirSync(dir, { recursive: true });
    await backup(target, join(dir, `rating-initial-${Date.now()}.sqlite`));
    console.log('供应商评级管理员已初始化并备份：孙立柱。');
  }
} finally { target?.close(); source.close(); }
