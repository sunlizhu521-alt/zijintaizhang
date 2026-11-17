import test from 'node:test';
import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { loadDeliveryWorkbook, isLegacyWorkbook } from '../server/delivery-workbook.js';
import { inspectWorkbook, parseWorkbook } from '../server/parser.js';

const headers = ['采购日期', '单据编号', '供应商', '物料编码', '采购数量', '交货日期'];
const values = [46327, 'PO-TEST', '合成供应商', 'SKU-TEST', 12, 46346];
function sheetBook(rows = [headers, values]) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), '订单');
  return book;
}
const bytes = (book, bookType = 'biff8') => Buffer.from(XLSX.write(book, { type: 'buffer', bookType }));
const parse = data => parseWorkbook(data, { slotId: 'delivery_orders' });

function modifyCfb(data, update) {
  const container = XLSX.CFB.read(data, { type: 'buffer' });
  update(container);
  return Buffer.from(XLSX.CFB.write(container, { type: 'buffer' }));
}

test('真正的 BIFF8 XLS 能识别 native 序号日期及 1904 日期系统', async () => {
  const book = sheetBook();
  book.Sheets['订单'].A2.z = 'yyyy-mm-dd';
  book.Sheets['订单'].F2.z = 'yyyy-mm-dd';
  const original = bytes(book);
  assert.equal(isLegacyWorkbook(original), true);
  const parsed = await parse(original);
  assert.equal(parsed.records[0].createdDate, '2026-11-01');
  assert.equal(parsed.records[0].dueDate, '2026-11-20');
  assert.equal(parsed.records[0].quantity, 12);
  assert.deepEqual(parsed.records[0].invalidFields, []);
  const old = sheetBook([headers, [0, 'PO-OLD', '合成供应商', 'SKU-OLD', 0, 1]]);
  old.Workbook = { WBProps: { date1904: true } };
  const early = await parse(bytes(old));
  assert.equal(early.records[0].createdDate, '1904-01-01');
  assert.equal(early.records[0].dueDate, '1904-01-02');
  assert.equal(early.records[0].quantity, 0);
});

test('XLSX adapter 保留公式缓存零、空缓存与错误值，不重新计算', async () => {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('订单');
  sheet.addRow(headers);
  for (const quantity of [{ formula: '1-1', result: 0 }, { formula: '6+6' }, { formula: '1/0', result: { error: '#DIV/0!' } }, { formula: '""', result: '' }]) sheet.addRow(values.map((value, column) => column === 4 ? quantity : value));
  const data = Buffer.from(await book.xlsx.writeBuffer());
  const loaded = loadDeliveryWorkbook(data).getWorksheet('订单');
  assert.equal(loaded.getRow(2).getCell(5).result, 0);
  assert.equal(loaded.getRow(3).getCell(5).result, null);
  assert.equal(typeof loaded.getRow(4).getCell(5).value.error, 'string');
  const parsed = await parse(data);
  assert.deepEqual(parsed.records.map(row => row.quantity), [0, null, null, null]);
  assert.equal(parsed.issues.filter(issue => issue.code === 'INVALID_DELIVERY_QUANTITY').length, 3);
});

test('XLS/XLSX 的真实合并单元格映射原值，普通空白不猜填，空模板有效', async () => {
  for (const kind of ['biff8', 'xlsx']) {
    const book = sheetBook([headers, values, [46327, null, null, 'SKU-SECOND', 0, 46346]]);
    book.Sheets['订单']['!merges'] = [XLSX.utils.decode_range('B2:B3')];
    const parsed = await parse(bytes(book, kind));
    assert.equal(parsed.records.length, 2);
    assert.equal(parsed.records[1].orderNumber, 'PO-TEST');
    assert.equal(parsed.records[1].supplier, '');
    assert.equal(parsed.records[1].quantity, 0);
    assert.ok(parsed.records[1].invalidFields.includes('supplier'));
    const empty = await parse(bytes(sheetBook([headers]), kind));
    assert.equal(empty.records.length, 0);
    const completelyBlank = await inspectWorkbook(bytes(sheetBook([[]]), kind), 'delivery_orders');
    assert.equal(completelyBlank.sheets[0].eligible, false);
  }
});

