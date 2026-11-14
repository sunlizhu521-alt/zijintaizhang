import { PARSER_VERSION } from '../shared/constants.js';
import { audit, transaction } from './db.js';
import { runParser } from './parse-job.js';

export async function refreshParsedVersions(db) {
  const versions = db.prepare(`SELECT v.id, v.slot_id, v.selected_sheets_json,
    COALESCE(c.record_count, v.record_count) AS record_count, COALESCE(c.issue_count, v.issue_count) AS issue_count,
    COALESCE(c.parser_version, json_extract(v.parsed_json, '$.parserVersion')) AS parser_version
    FROM file_versions v LEFT JOIN file_parse_cache c ON c.version_id=v.id
    WHERE json_extract(v.parsed_json, '$.parserVersion') IS NOT ? AND c.parser_version IS NOT ?
    ORDER BY v.rowid`).all(PARSER_VERSION, PARSER_VERSION);
  if (!versions.length) return 0;
  const refreshed = [];
  // Parse every original before writing, so a bad historical file leaves all caches unchanged.
  for (const version of versions) {
    try {
      const { content } = db.prepare('SELECT content FROM file_versions WHERE id=?').get(version.id);
      const parsed = await runParser('parse', Buffer.from(content), {
        slotId: version.slot_id, selectedSheets: JSON.parse(version.selected_sheets_json),
      });
      refreshed.push({ version, parsed });
    } catch {
      throw new Error(`文件解析规则升级失败（槽位 ${version.slot_id}，版本 ${version.id}）。原文件及解析缓存未改动，请核对该版本源文件。`);
    }
  }
  transaction(db, () => {
    const update = db.prepare(`INSERT INTO file_parse_cache VALUES (?,?,?,?,?) ON CONFLICT(version_id) DO UPDATE SET
      parser_version=excluded.parser_version, parsed_json=excluded.parsed_json,
      record_count=excluded.record_count, issue_count=excluded.issue_count`);
    for (const { version, parsed } of refreshed) {
      update.run(version.id, PARSER_VERSION, JSON.stringify(parsed), parsed.records.length, parsed.issues.length);
      audit(db, { actor: '系统', kind: 'operation', action: '更新文件解析规则', target: version.id, outcome: 'success',
        details: { slotId: version.slot_id, previousParserVersion: version.parser_version, parserVersion: PARSER_VERSION,
          previousRecordCount: version.record_count, recordCount: parsed.records.length,
          previousIssueCount: version.issue_count, issueCount: parsed.issues.length } });
    }
    const now = new Date().toISOString();
    const updateSlot = db.prepare('UPDATE file_slots SET revision=revision+1, updated_at=?, updated_by=? WHERE id=?');
    for (const slotId of new Set(versions.map(version => version.slot_id))) updateSlot.run(now, '系统', slotId);
  });
  return refreshed.length;
}
