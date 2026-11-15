import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { appFixture, syntheticSchedule, syntheticForecast, ADMIN_PASSWORD } from './helpers.js';

function valueByHeader(sheet, row, header) {
  const column = sheet.getRow(1).values.indexOf(header);
  assert.ok(column > 0, `导出缺少列：${header}`);
  return sheet.getRow(row).getCell(column).value;
}

test('分期批注经上传持久化、父子汇总及导出后已付未付一致，预估只加一次', async t => {
  const f = await appFixture(t);
  const admin = await f.login();
  const source = new ExcelJS.Workbook(); await source.xlsx.load(await syntheticSchedule());
  const sheet = source.getWorksheet('谈判付款');
  sheet.getCell('P1').value = '2026年11月2日';
  sheet.getCell('P2').value = 150;
  sheet.getCell('P2').note = '11月5日核实-已支付';
  await f.upload('schedule', Buffer.from(await source.xlsx.writeBuffer()), admin);
  for (const [slot, cents] of [['shipment', 10], ['after_sales', 20], ['unregistered', 30]]) {
    await f.upload(slot, await syntheticForecast(cents), admin);
  }
  const query = '?from=2026-11&to=2026-11';
  const dashboard = (await f.request(`/dashboard${query}`, { session: admin })).data;
  const total = dashboard.paymentTable.rows.find(row => row.id === 'total');
  assert.deepEqual(total.cells['2026-11'], { paidCents: 35000, unpaidCents: 51000, totalCents: 86000, uncertainCount: 0 });
  const negotiated = dashboard.records.find(row => row.category === 'negotiated');
  assert.equal(negotiated.selectedPaidCents, 15000);
  assert.equal(negotiated.selectedUnpaidCents, 45000);
  assert.equal(negotiated.selectedPlans[0].paymentEvidence[0].sourceCell, 'P2');
  const exported = await f.request(`/dashboard/export${query}`, { session: admin });
  assert.equal(exported.status, 200);
  const book = new ExcelJS.Workbook(); await book.xlsx.load(exported.bytes);
  const monthly = book.getWorksheet('月度付款汇总');
  assert.equal(valueByHeader(monthly, 11, '2026-11已付（元）'), 350);
  assert.equal(valueByHeader(monthly, 11, '2026-11未付（元）'), 510);
  assert.equal(valueByHeader(monthly, 11, '所选期间合计（元）'), 860);
  const details = book.getWorksheet('筛选明细');
  assert.equal(valueByHeader(details, 2, '选定范围已付（新规则）'), 150);
  assert.match(valueByHeader(details, 2, '付款判定依据'), /P2.*150元.*11月5日核实-已支付/s);
});

