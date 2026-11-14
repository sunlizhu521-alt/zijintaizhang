import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { openDatabase } from '../server/db.js';
import { initAdmin } from '../server/auth.js';
import { initializeStorage, createDraft, getDraft, activateDraft, activeData, restoreVersion, listSlots, listVersions, versionDetails } from '../server/storage.js';
import { refreshParsedVersions } from '../server/refresh-parsed.js';
import { parseWorkbook } from '../server/parser.js';
import { PARSER_VERSION } from '../shared/constants.js';

async function scheduleBuffer() {
  const book = new ExcelJS.Workbook();
  const negotiated = book.addWorksheet('谈判付款');
  negotiated.addRow(['供应商', '付款主体', '摘要', 'OA-申请付款金额', '应付款时间', '已付金额', '剩余付款金额', '2026年11月支付', '是否谈判分批']);
  negotiated.addRow(['合成供应商甲', '合成主体', '分批', 100, '2026-11-01', null, 100, 100, '是']);
  negotiated.addRow(['合成供应商乙', '合成主体', '非分批', 200, '2026-11-01', 0, 200, 200, '否']);
  const normal = book.addWorksheet('正常付款');
  normal.addRow(['供应商', '付款主体', '摘要', '本次申请付款金额', '应付时间', '已付金额', '剩余金额']);
  normal.addRow(['合成供应商丙', '合成主体', '正常', 300, '2026-11-01', 0, 300]);
  return Buffer.from(await book.xlsx.writeBuffer());
}

async function forecastBuffer() {
  const book = new ExcelJS.Workbook();
  for (const name of ['合成人员', '合成人员-原始表']) {
    const sheet = book.addWorksheet(name);
    sheet.addRow(['预估付款月份', '供应商名称', '付款主体', '摘要', '申请付款金额', '账期', '备注']);
    sheet.addRow(['2026-11-01', '合成供应商', '合成主体', '预估', name.endsWith('原始表') ? 99 : null, '30天', '']);
  }
  return Buffer.from(await book.xlsx.writeBuffer());
}

function database(t) {
  const db = openDatabase(':memory:'); initializeStorage(db);
  t.after(() => db.close());
  return db;
}

function seedVersion(db, id, slotId, content, selectedSheets, current = true) {
  const legacyRecords = slotId === 'schedule' ? [{ category: 'negotiated', paidCents: null }, { category: 'negotiated' }, { category: 'normal' }] : [{ category: slotId }];
  db.prepare('INSERT INTO file_versions VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, slotId, `${id}.xlsx`, content,
    JSON.stringify({ records: legacyRecords, issues: [], parserVersion: 1 }), JSON.stringify(selectedSheets),
    '合成上传人', '2026-11-01T00:00:00.000Z', 99, 88);
  if (current) db.prepare('UPDATE file_slots SET current_version_id=?, revision=revision+1, updated_at=?, updated_by=? WHERE id=?')
    .run(id, '2026-11-01T00:00:00.000Z', '合成上传人', slotId);
}

