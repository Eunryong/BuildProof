import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function createPersistence({ db, dataDir }) {
  const dataFile = path.join(dataDir, 'submissions.json');
  const interviewProofsFile = path.join(dataDir, 'interview-proofs.json');

async function readStore() {
  if (db) {
    const rows = await db.prepare('SELECT record_json FROM submissions ORDER BY created_at DESC').all();
    return (rows.results || []).map((row) => JSON.parse(row.record_json));
  }
  try {
    const raw = await readFile(dataFile, 'utf8');
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function writeStore(records) {
  if (db) {
    if (!records.length) return;
    await db.batch(records.map((record) => db.prepare('INSERT INTO submissions (id, owner_id, created_at, record_json) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET owner_id = excluded.owner_id, created_at = excluded.created_at, record_json = excluded.record_json')
      .bind(record.id, record.ownerId || null, record.createdAt || new Date().toISOString(), JSON.stringify(record))));
    return;
  }
  await mkdir(dataDir, { recursive: true });
  const tempFile = `${dataFile}.tmp`;
  await writeFile(tempFile, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
  await rename(tempFile, dataFile);
}

async function readInterviewProofs() {
  if (db) {
    const rows = await db.prepare('SELECT record_json FROM interview_proofs').all();
    return (rows.results || []).map((row) => JSON.parse(row.record_json));
  }
  try {
    const raw = await readFile(interviewProofsFile, 'utf8');
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function writeInterviewProofs(records) {
  if (db) {
    if (!records.length) return;
    await db.batch(records.map((record) => db.prepare('INSERT INTO interview_proofs (id, report_id, owner_id, status, issued_at, record_json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET report_id = excluded.report_id, owner_id = excluded.owner_id, status = excluded.status, issued_at = excluded.issued_at, record_json = excluded.record_json')
      .bind(record.id, record.reportId || null, record.ownerId || null, record.status, record.chainTime || record.issuedAt || null, JSON.stringify(record))));
    return;
  }
  await mkdir(dataDir, { recursive: true });
  const tempFile = `${interviewProofsFile}.tmp`;
  await writeFile(tempFile, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
  await rename(tempFile, interviewProofsFile);
}

  return { readStore, writeStore, readInterviewProofs, writeInterviewProofs };
}
