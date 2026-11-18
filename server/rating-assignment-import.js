import ExcelJS from 'exceljs';
import { createHash, randomUUID } from 'node:crypto';
import { checkArchive } from './parser.js';
import { normalizeWorksheetParts } from './xlsx-compat.js';
import { checkRevision, decode, fail, history, monthRow } from './rating-store.js';

export async function parseAssignmentWorkbook(buffer) {
  await checkArchive(buffer);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(await normalizeWorksheetParts(buffer));
  if (book.worksheets.length > 64) throw fail('工作表不能超过64张', 422);
  const sheets = [], skipped = [], suppliers = [], byName = new Map();
  let totalRows = 0;
  for (const sheet of book.worksheets) {
    if (sheet.state !== 'visible') { skipped.push({ name: sheet.name, reason: '隐藏工作表未纳入' }); continue; }
    let header;
    for (let row = 1; row <= Math.min(10, sheet.rowCount); row++) {
      const columns = [];
      sheet.getRow(row).eachCell((cell, column) => { if (['供应商', '供应商名称', '供应商简称'].includes(cell.text.replace(/\s/g, ''))) columns.push(column); });
      if (columns.length > 1) throw fail(`工作表“${sheet.name}”存在多个供应商列，请先明确使用哪列`, 422);
      if (columns.length) { header = { row, column: columns[0] }; break; }
    }
    if (!header) { skipped.push({ name: sheet.name, reason: '前10行未找到供应商列' }); continue; }
    const groups = new Map(); let blankRows = 0;
    sheet.eachRow((row, number) => {
      if (number <= header.row) return;
      if (++totalRows > 20000) throw fail('履约表数据行超过20000行，请精简后上传', 422);
      const cell = row.getCell(header.column);
      if (cell.type === ExcelJS.ValueType.Formula || cell.type === ExcelJS.ValueType.Error) throw fail(`“${sheet.name}”第${number}行供应商须为名称文本，不能是公式或错误值`, 422);
      const name = cell.text.trim();
      if (!name || ['合计', '小计', '总计'].includes(name)) { blankRows++; return; }
      if (name.length > 200) throw fail(`“${sheet.name}”第${number}行供应商名称过长`, 422);
      if (!byName.has(name)) {
        if (suppliers.length >= 1000) throw fail('供应商名称超过1000个，请精简后上传', 422);
        byName.set(name, suppliers.length); suppliers.push({ index: suppliers.length, name });
      }
      const index = byName.get(name);
      if (!groups.has(index)) groups.set(index, []);
      groups.get(index).push(number);
    });
    if (!groups.size) { skipped.push({ name: sheet.name, reason: '没有有效供应商记录' }); continue; }
    sheets.push({ index: sheets.length, name: sheet.name, blankRows, suppliers: [...groups].map(([index, rows]) => ({ index, rows })) });
  }
  if (!sheets.length) throw fail('未找到包含供应商名称的工作表', 422);
  return { sheets, suppliers, skipped };
}

const eligible = u => u.active && (u.is_admin || JSON.parse(u.permissions_json).includes('rate'));
function catalog(db, month) {
  return {
    users: db.prepare('SELECT id,username,display_name,active,is_admin,permissions_json FROM users ORDER BY id').all(),
    suppliers: db.prepare('SELECT * FROM rating_suppliers ORDER BY id').all(),
    assignments: db.prepare('SELECT * FROM rating_assignments WHERE month=? ORDER BY supplier_id').all(month),
  };
}
const signature = data => createHash('sha256').update(JSON.stringify(data)).digest('hex');
export function prepareAssignmentImport(db, month, parsed) {
  const m = monthRow(db, month, true), current = catalog(db, month);
  const users = current.users.filter(eligible).map(u => ({ id: u.id, username: u.username, name: u.display_name }));
  const codes = new Set(current.suppliers.map(s => s.code)); let next = 1;
  const suppliers = parsed.suppliers.map(s => {
    const matches = current.suppliers.filter(existing => existing.name.trim() === s.name);
    let code;
    do { code = `LY${String(next++).padStart(6, '0')}`; } while (codes.has(code));
    codes.add(code);
    return { ...s, newId: randomUUID(), newCode: code, canCreate: !matches.length,
      matchedSupplierId: matches.length === 1 && matches[0].active ? matches[0].id : '',
      issue: matches.length > 1 ? '同名供应商不唯一，请选择' : matches.length === 1 && !matches[0].active ? '同名供应商已停用，请先核对启用状态' : '' };
  });
  return { ...parsed, month, monthRevision: m.revision, baseline: signature(current), users, suppliers,
    existingSuppliers: current.suppliers.filter(s => s.active).map(s => ({ id: s.id, code: s.code, name: s.name })),
    sheets: parsed.sheets.map(s => { const matches = users.filter(u => u.name === s.name.trim() || u.username === s.name.trim()); return { ...s, matchedUserId: matches.length === 1 ? matches[0].id : '' }; }),
  };
}

