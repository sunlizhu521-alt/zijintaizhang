import path from 'node:path/posix';
import JSZip from 'jszip';
import { SaxesParser } from 'saxes';

const escapeXml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');

function mapAttributes(xml, edit) {
  let result = '';
  const parser = new SaxesParser();
  parser.on('doctype', () => { throw new Error('不支持带 DTD 的 Excel 关联文件。'); });
  parser.on('opentag', node => {
    edit(node.name.split(':').pop(), node.attributes);
    result += `<${node.name}${Object.entries(node.attributes).map(([name, value]) => ` ${name}="${escapeXml(value)}"`).join('')}>`;
  });
  parser.on('closetag', node => { result += `</${node.name}>`; });
  parser.on('text', value => { result += escapeXml(value); });
  parser.on('cdata', value => { result += escapeXml(value); });
  parser.write(xml).close();
  return result;
}

// ExcelJS only loads sheetN.xml; adapt package paths in memory, never worksheet contents or the saved original.
export async function normalizeWorksheetParts(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const relationships = zip.file('xl/_rels/workbook.xml.rels');
  if (!relationships) return buffer;
  const renamed = new Map();
  const reserved = new Set(Object.keys(zip.files));
  let nextId = 1;
  const relsPath = name => `${path.dirname(name)}/_rels/${path.basename(name)}.rels`;
  const fail = message => { throw Object.assign(new Error(message), { status: 422 }); };
  const updatedRelationships = mapAttributes(await relationships.async('string'), (name, attrs) => {
    if (name !== 'Relationship' || !attrs.Type?.endsWith('/worksheet')) return;
    if (attrs.TargetMode === 'External') fail('工作表关联指向外部文件，无法读取。');
    const target = decodeURI(attrs.Target || '');
    const original = target.startsWith('/') ? path.normalize(target).slice(1) : path.join('xl', target);
    if (!zip.file(original)) fail(`工作表关联文件缺失：${original}。请重新保存 Excel 后上传。`);
    if (!/^xl\/worksheets\/[^/]+\.xml$/.test(original)) fail(`无法读取工作表内部路径：${original}。请用 Excel 或 WPS 重新保存后上传。`);
    if (/^xl\/worksheets\/sheet\d+\.xml$/.test(original)) return;
    let replacement = renamed.get(original);
    if (!replacement) {
      do { replacement = `xl/worksheets/sheet${nextId++}.xml`; }
      while (reserved.has(replacement) || reserved.has(relsPath(replacement)));
      reserved.add(replacement);
      reserved.add(relsPath(replacement));
      renamed.set(original, replacement);
    }
    attrs.Target = path.relative('xl', replacement);
  });
  if (!renamed.size) return buffer;
  for (const [original, replacement] of renamed) {
    zip.file(replacement, await zip.file(original).async('nodebuffer'));
    zip.remove(original);
    const relations = zip.file(relsPath(original));
    if (relations) {
      zip.file(relsPath(replacement), await relations.async('nodebuffer'));
      zip.remove(relsPath(original));
    }
  }
  zip.file('xl/_rels/workbook.xml.rels', updatedRelationships);
  const types = zip.file('[Content_Types].xml');
  zip.file('[Content_Types].xml', mapAttributes(await types.async('string'), (name, attrs) => {
    const replacement = name === 'Override' && renamed.get(decodeURI(attrs.PartName || '').replace(/^\//, ''));
    if (replacement) attrs.PartName = `/${replacement}`;
  }));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