test('隐藏辅助表不默认读取，sheet count 和行数上限在 adapter 检查', async () => {
  const book = sheetBook();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([headers, values]), '隐藏订单');
  book.Workbook = { Sheets: [{ Hidden: 0 }, { Hidden: 1 }] };
  const inspected = await inspectWorkbook(bytes(book), 'delivery_orders');
  assert.deepEqual(inspected.sheets.map(sheet => sheet.defaultSelected), [true, false]);
  assert.equal((await parse(bytes(book))).records.length, 1);
  const many = XLSX.utils.book_new();
  for (let n = 0; n <= 100; n++) XLSX.utils.book_append_sheet(many, XLSX.utils.aoa_to_sheet([['x']]), `S${n}`);
  assert.throws(() => loadDeliveryWorkbook(bytes(many, 'xlsx')), /工作表过多/);
  const tall = sheetBook();
  tall.Sheets['订单'].A100021 = { t: 's', v: 'too far' };
  tall.Sheets['订单']['!ref'] = 'A1:F100021';
  assert.throws(() => loadDeliveryWorkbook(bytes(tall, 'xlsx')), /100,000/);
});

test('HTML/CSV/普通文本伪装为 Excel、损坏 ZIP 和非工作簿 OLE 均拒绝', async () => {
  for (const data of [Buffer.from('a,b\n1,2'), Buffer.from('<table><tr><td>采购日期</td></tr></table>'), Buffer.from('not an excel workbook'), Buffer.from('504b030400000000', 'hex')]) {
    assert.throws(() => loadDeliveryWorkbook(data), error => error.status === 422);
    await assert.rejects(() => parse(data), error => error.status === 422);
  }
  const cfb = XLSX.CFB.utils.cfb_new();
  XLSX.CFB.utils.cfb_add(cfb, 'WordDocument', Buffer.from('not Excel'));
  const ole = Buffer.from(XLSX.CFB.write(cfb, { type: 'buffer' }));
  assert.equal(isLegacyWorkbook(ole), true);
  assert.throws(() => loadDeliveryWorkbook(ole), error => error.status === 422);
  await assert.rejects(() => parse(ole), error => error.status === 422);
});

test('XLS 的 VBA 存储、加密流与 Excel 4 宏表均被拒绝', async () => {
  const basic = bytes(sheetBook());
  const vba = modifyCfb(basic, cfb => XLSX.CFB.utils.cfb_add(cfb, 'VBA/payload', Buffer.from('synthetic macro placeholder')));
  assert.throws(() => loadDeliveryWorkbook(vba), /宏/);
  const encrypted = modifyCfb(basic, cfb => XLSX.CFB.utils.cfb_add(cfb, 'EncryptionInfo', Buffer.from('synthetic encrypted placeholder')));
  assert.throws(() => loadDeliveryWorkbook(encrypted), error => error.status === 422);
  const macro = modifyCfb(basic, cfb => {
    const workbook = XLSX.CFB.find(cfb, 'Workbook');
    let changed = false;
    for (let offset = 0; offset + 8 <= workbook.content.length;) {
      const id = workbook.content.readUInt16LE(offset), length = workbook.content.readUInt16LE(offset + 2);
      if (id === 0x0809 && workbook.content.readUInt16LE(offset + 6) === 0x0010) {
        workbook.content.writeUInt16LE(0x0040, offset + 6); changed = true; break;
      }
      offset += 4 + length;
    }
    assert.equal(changed, true);
  });
  assert.throws(() => loadDeliveryWorkbook(macro), /宏工作表/);
  await assert.rejects(() => parse(vba), /宏/);
});

test('XLSX ZIP 中的宏和外部工作簿链接在公共解析入口拒绝', async () => {
  const basic = bytes(sheetBook(), 'xlsx');
  for (const name of ['xl/vbaProject.bin', 'xl/externalLinks/externalLink1.xml']) {
    const archive = await JSZip.loadAsync(basic);
    archive.file(name, 'synthetic unsafe part');
    const modified = await archive.generateAsync({ type: 'nodebuffer' });
    await assert.rejects(() => parse(modified), /宏或外部工作簿链接/);
  }
});