export function applyAssignmentImport(db, actor, draft, selection) {
  const data = JSON.parse(draft.data_json), m = monthRow(db, draft.month, true);
  checkRevision(m, data.monthRevision);
  const current = catalog(db, draft.month);
  if (signature(current) !== data.baseline) throw fail('账号、供应商或评价范围已更新，请重新上传核对', 409);
  if (!Array.isArray(selection.sheets) || !selection.sheets.length || selection.sheets.length > data.sheets.length || !Array.isArray(selection.suppliers) || selection.suppliers.length > data.suppliers.length) throw fail('请选择工作表、评价人及供应商对应关系');
  const sheets = new Map(), targets = new Map(), needed = new Set();
  for (const choice of selection.sheets) {
    if (!choice || !Number.isInteger(choice.index) || !data.sheets[choice.index] || sheets.has(choice.index)) throw fail('工作表选择无效或重复');
    const user = current.users.find(u => u.id === choice.userId && eligible(u));
    if (!user) throw fail('所选评价人未启用或没有评分权限', 409);
    const sheet = data.sheets[choice.index]; sheets.set(choice.index, { sheet, user });
    sheet.suppliers.forEach(s => needed.add(s.index));
  }
  const choices = new Map();
  for (const choice of selection.suppliers) {
    if (!choice || !needed.has(choice.index) || choices.has(choice.index)) throw fail('供应商对应关系无效或重复');
    choices.set(choice.index, choice);
  }
  for (const choice of [...choices.values()].sort((a, b) => a.index - b.index)) {
    const source = data.suppliers[choice.index];
    let supplier = choice.supplierId === 'new' && source.canCreate
      ? { id: source.newId, code: source.newCode, name: source.name, active: 1, isNew: true }
      : current.suppliers.find(s => s.id === choice.supplierId && s.active);
    const reference = typeof choice.supplierId === 'string' && /^source:(0|[1-9]\d*)$/.exec(choice.supplierId);
    if (reference && Number(reference[1]) < choice.index) supplier = targets.get(Number(reference[1]));
    if (!supplier) throw fail(`请确认“${source.name}”是否与对比名称为同一家供应商`);
    targets.set(choice.index, supplier);
  }
  if (targets.size !== needed.size) throw fail('部分供应商尚未选择对应关系');
  const groups = new Map();
  for (const { sheet, user } of sheets.values()) for (const source of sheet.suppliers) {
    const supplier = targets.get(source.index);
    if (!groups.has(supplier.id)) groups.set(supplier.id, { supplier, users: new Map(), sources: [] });
    const group = groups.get(supplier.id); group.users.set(user.id, { id: user.id, name: user.display_name });
    group.sources.push({ sheet: sheet.name, supplier: data.suppliers[source.index].name, rows: source.rows });
  }
  const changes = []; let newSuppliers = 0, addedRaters = 0;
  for (const { supplier, users, sources } of groups.values()) {
    const before = decode(current.assignments.find(a => a.supplier_id === supplier.id));
    if (before?.exempt) throw fail(`“${before.name}”本月设置为不参评，请先人工核对后再分配`, 409);
    const raters = [...(before?.raters || [])];
    for (const user of users.values()) if (!raters.some(r => r.id === user.id)) { raters.push(user); addedRaters++; }
    if (supplier.isNew) {
      db.prepare('INSERT INTO rating_suppliers(id,code,name,active) VALUES(?,?,?,1)').run(supplier.id, supplier.code, supplier.name); newSuppliers++;
    }
    const after = { code: before?.code || supplier.code, name: before?.name || supplier.name, raters, exempt: false, reason: before?.reason || '' };
    if (!before || raters.length !== before.raters.length) db.prepare('INSERT INTO rating_assignments(month,supplier_id,data_json) VALUES(?,?,?) ON CONFLICT(month,supplier_id) DO UPDATE SET data_json=excluded.data_json,revision=revision+1').run(draft.month, supplier.id, JSON.stringify(after));
    changes.push({ supplierId: supplier.id, before, after, sources });
  }
  const summary = { sheets: sheets.size, suppliers: groups.size, newSuppliers, addedRaters };
  db.prepare('UPDATE rating_assignment_imports SET committed=1,data_json=? WHERE id=?').run(JSON.stringify({ ...data, selection, summary }), draft.id);
  history(db, actor, '导入履约表分配评价人', draft.month, '', { importId: draft.id, summary, changes });
  return summary;
}
