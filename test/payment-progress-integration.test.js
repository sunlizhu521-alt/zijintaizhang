import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { openDatabase } from '../server/db.js';
import { initAdmin } from '../server/auth.js';
import { parseWorkbook } from '../server/parser.js';
import { initializeStorage, createDraft, getDraft, activateDraft, activeData, restoreVersion, listSlots, versionDetails } from '../server/storage.js';

const progressHeaders = ['对公付款OA号', '申请付款金额', '供应商名称', '付款主体', '是否已付款'];
const normalFlow = 'MDST-DGFK20261101001';
const forecasts = [
  { slot: 'shipment', flow: 'MDST-DGFK20261101002', amount: 50, month: '2026-12-01' },
  { slot: 'after_sales', flow: 'MDST-DGFK20261101003', amount: 0, month: null },
  { slot: 'unregistered', flow: 'MDST-DGFK20261101004', amount: 75, month: '2027-01-01' },
];

async function scheduleBuffer(status = '已付款', { missingProgress = false, missingField = false } = {}) {
  const workbook = new ExcelJS.Workbook();
  const negotiated = workbook.addWorksheet('谈判付款');
  negotiated.addRow(['供应商', '付款主体', '摘要', 'OA-申请付款金额', '是否谈判分批', '2026年11月支付', '应付款时间', '已付金额', '剩余付款金额']);
  negotiated.addRow(['合成谈判供应商', '合成主体', '分批付款', 10, '是', 10, '2026-11-01', 0, 10]);
  const normal = workbook.addWorksheet('正常付款');
  normal.addRow(['供应商名称', '付款主体', '摘要', '本次申请付款金额', '应付时间', '对公付款0A流程号', '流程状态', '已付金额', '剩余金额']);
  normal.addRow(['合成正常供应商', '合成主体', '正常付款', 42, '2026-11-01', normalFlow, '已归档', 42, 0]);
  if (!missingProgress) {
    const progress = workbook.addWorksheet('付款进度整理');
    progress.addRow(missingField ? progressHeaders.map(header => header === '是否已付款' ? '其他字段' : header) : progressHeaders);
    progress.addRow([normalFlow, 42, '合成正常供应商', '合成主体', status]);
    for (const item of forecasts) progress.addRow([item.flow, item.amount, `合成预估-${item.slot}`, '合成主体', status]);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function forecastBuffer(item) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('合成人员');
  sheet.addRow(['预估付款月份', '供应商名称', '付款主体', '摘要', '申请付款金额', '账期', '备注']);
  sheet.addRow([item.month, `合成预估-${item.slot}`, '合成主体', '预估', item.amount, '30天', `关联流程 ${item.flow}`]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function fixture(t) {
  const db = openDatabase(':memory:');
  initializeStorage(db);
  t.after(() => db.close());
  const user = await initAdmin(db, { username: 'integration-admin', displayName: '合成管理员', password: 'Synthetic-progress-A1' });
  async function upload(slotId, content, filename) {
    const draft = createDraft(db, { slotId, userId: user.id, content, filename });
    const parsed = await parseWorkbook(content, { slotId });
    const result = activateDraft(db, getDraft(db, draft.token, slotId, user.id), parsed, draft.baseRevision, { actor: user.username });
    return { id: result.version.id, parsed };
  }
  return { db, user, upload };
}

test('当前进度表统一驱动正常付款及三个预估，替换恢复即时生效且不改预估版本', async t => {
  const { db, user, upload } = await fixture(t);
  const paid = await upload('schedule', await scheduleBuffer(), '合成已付.xlsx');
  const forecastVersions = new Map();
  for (const item of forecasts) {
    const result = await upload(item.slot, await forecastBuffer(item), `合成-${item.slot}.xlsx`);
    forecastVersions.set(item.slot, result.id);
  }
  const originalForecasts = db.prepare("SELECT * FROM file_versions WHERE slot_id<>'schedule' ORDER BY id").all();
  assert.equal(paid.parsed.records.length, 2, '进度表不增加业务记录');
  assert.equal(paid.parsed.paymentProgress.rows.length, 4);

  function checkCurrent(expectedStatus, expectedVersion) {
    const data = activeData(db);
    assert.equal(data.records.length, 5);
    for (const record of data.records.filter(record => record.category !== 'negotiated')) {
      for (const plan of record.plans) {
        assert.equal(plan.paidCents, expectedStatus === '已付款' ? plan.amountCents : 0);
        assert.equal(plan.unpaidCents, expectedStatus === '已付款' ? 0 : plan.amountCents);
        assert.equal(plan.paymentProgressVersion.id, expectedVersion);
        assert.ok(plan.paymentEvidence.some(evidence => evidence.sourceSheet === '付款进度整理' && evidence.status === expectedStatus));
      }
    }
    assert.equal(data.records.find(record => record.category === 'negotiated').plans[0].paidCents, 0);
    for (const item of forecasts) assert.equal(listSlots(db).find(slot => slot.id === item.slot).currentVersionId, forecastVersions.get(item.slot));
    assert.deepEqual(db.prepare("SELECT * FROM file_versions WHERE slot_id<>'schedule' ORDER BY id").all(), originalForecasts);
  }
  checkCurrent('已付款', paid.id);

  const unpaid = await upload('schedule', await scheduleBuffer('未付款'), '合成未付.xlsx');
  checkCurrent('未付款', unpaid.id);
  const historicalSchedule = versionDetails(db, 'schedule', paid.id);
  assert.equal(historicalSchedule.progressScope, 'self');
  assert.equal(historicalSchedule.progressSource.id, paid.id);
  assert.equal(historicalSchedule.records.find(record => record.category === 'normal').plans[0].paidCents, 4200);
  const historicalForecast = versionDetails(db, 'shipment', forecastVersions.get('shipment'));
  assert.equal(historicalForecast.progressScope, 'current');
  assert.equal(historicalForecast.progressSource.id, unpaid.id);
  assert.equal(historicalForecast.progressSource.filename, '合成未付.xlsx');
  assert.equal(historicalForecast.records[0].plans[0].paidCents, 0);

  restoreVersion(db, 'schedule', paid.id, listSlots(db).find(slot => slot.id === 'schedule').revision, { actor: user.username });
  checkCurrent('已付款', paid.id);
  assert.equal(versionDetails(db, 'shipment', forecastVersions.get('shipment')).records[0].plans[0].paidCents, 5000);
  assert.equal(versionDetails(db, 'schedule', unpaid.id).records.find(record => record.category === 'normal').plans[0].paidCents, 0,
    '未付历史版本保持自己的依据，不使用恢复后的当前进度');
});

test('新上传缺少进度表或必要字段时拒绝解析，现有版本和审计不被替换', async t => {
  const { db, user, upload } = await fixture(t);
  const current = await upload('schedule', await scheduleBuffer(), '合成有效.xlsx');
  const snapshot = () => ({
    versions: db.prepare('SELECT * FROM file_versions ORDER BY id').all(),
    slots: db.prepare('SELECT * FROM file_slots ORDER BY id').all(),
    logs: db.prepare('SELECT * FROM audit_logs ORDER BY id').all(),
  });
  for (const option of [{ missingProgress: true }, { missingField: true }]) {
    const before = snapshot();
    const content = await scheduleBuffer('未付款', option);
    createDraft(db, { slotId: 'schedule', userId: user.id, content, filename: '合成无效.xlsx' });
    await assert.rejects(parseWorkbook(content, { slotId: 'schedule' }), /付款进度整理|是否已付款/);
    assert.deepEqual(snapshot(), before);
    assert.equal(listSlots(db).find(slot => slot.id === 'schedule').currentVersionId, current.id);
    assert.equal(activeData(db).records.find(record => record.category === 'normal').plans[0].paidCents, 4200);
  }
});

test('历史缺进度表允许解析和恢复，已归档记录仍计未付并说明缺少依据', async t => {
  const { db, user, upload } = await fixture(t);
  const content = await scheduleBuffer('已付款', { missingProgress: true });
  const parsed = await parseWorkbook(content, { slotId: 'schedule', allowLegacyProgress: true });
  assert.equal(parsed.paymentProgress.available, false);
  assert.ok(parsed.issues.some(issue => /付款进度整理/.test(issue.message)));
  const draft = createDraft(db, { slotId: 'schedule', userId: user.id, content, filename: '合成历史缺进度.xlsx' });
  const legacyId = activateDraft(db, getDraft(db, draft.token, 'schedule', user.id), parsed, draft.baseRevision, { actor: user.username }).version.id;
  await upload('schedule', await scheduleBuffer(), '合成有效.xlsx');
  restoreVersion(db, 'schedule', legacyId, listSlots(db).find(slot => slot.id === 'schedule').revision, { actor: user.username });
  const normal = activeData(db).records.find(record => record.category === 'normal');
  assert.equal(normal.status, '已归档');
  assert.equal(normal.plans[0].paidCents, 0);
  assert.equal(normal.plans[0].unpaidCents, 4200);
  assert.match(normal.plans[0].paymentBasis, /付款进度整理|缺少|不可用/);
  assert.equal(versionDetails(db, 'schedule', legacyId).progressSource.id, legacyId);
});