test('完整 API 挂载的认证、CSRF、Origin 与 JSON 拒绝均在产生副作用前生效并记录', async t => {
  const f = await appFixture(t);
  assert.equal((await f.request('/health')).status, 200);
  assert.equal((await f.request('/auth/status')).data.initialized, true);
  assert.equal((await f.request('/dashboard')).status, 401);
  for (const path of ['/.env', '/.git/config', '/wp-admin/', '/index.php']) {
    assert.equal((await f.request(path)).status, 404, `匿名异常路径 ${path}`);
  }
  const admin = await f.login();
  assert.equal(admin.status, 200);
  assert.match(admin.headers.get('set-cookie'), /HttpOnly/);
  assert.match(admin.headers.get('set-cookie'), /SameSite=Strict/);
  assert.equal((await f.request('/auth/session', { session: admin })).data.user.username, 'admin');
  const noCsrf = await f.request('/files/shipment/restore', { method: 'POST', session: admin, csrf: false, body: { versionId: 'none', baseRevision: 0 } });
  assert.equal(noCsrf.status, 403);
  const originRejected = await f.request('/auth/login', { method: 'POST', body: { username: 'admin', password: ADMIN_PASSWORD }, headers: { Origin: 'https://unrelated.invalid' } });
  assert.equal(originRejected.status, 403);
  const crossSite = await f.request('/auth/login', { method: 'POST', body: { username: 'admin', password: ADMIN_PASSWORD }, headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(crossSite.status, 403);
  const malformed = await f.request('/files/shipment/activate', { method: 'POST', session: admin, rawBody: '{"token":',
    headers: { 'X-Forwarded-For': '203.0.113.99' } });
  assert.equal(malformed.status, 400);
  for (const path of ['/files/shipment/activate', '/files/shipment/restore']) {
    assert.equal((await f.request(path, { method: 'POST', session: admin })).status, 400, `空请求体 ${path}`);
  }
  assert.equal((await f.request('/files/shipment/activate', { method: 'POST', session: admin, body: [] })).status, 400);
  const logs = await f.request('/logs?kind=security', { session: admin });
  assert.equal(logs.status, 200);
  assert.ok(logs.data.items.some(log => log.action === '请求校验失败' && log.status === 403));
  assert.equal(logs.data.items.filter(log => log.action === '跨站请求已拦截').length, 2);
  assert.ok(logs.data.items.some(log => log.status === 400));
  assert.ok(logs.data.items.filter(log => log.status === 400).every(log => log.ip === '127.0.0.1'));
  const scans = logs.data.items.filter(log => log.action === '疑似路径探测');
  assert.equal(scans.length, 4);
  assert.ok(scans.every(log => log.status === 404 && log.actorName === '' && log.outcome === 'blocked'));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM file_versions').get().n, 0);
  assert.ok(!JSON.stringify(f.db.prepare('SELECT * FROM audit_logs').all()).includes(ADMIN_PASSWORD));
});

test('四个槽位支持中文文件名、分表校验及独立激活，坏文件不替换旧数据', async t => {
  const f = await appFixture(t);
  const admin = await f.login();
  const scheduleBytes = await syntheticSchedule();
  const initial = await f.request('/files', { session: admin });
  assert.equal(initial.data.slots.length, 4);
  assert.ok(initial.data.slots.every(slot => slot.currentVersionId === null));
  const schedule = await f.upload('schedule', scheduleBytes, admin, '付款节奏合成_V1.xlsx');
  assert.equal(schedule.draft.data.filename, '付款节奏合成_V1.xlsx');
  assert.deepEqual(schedule.draft.data.categoryCounts, { negotiated: 1, normal: 2 });
  assert.equal(schedule.activated.data.slot.revision, 1);
  for (const [slotId, amount] of [['shipment', 10], ['after_sales', 20], ['unregistered', 30]]) {
    const result = await f.upload(slotId, await syntheticForecast(amount), admin, `${slotId}_预估.xlsx`);
    assert.equal(result.activated.data.slot.recordCount, 1);
    assert.deepEqual(result.draft.data.selectedSheets, ['合成人员']);
  }
  const before = (await f.request('/files', { session: admin })).data.slots;
  const badDraft = await f.preview('shipment', await syntheticForecast(50, { invalid: true }), admin, '金额无效.xlsx');
  assert.equal(badDraft.status, 200);
  assert.ok(badDraft.data.validationError);
  const badActivation = await f.activate('shipment', badDraft, admin);
  assert.equal(badActivation.status, 422);
  assert.ok(badActivation.data.issues.some(issue => issue.sourceRow === 2));
  assert.equal((await f.preview('shipment', Buffer.from('not-an-xlsx'), admin)).status, 422);
  assert.equal((await f.preview('shipment', scheduleBytes, admin, '错误扩展名.xls')).status, 422);
  const after = (await f.request('/files', { session: admin })).data.slots;
  assert.deepEqual(after, before);
  const data = await f.request('/dashboard?from=2026-11&to=2026-11', { session: admin });
  assert.equal(data.status, 200);
  assert.equal(data.data.summary.planCents, 80000);
  assert.equal(data.data.summary.paidCents, 45000);
  assert.equal(data.data.summary.remainingCents, 105000);
  assert.equal(data.data.summary.missingPaidCount, 0);
  assert.deepEqual(data.data.summary.forecastCents, { shipment: 1000, after_sales: 2000, unregistered: 3000 });
  assert.equal(data.data.summary.missingSourceCount, 0);
});

test('新三类付款和空金额通过预览激活、筛选及导出，重新打开后仍按零保存', async t => {
  const f = await appFixture(t);
  const admin = await f.login();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await syntheticSchedule());
  const negotiated = workbook.getWorksheet('谈判付款');
  negotiated.addRow(['丙', '合成非分批供应商', '合成主体', 'MDST-DGFK20261101004', '非分批款', 500, '2027-01-01', null, 500, '否', '未归档', 150, 350, '', '否']);
  const schedule = await f.upload('schedule', Buffer.from(await workbook.xlsx.writeBuffer()), admin);
  assert.deepEqual(schedule.draft.data.categoryCounts, { negotiated: 1, negotiated_normal: 1, normal: 2 });
  for (const [slotId, amount] of [['shipment', null], ['after_sales', { formula: '10+20' }], ['unregistered', 0]]) {
    const result = await f.upload(slotId, await syntheticForecast(amount), admin);
    assert.equal(result.activated.data.slot.recordCount, 1);
  }
  const response = await f.request('/dashboard?from=2026-11&to=2026-11', { session: admin });
  assert.equal(response.status, 200);
  assert.equal(response.data.summary.planCents, 95000);
  assert.equal(response.data.summary.ledgerRecordCount, 4);
  assert.deepEqual(response.data.summary.forecastCents, { shipment: 0, after_sales: 0, unregistered: 0 });
  const filtered = await f.request('/dashboard?category=negotiated_normal&month=2026-11', { session: admin });
  assert.equal(filtered.status, 200);
  assert.equal(filtered.data.records.length, 1);
  assert.equal(filtered.data.records[0].sourceSheet, '谈判付款');
  assert.equal(filtered.data.records[0].sourceRow, 3);
  assert.equal(filtered.data.records[0].selectedPlanCents, 15000);
  assert.equal(filtered.data.records[0].paidCents, 0);
  const exported = await f.request('/dashboard/export?from=2026-11&to=2026-11', { session: admin });
  assert.equal(exported.status, 200);
  const output = new ExcelJS.Workbook(); await output.xlsx.load(exported.bytes);
  const monthly = output.getWorksheet('月度付款汇总');
  assert.equal(valueByHeader(monthly, 3, '2026-11合计（元）'), 600);
  assert.equal(valueByHeader(monthly, 5, '2026-11合计（元）'), 150);
  assert.equal(valueByHeader(monthly, 6, '2026-11合计（元）'), 200);
  assert.equal(valueByHeader(monthly, 4, '2026-11合计（元）'), 350);
  assert.equal(valueByHeader(monthly, 11, '2026-11合计（元）'), 950);
  const details = output.getWorksheet('筛选明细');
  assert.deepEqual(details.getRows(2, 3).map(row => row.getCell(1).value), ['谈判表-谈判付款', '谈判表-正常付款', '正常付款']);
  assert.equal(valueByHeader(details, 3, '原台账累计已付'), 0);
  await f.restart();
  const after = (await f.request('/dashboard?category=negotiated_normal&month=2026-11', { session: admin })).data;
  assert.deepEqual(after.records, filtered.data.records);
});

test('历史查看、原文件下载和恢复可追溯，跨槽位版本及重复激活被拒绝', async t => {
  const f = await appFixture(t);
  const admin = await f.login();
  const v1Bytes = await syntheticForecast(50);
  const v1 = await f.upload('shipment', v1Bytes, admin, '发货计划_V1.xlsx');
  const other = await f.upload('after_sales', await syntheticForecast(20), admin, '售后配件.xlsx');
  const v2 = await f.upload('shipment', await syntheticForecast(70), admin, '发货计划_V2.xlsx');
  const histories = await f.request('/files/shipment/versions', { session: admin });
  assert.equal(histories.status, 200);
  assert.equal(histories.data.versions.length, 2);
  assert.equal(histories.data.versions[0].id, v2.versionId);
  assert.equal(histories.data.versions[0].current, true);
  const details = await f.request(`/files/shipment/versions/${v1.versionId}`, { session: admin });
  assert.equal(details.status, 200);
  assert.equal(details.data.records[0].amountCents, 5000);
  assert.equal(details.data.version.filename, '发货计划_V1.xlsx');
  assert.equal(details.data.content, undefined);
  const downloaded = await f.request(`/files/shipment/versions/${v1.versionId}/download`, { session: admin });
  assert.equal(downloaded.status, 200);
  assert.deepEqual(downloaded.bytes, v1Bytes);
  assert.ok(downloaded.headers.get('content-disposition').includes(encodeURIComponent('发货计划_V1.xlsx')));
  for (const suffix of ['', '/download']) {
    assert.equal((await f.request(`/files/after_sales/versions/${v1.versionId}${suffix}`, { session: admin })).status, 404);
  }
  assert.equal((await f.request('/files/after_sales/restore', { method: 'POST', session: admin,
    body: { versionId: v1.versionId, baseRevision: 1 } })).status, 404);
  assert.equal((await f.activate('shipment', v2.draft, admin)).status, 409);
  const restored = await f.request('/files/shipment/restore', { method: 'POST', session: admin,
    body: { versionId: v1.versionId, baseRevision: 2 } });
  assert.equal(restored.status, 200);
  assert.equal(restored.data.slot.currentVersionId, v1.versionId);
  assert.equal(restored.data.slot.revision, 3);
  const slots = (await f.request('/files', { session: admin })).data.slots;
  assert.equal(slots.find(slot => slot.id === 'after_sales').currentVersionId, other.versionId);
  assert.equal(slots.find(slot => slot.id === 'after_sales').revision, 1);
  assert.equal((await f.request('/files/shipment/restore', { method: 'POST', session: admin,
    body: { versionId: v2.versionId, baseRevision: 2 } })).status, 409);
  const logs = (await f.request('/logs?kind=operation', { session: admin })).data.items;
  const restore = logs.find(log => log.action === '恢复历史版本');
  assert.equal(restore.actorName, 'admin');
  assert.equal(restore.details.previousVersionId, v2.versionId);
  assert.equal(restore.details.versionId, v1.versionId);
});

test('两个用户并发上传以版本校验防止覆盖，草稿不可跨用户使用', async t => {
  const f = await appFixture(t);
  const admin = await f.login();
  const { session: worker } = await f.newUser(admin, 'uploader', ['files', 'upload']);
  await f.upload('shipment', await syntheticForecast(10), admin, '初始.xlsx');
  const adminDraft = await f.preview('shipment', await syntheticForecast(20), admin, '管理员草稿.xlsx');
  const workerDraft = await f.preview('shipment', await syntheticForecast(30), worker, '上传者草稿.xlsx');
  assert.equal(adminDraft.data.baseRevision, 1);
  assert.equal(workerDraft.data.baseRevision, 1);
  assert.equal((await f.activate('shipment', adminDraft, worker)).status, 409);
  const competing = await Promise.all([f.activate('shipment', workerDraft, worker), f.activate('shipment', adminDraft, admin)]);
  assert.equal(competing.filter(result => result.status === 200).length, 1);
  assert.ok([409, 429].includes(competing.find(result => result.status !== 200).status));
  const winner = competing.find(result => result.status === 200);
  const workerWon = competing[0].status === 200;
  const staleDraft = workerWon ? adminDraft : workerDraft;
  const staleSession = workerWon ? admin : worker;
  assert.equal((await f.activate('shipment', staleDraft, staleSession)).status, 409);
  assert.equal((await f.activate('shipment', staleDraft, staleSession, { baseRevision: 2 })).status, 409);
  const versions = (await f.request('/files/shipment/versions', { session: admin })).data.versions;
  assert.equal(versions.length, 2);
  assert.equal(versions[0].id, winner.data.version.id);
  assert.equal(versions[0].uploadedBy, workerWon ? 'uploader' : 'admin');
});

test('过期草稿、无效选表及非整数版本号不改变当前有效文件', async t => {
  const f = await appFixture(t);
  const admin = await f.login();
  const uploaded = await f.upload('shipment', await syntheticForecast(10), admin);
  const draft = await f.preview('shipment', await syntheticForecast(20), admin);
  assert.equal((await f.activate('shipment', draft, admin, { selectedSheets: [] })).status, 422);
  assert.equal((await f.activate('shipment', draft, admin, { selectedSheets: ['不存在'] })).status, 422);
  assert.equal((await f.activate('shipment', draft, admin, { baseRevision: '1' })).status, 409);
  f.db.prepare('UPDATE upload_drafts SET created_at=? WHERE token=?')
    .run(new Date(Date.now() - 7200000).toISOString(), draft.data.token);
  assert.equal((await f.activate('shipment', draft, admin)).status, 409);
  const versions = (await f.request('/files/shipment/versions', { session: admin })).data.versions;
  assert.equal(versions.length, 1);
  assert.equal(versions[0].id, uploaded.versionId);
  assert.equal(versions[0].current, true);
});

test('重启后原文件、解析快照、版本和操作记录仍存在，旧会话可按有效期使用', async t => {
  const f = await appFixture(t);
  const admin = await f.login();
  const bytes = await syntheticSchedule();
  const uploaded = await f.upload('schedule', bytes, admin, '持久化验收.xlsx');
  const before = (await f.request('/dashboard', { session: admin })).data;
  await f.restart();
  const session = await f.request('/auth/session', { session: admin });
  assert.equal(session.status, 200);
  const after = (await f.request('/dashboard', { session: admin })).data;
  assert.deepEqual(after.summary, before.summary);
  assert.deepEqual(after.records, before.records);
  assert.deepEqual(after.slots, before.slots);
  assert.deepEqual((await f.request(`/files/schedule/versions/${uploaded.versionId}/download`, { session: admin })).bytes, bytes);
  const logs = (await f.request('/logs?kind=operation', { session: admin })).data.items;
  assert.ok(logs.some(log => log.action === '上传并替换文件' && log.details.versionId === uploaded.versionId));
});

test('文件查看、下载、导出和恢复分别服务端授权，GET 越权进入安全日志', async t => {
  const f = await appFixture(t);
  const admin = await f.login();
  const uploaded = await f.upload('schedule', await syntheticSchedule(), admin);
  const { session: viewer } = await f.newUser(admin, 'viewer', ['dashboard']);
  assert.equal((await f.request('/dashboard', { session: viewer })).status, 200);
  for (const path of ['/files', '/files/schedule/versions', `/files/schedule/versions/${uploaded.versionId}`, `/files/schedule/versions/${uploaded.versionId}/download`, '/dashboard/export', '/users', '/logs?kind=login']) {
    assert.equal((await f.request(path, { session: viewer })).status, 403, path);
  }
  const { session: fileViewer } = await f.newUser(admin, 'fileviewer', ['files']);
  assert.equal((await f.request(`/files/schedule/versions/${uploaded.versionId}`, { session: fileViewer })).status, 200);
  assert.equal((await f.request(`/files/schedule/versions/${uploaded.versionId}/download`, { session: fileViewer })).status, 403);
  assert.equal((await f.preview('shipment', await syntheticForecast(20), fileViewer)).status, 403);
  assert.equal((await f.request('/files/schedule/restore', { method: 'POST', session: fileViewer,
    body: { versionId: uploaded.versionId, baseRevision: 1 } })).status, 403);
  const logs = (await f.request('/logs?kind=security', { session: admin })).data.items;
  assert.ok(logs.some(log => log.actorName === 'viewer' && log.method === 'GET' && log.status === 403));
  assert.ok(logs.some(log => log.actorName === 'fileviewer' && log.target === 'download'));
  assert.ok(logs.some(log => log.actorName === 'fileviewer' && log.target === 'restore'));
});

test('筛选导出可重新读取，时间待定中文显示，无 Table/隐藏行，已填内容都有边框', async t => {
  const f = await appFixture(t);
  const admin = await f.login();
  await f.upload('shipment', await syntheticForecast(0), admin, '有效零金额.xlsx');
  const incompleteResponse = await f.request('/dashboard/export?from=2026-11&to=2026-11', { session: admin });
  assert.equal(incompleteResponse.status, 200);
  const incomplete = new ExcelJS.Workbook();
  await incomplete.xlsx.load(incompleteResponse.bytes);
  const incompleteMonthly = incomplete.getWorksheet('月度付款汇总');
  for (const row of [2, 3, 5, 6, 9, 10]) assert.equal(valueByHeader(incompleteMonthly, row, '2026-11合计（元）'), '未上传');
  assert.equal(valueByHeader(incompleteMonthly, 8, '2026-11合计（元）'), 0);
  assert.match(valueByHeader(incompleteMonthly, 4, '数据状态'), /已上传部分/);
  const incompleteStats = Object.fromEntries(incomplete.getWorksheet('统计口径').getRows(2, incomplete.getWorksheet('统计口径').rowCount - 1)
    .map(row => [row.getCell(1).value, row.getCell(2).value]));
  for (const name of ['明确月份付款计划', '时间待定付款计划', '台账累计已付（已知）', '台账剩余金额（已知）',
    '售后配件预估', '售后配件预估（时间待定）', '已发货未登记台账预估', '已发货未登记台账预估（时间待定）']) assert.equal(incompleteStats[name], '未上传', name);
  assert.equal(incompleteStats['发货计划预估'], 0);
  assert.equal(incompleteStats['发货计划预估（时间待定）'], 0);
  await f.upload('schedule', await syntheticSchedule(), admin, '合成付款.xlsx');
  await f.upload('shipment', await syntheticForecast(30, { pending: true }), admin, '时间待定.xlsx');
  const response = await f.request('/dashboard/export?from=2026-11&to=2026-11', { session: admin });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /spreadsheetml/);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(response.bytes);
  assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ['月度付款汇总', '筛选明细', '统计口径', '待核对']);
  const monthly = workbook.getWorksheet('月度付款汇总');
  assert.equal(monthly.rowCount, 11);
  for (const row of [3, 5, 6]) assert.equal(valueByHeader(monthly, row, '时间待定合计（元）'), 0);
  assert.equal(valueByHeader(monthly, 8, '2026-11合计（元）'), 0);
  assert.equal(valueByHeader(monthly, 8, '时间待定未付（元）'), 30);
  assert.equal(valueByHeader(monthly, 8, '所选期间合计（元）'), 0);
  assert.equal(valueByHeader(monthly, 11, '2026-11已付（元）'), 200);
  assert.equal(valueByHeader(monthly, 11, '2026-11未付（元）'), 600);
  assert.equal(valueByHeader(monthly, 11, '所选期间合计（元）'), 800);
  for (const row of [9, 10]) for (const month of ['2026-11', '时间待定']) assert.equal(valueByHeader(monthly, row, `${month}合计（元）`), '未上传');
  const details = workbook.getWorksheet('筛选明细');
  assert.equal(details.rowCount, 4);
  assert.equal(details.getCell('E2').value, 600);
  assert.equal(details.getCell('G2').value, 250);
  assert.equal(details.getCell('M2').value, '=1+1');
  assert.equal(details.getCell('M2').formula, undefined);
  assert.equal(details.getCell('I2').value, '2026-11');
  for (const sheet of workbook.worksheets) {
    assert.equal(sheet.getTables().length, 0);
    assert.ok(sheet.autoFilter);
    assert.equal(sheet.views[0].ySplit, 1);
    for (let r = 1; r <= sheet.rowCount; r++) {
      const row = sheet.getRow(r);
      assert.notEqual(row.hidden, true);
      for (let c = 1; c <= sheet.columnCount; c++) {
        const cell = row.getCell(c);
        if (cell.value === null || cell.value === undefined) continue;
        for (const side of ['top', 'right', 'bottom', 'left']) assert.equal(cell.border?.[side]?.style, 'thin', `${sheet.name}!${cell.address} ${side}`);
      }
    }
  }
  const logsResponse = await f.request('/logs/export?kind=operation', { session: admin });
  assert.equal(logsResponse.status, 200);
  const logsBook = new ExcelJS.Workbook();
  await logsBook.xlsx.load(logsResponse.bytes);
  const logs = logsBook.getWorksheet('操作记录');
  assert.ok(logs.rowCount > 1);
  for (let row = 2; row <= logs.rowCount; row++) assert.equal(logs.getCell(`B${row}`).value, 'admin');
});
