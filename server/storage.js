import { reviewIssueCount } from '../shared/issue-level.js';
import { randomUUID } from 'node:crypto';
import { ALL_SLOTS, PARSER_VERSION, SLOTS } from '../shared/constants.js';
import { audit, transaction } from './db.js';
import { resolveProgressPayments } from './payment-progress.js';

export function initializeStorage(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS file_slots (
      id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0,
      current_version_id TEXT, updated_at TEXT, updated_by TEXT,
      FOREIGN KEY(current_version_id) REFERENCES file_versions(id)
    );
    CREATE TABLE IF NOT EXISTS file_versions (
      id TEXT PRIMARY KEY, slot_id TEXT NOT NULL REFERENCES file_slots(id),
      filename TEXT NOT NULL, content BLOB NOT NULL, parsed_json TEXT NOT NULL,
      selected_sheets_json TEXT NOT NULL, uploaded_by TEXT NOT NULL,
      uploaded_at TEXT NOT NULL, record_count INTEGER NOT NULL, issue_count INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS versions_slot ON file_versions(slot_id, uploaded_at);
    CREATE TABLE IF NOT EXISTS file_parse_cache (
      version_id TEXT PRIMARY KEY REFERENCES file_versions(id),
      parser_version INTEGER NOT NULL, parsed_json TEXT NOT NULL,
      record_count INTEGER NOT NULL, issue_count INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS upload_drafts (
      token TEXT PRIMARY KEY, slot_id TEXT NOT NULL REFERENCES file_slots(id),
      user_id TEXT NOT NULL REFERENCES users(id), base_revision INTEGER NOT NULL,
      filename TEXT NOT NULL, content BLOB NOT NULL, created_at TEXT NOT NULL
    );
  `);
  const insert = db.prepare('INSERT OR IGNORE INTO file_slots(id) VALUES (?)');
  ALL_SLOTS.forEach(s => insert.run(s.id));
}

export function fail(status, message) { return Object.assign(new Error(message), { status }); }
export function requireSlot(db, id) {
  const row = db.prepare('SELECT * FROM file_slots WHERE id = ?').get(id);
  if (!row) throw fail(404, '文件槽位不存在');
  return row;
}
function versionInfo(row) {
  return {
    id: row.id, filename: row.filename, uploadedBy: row.uploaded_by, uploadedAt: row.uploaded_at,
    recordCount: row.record_count, issueCount: row.issue_count,
    selectedSheets: JSON.parse(row.selected_sheets_json), current: Boolean(row.current),
  };
}
export function listSlots(db, definitions = SLOTS) {
  return definitions.map(s => {
    const row = db.prepare(`SELECT s.*, v.filename, v.uploaded_by, v.uploaded_at,
      COALESCE(c.record_count, v.record_count) AS record_count,
      COALESCE(c.issue_count, v.issue_count) AS issue_count FROM file_slots s
      LEFT JOIN file_versions v ON v.id = s.current_version_id
      LEFT JOIN file_parse_cache c ON c.version_id=v.id AND c.parser_version=? WHERE s.id = ?`).get(PARSER_VERSION, s.id);
    return { ...s, revision: row.revision, currentVersionId: row.current_version_id,
      filename: row.filename, uploadedBy: row.uploaded_by, uploadedAt: row.uploaded_at,
      recordCount: row.record_count || 0, issueCount: row.issue_count || 0,
      updatedAt: row.updated_at, updatedBy: row.updated_by };
  });
}
export function createDraft(db, { slotId, userId, filename, content }) {
  const slot = requireSlot(db, slotId);
  const now = new Date().toISOString();
  const token = randomUUID();
  transaction(db, () => {
    db.prepare('DELETE FROM upload_drafts WHERE created_at < ?').run(new Date(Date.now() - 3600_000).toISOString());
    // Only the newest pending upload per user and slot needs to remain in temporary storage.
    db.prepare('DELETE FROM upload_drafts WHERE user_id = ? AND slot_id = ?').run(userId, slotId);
    db.prepare(`INSERT INTO upload_drafts VALUES (?,?,?,?,?,?,?)`)
      .run(token, slotId, userId, slot.revision, filename, content, now);
  });
  return { token, baseRevision: slot.revision };
}
export function getDraft(db, token, slotId, userId) {
  if (typeof token !== 'string') throw fail(400, '请选择需要上传的文件');
  const row = db.prepare('SELECT * FROM upload_drafts WHERE token = ? AND slot_id = ? AND user_id = ?')
    .get(token, slotId, userId);
  if (!row || Date.now() - Date.parse(row.created_at) > 3600_000) throw fail(409, '待上传文件已失效，请重新选择文件');
  return row;
}
function checkRevision(slot, revision) {
  if (!Number.isSafeInteger(revision) || revision !== slot.revision) {
    throw fail(409, '这个槽位已被更新，请刷新并重新选择文件，避免覆盖他人的修改');
  }
}
export function activateDraft(db, draft, parsed, revision, event) {
  return transaction(db, () => {
    const slot = requireSlot(db, draft.slot_id);
    checkRevision(slot, revision);
    if (draft.base_revision !== revision) throw fail(409, '上传期间文件已变化，请重新上传');
    if (!db.prepare('SELECT token FROM upload_drafts WHERE token = ?').get(draft.token)) throw fail(409, '这个上传已完成或失效');
    const id = randomUUID(); const now = new Date().toISOString();
    db.prepare('INSERT INTO file_versions VALUES (?,?,?,?,?,?,?,?,?,?)').run(
      id, draft.slot_id, draft.filename, draft.content, JSON.stringify(parsed),
      JSON.stringify(parsed.selectedSheets), event.actor, now, parsed.records.length, reviewIssueCount(parsed.issues),
    );
    db.prepare('UPDATE file_slots SET current_version_id=?, revision=revision+1, updated_at=?, updated_by=? WHERE id=?')
      .run(id, now, event.actor, draft.slot_id);
    db.prepare('DELETE FROM upload_drafts WHERE token=?').run(draft.token);
    audit(db, { ...event, kind: 'operation', action: '上传并替换文件', target: draft.slot_id, outcome: 'success',
      details: { previousVersionId: slot.current_version_id, versionId: id, filename: draft.filename,
        recordCount: parsed.records.length, issueCount: reviewIssueCount(parsed.issues), selectedSheets: parsed.selectedSheets } });
    return { slot: listSlots(db, ALL_SLOTS).find(s => s.id === draft.slot_id), version: { id } };
  });
}
export function listVersions(db, slotId) {
  const slot = requireSlot(db, slotId);
  return db.prepare(`SELECT v.id,v.filename,v.uploaded_by,v.uploaded_at,v.selected_sheets_json,
    COALESCE(c.record_count, v.record_count) AS record_count, COALESCE(c.issue_count, v.issue_count) AS issue_count,
    v.id = ? AS current FROM file_versions v
    LEFT JOIN file_parse_cache c ON c.version_id=v.id AND c.parser_version=?
    WHERE v.slot_id=? ORDER BY v.uploaded_at DESC, v.rowid DESC`)
    .all(slot.current_version_id, PARSER_VERSION, slotId).map(versionInfo);
}
export function getVersion(db, slotId, id) {
  requireSlot(db, slotId);
  const row = db.prepare('SELECT * FROM file_versions WHERE slot_id=? AND id=?').get(slotId, id);
  if (!row) throw fail(404, '文件版本不存在');
  return row;
}
const progressVersion = row => row ? ({ id: row.id, filename: row.filename, uploadedAt: row.uploaded_at, uploadedBy: row.uploaded_by }) : null;
function currentProgress(db) {
  const row = db.prepare(`SELECT v.*, COALESCE(c.parsed_json,v.parsed_json) AS effective_parsed_json
    FROM file_slots s JOIN file_versions v ON v.id=s.current_version_id
    LEFT JOIN file_parse_cache c ON c.version_id=v.id AND c.parser_version=? WHERE s.id='schedule'`).get(PARSER_VERSION);
  return { progress: row ? JSON.parse(row.effective_parsed_json).paymentProgress : null, source: progressVersion(row) };
}
export function versionDetails(db, slotId, id) {
  const row = getVersion(db, slotId, id);
  const cached = db.prepare('SELECT parsed_json,record_count,issue_count FROM file_parse_cache WHERE version_id=? AND parser_version=?')
    .get(id, PARSER_VERSION);
  const parsed = JSON.parse(cached?.parsed_json ?? row.parsed_json);
  if (parsed.kind === 'delivery') return {
    version: versionInfo({ ...row, ...cached, current: requireSlot(db, slotId).current_version_id === id }),
    kind: 'delivery', selectedSheets: parsed.selectedSheets,
    records: parsed.records.map(r => ({ ...r, filename: row.filename, versionId: row.id, slotId })),
    issues: parsed.issues.map(i => ({ ...i, versionId: row.id, slotId })),
  };
  const context = slotId === 'schedule' ? { progress: parsed.paymentProgress, source: progressVersion(row) } :
    parsed.kind === 'archive' ? { progress: null, source: null } : currentProgress(db);
  const resolved = resolveProgressPayments(parsed.records.map(r => ({ ...r, filename: row.filename, versionId: row.id, slotId })), context.progress, context.source);
  return { version: versionInfo({ ...row, ...cached, current: requireSlot(db, slotId).current_version_id === id }),
    ...(parsed.kind === 'archive' ? { kind: parsed.kind, sheets: parsed.sheets, selectedSheets: parsed.selectedSheets } : {}),
    progressSource: context.source, progressScope: slotId === 'schedule' ? 'self' : 'current',
    records: resolved.records,
    issues: [...parsed.issues.map(i => ({ ...i, versionId: row.id, slotId })), ...resolved.issues] };
}
export function restoreVersion(db, slotId, id, revision, event) {
  return transaction(db, () => {
    const slot = requireSlot(db, slotId); checkRevision(slot, revision);
    getVersion(db, slotId, id);
    if (slot.current_version_id === id) throw fail(400, '该版本已经是当前有效版本');
    db.prepare('UPDATE file_slots SET current_version_id=?,revision=revision+1,updated_at=?,updated_by=? WHERE id=?')
      .run(id, new Date().toISOString(), event.actor, slotId);
    audit(db, { ...event, kind: 'operation', action: '恢复历史版本', target: slotId, outcome: 'success',
      details: { previousVersionId: slot.current_version_id, versionId: id } });
    return { slot: listSlots(db, ALL_SLOTS).find(s => s.id === slotId) };
  });
}
export function activeData(db) {
  const records = []; const issues = [];
  for (const row of db.prepare(`SELECT v.id,v.slot_id,v.filename,COALESCE(c.parsed_json,v.parsed_json) AS parsed_json FROM file_slots s
    JOIN file_versions v ON v.id=s.current_version_id
    LEFT JOIN file_parse_cache c ON c.version_id=v.id AND c.parser_version=?
    WHERE s.id IN (${SLOTS.map(() => '?').join(',')}) ORDER BY s.rowid`).all(PARSER_VERSION, ...SLOTS.map(slot => slot.id))) {
    const parsed = JSON.parse(row.parsed_json);
    records.push(...parsed.records.map(r => ({ ...r, slotId: row.slot_id, versionId: row.id, filename: row.filename })));
    issues.push(...parsed.issues.map(i => ({ ...i, slotId: row.slot_id, versionId: row.id })));
  }
  const context = currentProgress(db);
  const resolved = resolveProgressPayments(records, context.progress, context.source);
  return { records: resolved.records, issues: [...issues, ...resolved.issues], slots: listSlots(db) };
}
