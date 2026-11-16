import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { normalizeWorksheetParts } from '../server/xlsx-compat.js';
import { inspectWorkbook, parseWorkbook } from '../server/parser.js';

function scheduleBook() {
  const workbook = new ExcelJS.Workbook();
  const negotiated = workbook.addWorksheet('谈判付款');
  negotiated.addRow(['创跟单员', '供应商', '付款主体', '对公付款0A流程号', '摘要', 'OA-申请付款金额', '应付款时间', '已付金额', '剩余付款金额', '是否结清', '流程状态', '2026年11月支付', '是否谈判分批', '2026年11月2日', '备注']);
  negotiated.addRow(['甲', '合成谈判供应商', '合成主体', 'MDST-DGFK20261101001', '分期款', 500, '2026-11-01', 500, 0, '是', '未归档', { formula: '250+250', result: 500 }, '是', { formula: '250+250', result: 500 }, '原始备注']);
  negotiated.getCell('N2').note = '付款时间（付款节奏跟进）：2026年11月2日';
  negotiated.getCell('O2').value = { text: '原始备注', hyperlink: 'https://example.com/source' };
  const normal = workbook.addWorksheet('正常付款');
  normal.addRow(['跟单员', '供应商名称', '付款主体', '对公付款0A流程号', '摘要', '本次申请付款金额', '应付时间', '已付金额', '剩余金额', '是否结清', '流程状态']);
  normal.addRow(['乙', '合成正常供应商', '合成主体', 'MDST-DGFK20261101002', '正常款', { formula: '200+300', result: 500 }, '2026-11-03', 0, 500, '否', '未归档']);
  normal.addRow(['乙', '合成零金额供应商', '合成主体', '', '零金额', { formula: '1-1', result: 0 }, '2026-11-03', 0, 0, '否', '未归档']);
  normal.addRow(['乙', '合成无缓存供应商', '合成主体', '', '无缓存金额', { formula: '2+3' }, '2026-11-03', 0, 0, '否', '未归档']);
  const progress = workbook.addWorksheet('付款进度整理');
  progress.addRow(['对公付款OA号', '申请付款金额', '供应商名称', '付款主体', '是否已付款']);
  progress.addRow(['MDST-DGFK20261101002', 500, '合成正常供应商', '合成主体', '已付款']);
  workbook.addWorksheet('付款申请核对').addRow(['说明', '不重复增加业务记录']);
  return workbook;
}

async function bufferOf(workbook) {
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

// Only synthetic ZIPs are rewritten to reproduce valid custom worksheet part names.
async function renamePart(zip, from, to, relationshipId) {
  const oldPath = `xl/worksheets/${from}.xml`, nextPath = `xl/worksheets/${to}.xml`;
  zip.file(nextPath, await zip.file(oldPath).async('nodebuffer'));
  zip.remove(oldPath);
  const oldRels = `xl/worksheets/_rels/${from}.xml.rels`;
  if (zip.file(oldRels)) {
    zip.file(`xl/worksheets/_rels/${to}.xml.rels`, await zip.file(oldRels).async('nodebuffer'));
    zip.remove(oldRels);
  }
  let relationships = await zip.file('xl/_rels/workbook.xml.rels').async('string');
  const relationship = relationships.match(/<Relationship\s[^>]+>/g).find(tag => tag.includes(`Target="worksheets/${from}.xml"`));
  assert.ok(relationship);
  const oldId = relationship.match(/\bId="([^"]+)"/)[1];
  relationships = relationships.replace(relationship, relationship.replace(`worksheets/${from}.xml`, `worksheets/${to}.xml`).replace(`Id="${oldId}"`, `Id="${relationshipId}"`));
  zip.file('xl/_rels/workbook.xml.rels', relationships);
  zip.file('xl/workbook.xml', (await zip.file('xl/workbook.xml').async('string')).replace(`r:id="${oldId}"`, `r:id="${relationshipId}"`));
  zip.file('[Content_Types].xml', (await zip.file('[Content_Types].xml').async('string')).replaceAll(`/${oldPath}`, `/${nextPath}`));
}

async function customBook() {
  const original = await bufferOf(scheduleBook());
  const zip = await JSZip.loadAsync(original);
  for (const [index, name] of ['negotiated', 'normal', 'progress', 'review'].entries()) {
    await renamePart(zip, `sheet${index + 1}`, `funds-${name}`, `rIdFunds${name}`);
  }
  return { original, custom: await zip.generateAsync({ type: 'nodebuffer' }) };
}

test('标准工作表路径直接返回原 Buffer', async () => {
  const original = await bufferOf(scheduleBook());
  assert.equal(await normalizeWorksheetParts(original), original);
});

test('自定义工作表路径和非数字关系 ID 可被预览及解析，批注已付与进度表关联不变', async () => {
  const { original, custom } = await customBook();
  const oldReader = new ExcelJS.Workbook();
  await oldReader.xlsx.load(custom);
  assert.equal(oldReader.worksheets.length, 0, '复现旧读取器静默跳过合法自定义路径');
  const expected = await parseWorkbook(original, { slotId: 'schedule' });
  const inspection = await inspectWorkbook(custom, 'schedule');
  assert.deepEqual(inspection.sheets.map(sheet => sheet.name), ['谈判付款', '正常付款', '付款进度整理', '付款申请核对']);
  assert.deepEqual(inspection.sheets.filter(sheet => sheet.defaultSelected).map(sheet => sheet.name), ['谈判付款', '正常付款', '付款进度整理']);
  const actual = await parseWorkbook(custom, { slotId: 'schedule' });
  assert.deepEqual(actual.records, expected.records);
  assert.deepEqual(actual.issues, expected.issues);
  assert.deepEqual(actual.paymentProgress, expected.paymentProgress);
  assert.equal(actual.records.length, 4);
  assert.equal(actual.paymentProgress.rows.length, 1);
  assert.equal(actual.records[0].plans[0].paidCents, 50000);
  assert.equal(actual.records[1].plans[0].paidCents, 50000);
  assert.equal(actual.records[2].amountCents, 0);
  assert.equal(actual.records[3].amountCents, 0);
  assert.ok(actual.issues.some(issue => issue.code === 'ZERO_DEFAULTED' && issue.sourceRow === 4));
});

