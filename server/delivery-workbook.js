import XLSX from 'xlsx';

const invalid = message => Object.assign(new Error(message), { status: 422 });
export const isLegacyWorkbook = buffer => Buffer.isBuffer(buffer) && buffer.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'));

// Dense cells keep large Kingdee exports inside the isolated parser's memory budget.
export function loadDeliveryWorkbook(buffer) {
  const legacy = isLegacyWorkbook(buffer);
  if (!Buffer.isBuffer(buffer) || (!legacy && !buffer.subarray(0, 4).equals(Buffer.from('504b0304', 'hex')))) throw invalid('文件不是有效的 .xls / .xlsx 工作簿。');
  let source;
  try {
    source = XLSX.read(buffer, { type: 'buffer', dense: true, cellFormula: true, sheetStubs: true, cellText: false,
      cellHTML: false, cellDates: false, bookVBA: true, bookFiles: legacy });
  } catch { throw invalid('无法读取 Excel，请检查是否加密、损坏，或重新导出 .xls / .xlsx。'); }
  if (source.vbaraw || source.cfb?.FullPaths?.some(name => /(?:^|\/)(?:VBA|_VBA_PROJECT|EncryptedPackage|EncryptionInfo)(?:\/|$)/i.test(name))) {
    throw invalid('不支持含宏或加密的 Excel 文件。');
  }
  if (!source.SheetNames?.length) throw invalid('文件没有有效工作表。');
  if (source.SheetNames.length > 100) throw invalid('交付文件工作表过多，请精简后上传。');
  const worksheets = source.SheetNames.map((name, index) => {
    const sheet = source.Sheets[name];
    if (sheet['!type'] === 'macro') throw invalid('不支持包含宏工作表的 Excel。');
    const data = sheet['!data'] || [], merges = sheet['!merges'] || [];
    if (data.length > 100020) throw invalid('交付记录超过 100,000 条，请精简后上传。');
    if (merges.length > 10000) throw invalid('合并区域过多，请精简文件后上传。');
    function cellAt(row, column) {
      let cell = data[row]?.[column];
      if (!cell || (cell.v == null && !cell.f)) {
        const merged = merges.find(range => row >= range.s.r && row <= range.e.r && column >= range.s.c && column <= range.e.c);
        if (merged) cell = data[merged.s.r]?.[merged.s.c];
      }
      if (!cell) return { value: null };
      if (cell.t === 'e') return { value: { error: cell.w || '#ERROR!' } };
      if (cell.f) { const result = cell.t === 'z' ? null : cell.v; return { value: { formula: cell.f, result }, result }; }
      if (cell.t === 'z') return { value: null };
      return { value: cell.v ?? null };
    }
    function getRow(number) {
      const row = number - 1;
      return { getCell: column => cellAt(row, column - 1), eachCell(_options, callback) {
        (data[row] || []).forEach((_cell, column) => {
          const cell = cellAt(row, column);
          if (cell.value != null) callback(cell, column + 1);
        });
      } };
    }
    return { name, rowCount: data.length,
      state: source.Workbook?.Sheets?.[index]?.Hidden ? 'hidden' : 'visible', getRow,
      eachRow(_options, callback) {
        data.forEach((row, index) => { if (row?.some(cell => cell && (cell.f || (cell.t !== 'z' && cell.v != null)))) callback(getRow(index + 1), index + 1); });
      },
    };
  });
  return { worksheets, properties: { date1904: Boolean(source.Workbook?.WBProps?.date1904) },
    getWorksheet: name => worksheets.find(sheet => sheet.name === name) };
}