test('启动建立独立解析缓存，原版可回退，新版历史/列表采用新规则且重启幂等', async t => {
  const db = database(t);
  const content = await scheduleBuffer();
  seedVersion(db, 'history', 'schedule', content, ['谈判付款', '正常付款'], false);
  seedVersion(db, 'current', 'schedule', content, ['谈判付款', '正常付款']);
  // An explicitly selected backup sheet must stay selected after reparsing.
  seedVersion(db, 'forecast', 'shipment', await forecastBuffer(), ['合成人员-原始表']);
  const user = await initAdmin(db, { username: 'synthetic-admin', displayName: '合成管理员', password: 'Synthetic-migration-A1' });
  const draft = createDraft(db, { slotId: 'schedule', userId: user.id, filename: '待上传.xlsx', content });
  const before = db.prepare('SELECT * FROM file_versions ORDER BY id').all();
  const slots = db.prepare('SELECT * FROM file_slots ORDER BY id').all();
  const auditCount = () => db.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='更新文件解析规则'").get().n;

  assert.equal(await refreshParsedVersions(db), 3);
  for (const previous of before) {
    const original = db.prepare('SELECT * FROM file_versions WHERE id=?').get(previous.id);
    assert.deepEqual(original, previous);
    assert.ok(JSON.parse(original.parsed_json).records.every(record => record.category !== 'negotiated_normal'));
    const updated = db.prepare('SELECT * FROM file_parse_cache WHERE version_id=?').get(previous.id);
    const parsed = JSON.parse(updated.parsed_json);
    assert.equal(updated.parser_version, PARSER_VERSION);
    assert.equal(parsed.parserVersion, PARSER_VERSION);
    assert.equal(updated.record_count, parsed.records.length);
    assert.equal(updated.issue_count, parsed.issues.length);
    const details = versionDetails(db, previous.slot_id, previous.id);
    assert.equal(details.version.recordCount, parsed.records.length);
    assert.equal(details.version.issueCount, parsed.issues.length);
    assert.deepEqual(details.records.map(record => record.category), parsed.records.map(record => record.category));
    if (previous.slot_id === 'schedule') {
      assert.deepEqual(parsed.records.map(record => record.category), ['negotiated', 'negotiated_normal', 'normal']);
      assert.equal(parsed.records[0].paidCents, 0);
    } else {
      assert.equal(parsed.records.length, 1);
      assert.equal(parsed.records[0].sourceSheet, '合成人员-原始表');
      assert.equal(parsed.records[0].amountCents, 9900);
    }
  }
  assert.equal(listSlots(db).find(slot => slot.id === 'schedule').recordCount, 3);
  assert.equal(listSlots(db).find(slot => slot.id === 'shipment').recordCount, 1);
  assert.ok(listVersions(db, 'schedule').every(version => version.recordCount === 3));
  for (const previous of slots) {
    const updated = db.prepare('SELECT * FROM file_slots WHERE id=?').get(previous.id);
    assert.equal(updated.current_version_id, previous.current_version_id);
    assert.equal(updated.revision, previous.revision + (['schedule', 'shipment'].includes(previous.id) ? 1 : 0));
  }
  assert.equal(auditCount(), 3);
  const after = db.prepare('SELECT * FROM file_slots ORDER BY id').all();
  assert.equal(await refreshParsedVersions(db), 0);
  assert.equal(auditCount(), 3);
  assert.deepEqual(db.prepare('SELECT * FROM file_slots ORDER BY id').all(), after);

  const oldDraft = getDraft(db, draft.token, 'schedule', user.id);
  const parsed = JSON.parse(db.prepare("SELECT parsed_json FROM file_parse_cache WHERE version_id='current'").get().parsed_json);
  assert.throws(() => activateDraft(db, oldDraft, parsed, draft.baseRevision, { actor: user.username }), error => error.status === 409);
  const revision = db.prepare("SELECT revision FROM file_slots WHERE id='schedule'").get().revision;
  restoreVersion(db, 'schedule', 'history', revision, { actor: user.username });
  assert.deepEqual(activeData(db).records.filter(record => record.slotId === 'schedule').map(record => record.category),
    ['negotiated', 'negotiated_normal', 'normal']);
});

test('任一历史文件无法重解析时，所有缓存、槽位和审计保持不变', async t => {
  const db = database(t);
  seedVersion(db, 'good', 'schedule', await scheduleBuffer(), ['谈判付款', '正常付款']);
  seedVersion(db, 'bad-history', 'shipment', Buffer.from('not an xlsx'), ['合成人员'], false);
  const snapshot = () => ({
    versions: db.prepare('SELECT * FROM file_versions ORDER BY id').all(),
    caches: db.prepare('SELECT * FROM file_parse_cache ORDER BY version_id').all(),
    slots: db.prepare('SELECT * FROM file_slots ORDER BY id').all(),
    logs: db.prepare('SELECT * FROM audit_logs ORDER BY id').all(),
  });
  const before = snapshot();
  await assert.rejects(refreshParsedVersions(db), /槽位 shipment，版本 bad-history/);
  assert.deepEqual(snapshot(), before);
});

test('新上传解析版本无需派生缓存，过期派生缓存不会覆盖当前原版结果', async t => {
  const db = database(t);
  const content = await scheduleBuffer();
  const parsed = await parseWorkbook(content, { slotId: 'schedule' });
  seedVersion(db, 'current-parser', 'schedule', content, parsed.selectedSheets);
  db.prepare('UPDATE file_versions SET parsed_json=?,record_count=?,issue_count=? WHERE id=?')
    .run(JSON.stringify(parsed), parsed.records.length, parsed.issues.length, 'current-parser');
  db.prepare('INSERT INTO file_parse_cache VALUES (?,?,?,?,?)')
    .run('current-parser', PARSER_VERSION - 1, JSON.stringify({ records: [], issues: [] }), 999, 999);
  const before = db.prepare('SELECT * FROM file_slots ORDER BY id').all();
  assert.equal(await refreshParsedVersions(db), 0);
  assert.deepEqual(db.prepare('SELECT * FROM file_slots ORDER BY id').all(), before);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_logs').get().n, 0);
  assert.equal(listSlots(db).find(slot => slot.id === 'schedule').recordCount, 3);
  assert.equal(listVersions(db, 'schedule')[0].recordCount, 3);
  assert.equal(versionDetails(db, 'schedule', 'current-parser').records.length, 3);
  assert.equal(activeData(db).records.length, 3);
});