test('归一化不改原 Buffer 或工作表字节，批注、自身关系、公式缓存及有效零值保留', async () => {
  const { original, custom } = await customBook();
  const before = Buffer.from(custom);
  const sourceZip = await JSZip.loadAsync(custom);
  const normalized = await normalizeWorksheetParts(custom);
  assert.deepEqual(custom, before);
  const normalizedZip = await JSZip.loadAsync(normalized);
  const targetParts = Object.values(normalizedZip.files).filter(entry => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.name));
  assert.equal(targetParts.length, 4);
  for (const sourceName of ['negotiated', 'normal', 'progress', 'review']) {
    const bytes = await sourceZip.file(`xl/worksheets/funds-${sourceName}.xml`).async('nodebuffer');
    const matches = await Promise.all(targetParts.map(async entry => (await entry.async('nodebuffer')).equals(bytes)));
    assert.equal(matches.filter(Boolean).length, 1);
  }
  assert.deepEqual(await normalizedZip.file('xl/workbook.xml').async('nodebuffer'), await sourceZip.file('xl/workbook.xml').async('nodebuffer'));
  const beforeWorkbook = new ExcelJS.Workbook(), afterWorkbook = new ExcelJS.Workbook();
  await beforeWorkbook.xlsx.load(original);
  await afterWorkbook.xlsx.load(normalized);
  for (const [sheetName, addresses] of [['谈判付款', ['L2', 'N2', 'O2']], ['正常付款', ['F2', 'F3', 'F4']]]) {
    for (const address of addresses) {
      const source = beforeWorkbook.getWorksheet(sheetName).getCell(address);
      const target = afterWorkbook.getWorksheet(sheetName).getCell(address);
      assert.deepEqual(target.value, source.value);
      assert.deepEqual(target.note, source.note);
    }
  }
});

test('新内部文件名避开已有工作表和孤立关系文件，不覆盖原内容', async () => {
  const zip = await JSZip.loadAsync(await bufferOf(scheduleBook()));
  await renamePart(zip, 'sheet2', 'funds-normal', 'rIdFundsNormal');
  const orphanRels = Buffer.from('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>');
  zip.file('xl/worksheets/_rels/sheet2.xml.rels', orphanRels);
  const existingSheet = await zip.file('xl/worksheets/sheet1.xml').async('nodebuffer');
  const existingNumbered = Buffer.from('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>');
  zip.file('xl/worksheets/sheet5.xml', existingNumbered);
  const normalized = await JSZip.loadAsync(await normalizeWorksheetParts(await zip.generateAsync({ type: 'nodebuffer' })));
  assert.deepEqual(await normalized.file('xl/worksheets/sheet1.xml').async('nodebuffer'), existingSheet);
  assert.deepEqual(await normalized.file('xl/worksheets/sheet5.xml').async('nodebuffer'), existingNumbered);
  assert.deepEqual(await normalized.file('xl/worksheets/_rels/sheet2.xml.rels').async('nodebuffer'), orphanRels);
  const relationships = await normalized.file('xl/_rels/workbook.xml.rels').async('string');
  const normalRelationship = relationships.match(/<Relationship\s[^>]+>/g).find(tag => tag.includes('Id="rIdFundsNormal"'));
  assert.ok(normalRelationship);
  assert.match(normalRelationship, /Target="worksheets\/sheet\d+\.xml"/);
  assert.doesNotMatch(normalRelationship, /Target="worksheets\/sheet[12345]\.xml"/);
});

test('真实缺少正常付款仍拒绝，不把其他表当作正常付款', async () => {
  const workbook = scheduleBook();
  workbook.removeWorksheet('正常付款');
  await assert.rejects(parseWorkbook(await bufferOf(workbook), { slotId: 'schedule' }), error => error.status === 422 && /正常付款/.test(error.message) && /不存在|缺少.*工作表/.test(error.message));
});

test('存在工作表但缺表头时，提示已找到工作表及缺失表头', async () => {
  const workbook = scheduleBook();
  workbook.getWorksheet('正常付款').getCell('B1').value = '错误字段';
  await assert.rejects(parseWorkbook(await bufferOf(workbook), { slotId: 'schedule' }), error => error.status === 422 && /正常付款.*已找到.*供应商/.test(error.message) && !/不存在/.test(error.message));
});

test('关联文件缺失、外部工作表和 DTD 不会被兼容处理绕过校验', async () => {
  const original = await bufferOf(scheduleBook());
  for (const mutate of [
    xml => xml.replace('Target="worksheets/sheet1.xml"', 'Target="worksheets/missing.xml"'),
    xml => xml.replace('Target="worksheets/sheet1.xml"', 'Target="https://example.com/sheet1.xml" TargetMode="External"'),
    xml => xml.replace('<Relationships ', '<!DOCTYPE Relationships SYSTEM "https://example.com/external.dtd"><Relationships '),
  ]) {
    const zip = await JSZip.loadAsync(original);
    zip.file('xl/_rels/workbook.xml.rels', mutate(await zip.file('xl/_rels/workbook.xml.rels').async('string')));
    await assert.rejects(inspectWorkbook(await zip.generateAsync({ type: 'nodebuffer' }), 'schedule'), error => error.status === 422);
  }
});
