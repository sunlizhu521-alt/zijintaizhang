import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { openDatabase } from '../server/db.js';
import { initAdmin } from '../server/auth.js';
import { initializeStorage, createDraft, getDraft, activateDraft, activeData, restoreVersion, listSlots, listVersions, versionDetails } from '../server/storage.js';
import { refreshParsedVersions } from '../server/refresh-parsed.js';
import { parseWorkbook } from '../server/parser.js';
import { PARSER_VERSION } from '../shared/constants.js';

async function scheduleBuffer({ progress = false } = {}) {
  const book = new ExcelJS.Workbook();
  const negotiated = book.addWorksheet('谈判付款');
  negotiated.addRow(['供应商', '付款主体', '摘要', 'OA-申请付款金额', '应付款时间', '已付金额', '剩余付款金额', '2026年11月支付', '是否谈判分批']);
  negotiated.addRow(['合成供应商甲', '合成主体', '分批', 100, '2026-11-01', null, 100, 100, '是']);
  negotiated.addRow(['合成供应商乙', '合成主体', '非分批', 200, '2026-11-01', 0, 200, 200, '否']);
  const normal = book.addWorksheet('正常付款');
  normal.addRow(['供应商', '付款主体', '摘要', '本次申请付款金额', '应付时间', '已付金额', '剩余金额']);
  normal.addRow(['合成供应商丙', '合成主体', '正常', 300, '2026-11-01', 0, 300]);
  if (progress) book.addWorksheet('付款进度整理').addRow(['对公付款OA号', '申请付款金额', '供应商名称', '付款主体', '是否已付款']);
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

function seedVersion(db, id, slotId, content, selectedSheets, current = true, parserVersion = 1) {
  const legacyRecords = slotId === 'schedule' ? [{ category: 'negotiated', paidCents: parserVersion === 1 ? null : 0 },
    { category: parserVersion === 1 ? 'negotiated' : 'negotiated_normal' }, { category: 'normal' }] : [{ category: slotId }];
  db.prepare('INSERT INTO file_versions VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, slotId, `${id}.xlsx`, content,
    JSON.stringify({ records: legacyRecords, issues: [], parserVersion }), JSON.stringify(selectedSheets),
    '合成上传人', '2026-11-01T00:00:00.000Z', 99, 88);
  if (current) db.prepare('UPDATE file_slots SET current_version_id=?, revision=revision+1, updated_at=?, updated_by=? WHERE id=?')
    .run(id, '2026-11-01T00:00:00.000Z', '合成上传人', slotId);
}

test('第6版当前及历史缓存升级后补齐申请别名和节点，不改变原文件及金额', async t => {
  const db = database(t);
  const schedule = new ExcelJS.Workbook();
  await schedule.xlsx.load(await scheduleBuffer());
  const normal = schedule.getWorksheet('正常付款');
  normal.getCell('H1').value = '是否已申请';
  normal.getCell('H2').value = '是';
  normal.getCell('I1').value = '当前节点';
  normal.getCell('I2').value = '付款审批';
  const forecast = new ExcelJS.Workbook();
  await forecast.xlsx.load(await forecastBuffer());
  const sheet = forecast.getWorksheet('合成人员');
  sheet.getCell('H1').value = '是否申请';
  sheet.getCell('H2').value = '已提交';
  sheet.getCell('I1').value = '当前节点';
  sheet.getCell('I2').value = '财务核对';
  seedVersion(db, 'current-fields', 'schedule', Buffer.from(await schedule.xlsx.writeBuffer()), ['谈判付款', '正常付款'], true, 6);
  seedVersion(db, 'history-fields', 'shipment', Buffer.from(await forecast.xlsx.writeBuffer()), ['合成人员'], false, 6);
  const originals = db.prepare('SELECT * FROM file_versions ORDER BY id').all();
  assert.equal(await refreshParsedVersions(db), 2);
  assert.deepEqual(db.prepare('SELECT * FROM file_versions ORDER BY id').all(), originals);
  const active = activeData(db).records.find(record => record.category === 'normal');
  assert.equal(active.applicationStatus, '是');
  assert.equal(active.currentNode, '付款审批');
  assert.equal(active.amountCents, 30000);
  const history = versionDetails(db, 'shipment', 'history-fields').records[0];
  assert.equal(history.applicationStatus, '已提交');
  assert.equal(history.currentNode, '财务核对');
  assert.equal(history.amountCents, 0);
  assert.equal(await refreshParsedVersions(db), 0);
});

test('旧原版与派生缓存升级到当前规则，历史缺进度表仍可恢复且保留原文件、审计及并发控制', async t => {
  const db = database(t);
  const content = await scheduleBuffer();
  seedVersion(db, 'history', 'schedule', content, ['谈判付款', '正常付款'], false);
  seedVersion(db, 'current', 'schedule', content, ['谈判付款', '正常付款'], true, 2);
  const previousCache = db.prepare("SELECT parsed_json FROM file_versions WHERE id='current'").get().parsed_json;
  db.prepare('INSERT INTO file_parse_cache VALUES (?,?,?,?,?)').run('history', 2, previousCache, 3, 0);
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
    if (JSON.parse(original.parsed_json).parserVersion === 1) {
      assert.ok(JSON.parse(original.parsed_json).records.every(record => record.category !== 'negotiated_normal'));
    }
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
      assert.equal(parsed.paymentProgress.available, false);
      assert.ok(parsed.issues.some(issue => /付款进度整理/.test(issue.message)));
    } else {
      assert.equal(parsed.records.length, 1);
      assert.equal(parsed.records[0].sourceSheet, '合成人员-原始表');
      assert.equal(parsed.records[0].amountCents, 9900);
    }
  }
  assert.notEqual(db.prepare("SELECT parsed_json FROM file_parse_cache WHERE version_id='history'").get().parsed_json, previousCache);
  assert.equal(listSlots(db).find(slot => slot.id === 'schedule').recordCount, 3);
  assert.equal(listSlots(db).find(slot => slot.id === 'shipment').recordCount, 1);
  assert.ok(listVersions(db, 'schedule').every(version => version.recordCount === 3));
  for (const previous of slots) {
    const updated = db.prepare('SELECT * FROM file_slots WHERE id=?').get(previous.id);
    assert.equal(updated.current_version_id, previous.current_version_id);
    assert.equal(updated.revision, previous.revision + (['schedule', 'shipment'].includes(previous.id) ? 1 : 0));
  }
  assert.equal(auditCount(), 3);
  const auditVersions = db.prepare("SELECT target,details_json FROM audit_logs WHERE action='更新文件解析规则'").all()
    .map(log => ({ target: log.target, ...JSON.parse(log.details_json) }));
  for (const log of auditVersions) {
    assert.equal(log.previousParserVersion, log.target === 'forecast' ? 1 : 2);
    assert.equal(log.parserVersion, PARSER_VERSION);
  }
  const after = db.prepare('SELECT * FROM file_slots ORDER BY id').all();
  assert.equal(await refreshParsedVersions(db), 0);
  assert.equal(auditCount(), 3);
  assert.deepEqual(db.prepare('SELECT * FROM file_slots ORDER BY id').all(), after);

  const oldDraft = getDraft(db, draft.token, 'schedule', user.id);
  const parsed = JSON.parse(db.prepare("SELECT parsed_json FROM file_parse_cache WHERE version_id='current'").get().parsed_json);
  assert.throws(() => activateDraft(db, oldDraft, parsed, draft.baseRevision, { actor: user.username }), error => error.status === 409);
  assert.throws(() => restoreVersion(db, 'schedule', 'history', draft.baseRevision, { actor: user.username }), error => error.status === 409);
  const revision = db.prepare("SELECT revision FROM file_slots WHERE id='schedule'").get().revision;
  restoreVersion(db, 'schedule', 'history', revision, { actor: user.username });
  assert.deepEqual(activeData(db).records.filter(record => record.slotId === 'schedule').map(record => record.category),
    ['negotiated', 'negotiated_normal', 'normal']);
  assert.deepEqual(activeData(db).records.filter(record => record.slotId === 'schedule').map(record => record.plans),
    versionDetails(db, 'schedule', 'history').records.map(record => record.plans));
  assert.deepEqual(activeData(db).records.filter(record => record.slotId === 'schedule')
    .flatMap(record => record.plans.map(({ month, amountCents, paidCents, unpaidCents }) => ({ month, amountCents, paidCents, unpaidCents }))), [
    { month: '2026-11', amountCents: 10000, paidCents: 0, unpaidCents: 10000 },
    { month: '2026-11', amountCents: 20000, paidCents: 0, unpaidCents: 20000 },
    { month: '2026-11', amountCents: 30000, paidCents: 0, unpaidCents: 30000 },
  ]);
  assert.deepEqual(db.prepare('SELECT * FROM file_versions ORDER BY id').all(), before);
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
  const content = await scheduleBuffer({ progress: true });
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

test('v4缓存升级后付款时间批注生效，两类谈判均更新且原文件与计划金额不变', async t => {
  const db = database(t);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(await scheduleBuffer());
  const sheet = book.getWorksheet('谈判付款');
  sheet.getCell('J1').value = '2026年11月2日';
  sheet.getCell('J2').value = 40;
  sheet.getCell('J2').note = '付款时间（付款节奏跟进）：2026年12月2日';
  sheet.getCell('H2').note = '申请日期（付款节奏跟进）：2026年11月2日';
  sheet.getCell('H3').note = '付款时间（付款节奏跟进）：2026年11月2日';
  const content = Buffer.from(await book.xlsx.writeBuffer());
  const legacy = await parseWorkbook(content, { slotId: 'schedule', allowLegacyProgress: true });
  legacy.parserVersion = 4;
  for (const record of legacy.records) for (const plan of record.plans) {
    plan.paidCents = 0;
    plan.unpaidCents = plan.amountCents;
    plan.paymentDates = [];
    plan.paymentBasis = '旧规则未识别付款时间批注。';
    plan.paymentEvidence = [];
  }
  seedVersion(db, 'payment-time', 'schedule', content, ['谈判付款', '正常付款'], true, 3);
  db.prepare('INSERT INTO file_parse_cache VALUES (?,?,?,?,?)')
    .run('payment-time', 4, JSON.stringify(legacy), legacy.records.length, legacy.issues.length);
  const original = db.prepare("SELECT * FROM file_versions WHERE id='payment-time'").get();
  const plansBefore = legacy.records.flatMap(record => record.plans.map(({ month, amountCents }) => ({ month, amountCents })));

  assert.equal(await refreshParsedVersions(db), 1);
  const cache = db.prepare("SELECT * FROM file_parse_cache WHERE version_id='payment-time'").get();
  assert.equal(cache.parser_version, PARSER_VERSION);
  const liveRecords = activeData(db).records;
  assert.deepEqual(liveRecords.flatMap(record => record.plans.map(({ month, amountCents }) => ({ month, amountCents }))), plansBefore);
  assert.deepEqual(liveRecords.map(record => [record.category, record.plans[0].paidCents, record.plans[0].unpaidCents]), [
    ['negotiated', 4000, 6000], ['negotiated_normal', 20000, 0], ['normal', 0, 30000],
  ]);
  assert.deepEqual(liveRecords[0].plans[0].paymentDates, ['2026-12-02']);
  assert.deepEqual(liveRecords[1].plans[0].paymentDates, ['2026-11-02']);
  assert.deepEqual(versionDetails(db, 'schedule', 'payment-time').records.map(record => record.plans), liveRecords.map(record => record.plans));
  assert.deepEqual(db.prepare("SELECT * FROM file_versions WHERE id='payment-time'").get(), original);
  assert.equal(await refreshParsedVersions(db), 0);
});

test('四个资金槽位均刷新，独立采购订单原文件、缓存、槽位与日志保持不变', async t => {
  const db = database(t);
  seedVersion(db, 'schedule-old', 'schedule', await scheduleBuffer(), ['谈判付款', '正常付款'], true, 3);
  const content = await forecastBuffer();
  for (const slot of ['shipment', 'after_sales', 'unregistered']) {
    seedVersion(db, `${slot}-old`, slot, content, ['合成人员'], true, 3);
  }
  // An unrelated archive is deliberately not a financial workbook and must never be reparsed here.
  seedVersion(db, 'orders-old', 'kingdee_orders', Buffer.from('independent order archive'), ['采购订单'], true, 3);
  const originalArchive = db.prepare("SELECT * FROM file_versions WHERE id='orders-old'").get();
  const orderSlot = db.prepare("SELECT * FROM file_slots WHERE id='kingdee_orders'").get();
  db.prepare('INSERT INTO file_parse_cache VALUES (?,?,?,?,?)')
    .run('orders-old', 3, JSON.stringify({ parserVersion: 3, kind: 'archive', records: [], issues: [] }), 0, 0);
  const orderCache = db.prepare("SELECT * FROM file_parse_cache WHERE version_id='orders-old'").get();

  assert.equal(await refreshParsedVersions(db), 4);
  for (const slot of ['schedule', 'shipment', 'after_sales', 'unregistered']) {
    const cache = db.prepare('SELECT parser_version FROM file_parse_cache WHERE version_id=?').get(`${slot}-old`);
    assert.equal(cache.parser_version, PARSER_VERSION);
  }
  assert.deepEqual(db.prepare("SELECT * FROM file_versions WHERE id='orders-old'").get(), originalArchive);
  assert.deepEqual(db.prepare("SELECT * FROM file_slots WHERE id='kingdee_orders'").get(), orderSlot);
  assert.deepEqual(db.prepare("SELECT * FROM file_parse_cache WHERE version_id='orders-old'").get(), orderCache);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE target='orders-old' OR target='kingdee_orders'").get().n, 0);
  assert.equal(await refreshParsedVersions(db), 0);
});

test('v5历史缓存按预估时间重分正常付款，原文件不变且分类和付款状态可追溯', async t => {
  const db = database(t);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(await scheduleBuffer({ progress: true }));
  const sheet = book.getWorksheet('正常付款');
  sheet.getCell('H1').value = '预估时间';
  sheet.getCell('H2').value = '2027年1月2日';
  sheet.getCell('E2').value = null;
  sheet.addRow(['另一合成供应商', '合成主体', '已对账', 50, '2026-12-01', 0, 50, null]);
  const content = Buffer.from(await book.xlsx.writeBuffer());
  const old = await parseWorkbook(content, { slotId: 'schedule' });
  old.parserVersion = 5;
  for (const record of old.records) if (record.category === 'normal_unreconciled') {
    record.category = 'normal';
    record.dueDate = null;
    for (const plan of record.plans) plan.month = null;
  }
  seedVersion(db, 'reconciliation', 'schedule', content, old.selectedSheets, true, 4);
  db.prepare('INSERT INTO file_parse_cache VALUES (?,?,?,?,?)')
    .run('reconciliation', 5, JSON.stringify(old), old.records.length, old.issues.length);
  const original = db.prepare("SELECT * FROM file_versions WHERE id='reconciliation'").get();
  const originalPlans = old.records.map(record => record.plans);

  assert.equal(await refreshParsedVersions(db), 1);
  assert.equal(db.prepare("SELECT parser_version FROM file_parse_cache WHERE version_id='reconciliation'").get().parser_version, PARSER_VERSION);
  const current = activeData(db).records;
  assert.deepEqual(current.map(record => record.category), ['negotiated', 'negotiated_normal', 'normal_unreconciled', 'normal']);
  assert.equal(originalPlans[2][0].month, null);
  assert.equal(current[2].plans[0].month, '2027-01');
  assert.equal(current[3].plans[0].month, '2026-12');
  assert.deepEqual(current.map(record => record.plans.map(({ amountCents, paidCents, unpaidCents }) => ({ amountCents, paidCents, unpaidCents }))),
    originalPlans.map(plans => plans.map(({ amountCents, paidCents, unpaidCents }) => ({ amountCents, paidCents, unpaidCents }))));
  assert.deepEqual(versionDetails(db, 'schedule', 'reconciliation').records.map(record => record.category), current.map(record => record.category));
  assert.deepEqual(db.prepare("SELECT * FROM file_versions WHERE id='reconciliation'").get(), original);
  assert.equal(await refreshParsedVersions(db), 0);
});
