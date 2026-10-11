import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createInterviewService, InterviewServiceError } from './interview-service.js';
import {
  createInterviewManifest,
  hashInterviewManifest,
  interviewMemoForHash,
  isInterviewProofManifest,
} from './interview-proof.js';

let root = '';
try { root = path.dirname(path.dirname(fileURLToPath(import.meta.url))); } catch { /* Workers do not expose a module file URL. */ }
const memoProgram = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const browserRpcMethods = new Set(['getLatestBlockhash', 'sendTransaction', 'getSignatureStatuses', 'getBlockHeight', 'getTransaction']);
const base58Alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export async function createBuildProofApp({ runtimeEnvironment = process.env, cloudflareEnv = null, vite = null } = {}) {
  const port = Number(runtimeEnvironment.PORT || 8891);
  const host = runtimeEnvironment.HOST || '127.0.0.1';
  const dataDir = runtimeEnvironment.BUILDPROOF_DATA_DIR || path.join(root, 'data');
  const dataFile = path.join(dataDir, 'submissions.json');
  const interviewProofsFile = path.join(dataDir, 'interview-proofs.json');
  const interviewStoreFile = path.join(dataDir, 'interviews.json');
  const rpcUrl = runtimeEnvironment.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
  const publicDemoMode = runtimeEnvironment.PUBLIC_DEMO_MODE === '1';
  const publicSessionSecret = runtimeEnvironment.BUILDPROOF_SESSION_SECRET || '';
  const db = cloudflareEnv?.DB || null;
  const app = express();
  const interviewService = createInterviewService({
    storageFile: db ? null : interviewStoreFile,
    getApiKey: () => runtimeEnvironment.GEMINI_API_KEY || runtimeEnvironment.GOOGLE_API_KEY || '',
    model: runtimeEnvironment.GEMINI_MODEL || 'gemini-3.8-flash',
  });

  if (publicDemoMode && publicSessionSecret.length < 32) {
    throw new Error('BUILDPROOF_SESSION_SECRET must contain at least 32 characters when PUBLIC_DEMO_MODE=1.');
  }

  if (publicDemoMode) app.set('trust proxy', 1);

function guestCookieSignature(id) {
  return createHmac('sha256', publicSessionSecret).update(id).digest('base64url');
}

function validGuestCookie(value) {
  const [id, signature, extra] = String(value || '').split('.');
  if (extra !== undefined || !/^[\da-f-]{36}$/i.test(id || '') || !signature) return null;
  const expected = Buffer.from(guestCookieSignature(id));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? id : null;
}

app.use((request, response, next) => {
  request.contextpulseOwnerId = null;
  if (!publicDemoMode) return next();
  const cookies = Object.fromEntries(String(request.headers.cookie || '').split(';').map((part) => {
    const separator = part.indexOf('=');
    return separator > -1 ? [part.slice(0, separator).trim(), part.slice(separator + 1).trim()] : ['', ''];
  }).filter(([name]) => name));
  const existing = validGuestCookie(cookies.buildproof_guest);
  const ownerId = existing || randomUUID();
  request.contextpulseOwnerId = ownerId;
  if (!existing) {
    response.append('Set-Cookie', `buildproof_guest=${ownerId}.${guestCookieSignature(ownerId)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`);
  }
  if (request.path.startsWith('/api/') || !path.extname(request.path)) response.setHeader('Cache-Control', 'no-store');
  next();
});

const guestRequestCounts = new Map();
function guestRateLimit({ key, max, windowMs }) {
  return (request, response, next) => {
    if (!publicDemoMode) return next();
    const id = request.get('cf-connecting-ip') || request.ip || request.contextpulseOwnerId;
    const bucketKey = `${id}:${key}`;
    const now = Date.now();
    const bucket = guestRequestCounts.get(bucketKey);
    if (!bucket || now - bucket.startedAt >= windowMs) {
      if (guestRequestCounts.size > 2000) {
        for (const [storedKey, storedBucket] of guestRequestCounts) {
          if (now - storedBucket.startedAt >= windowMs) guestRequestCounts.delete(storedKey);
          if (guestRequestCounts.size <= 2000) break;
        }
      }
      guestRequestCounts.set(bucketKey, { startedAt: now, count: 1 });
      return next();
    }
    if (bucket.count >= max) {
      response.setHeader('Retry-After', String(Math.ceil((bucket.startedAt + windowMs - now) / 1000)));
      return response.status(429).json({ error: 'This demo has reached its short-term request limit. Please try again later.' });
    }
    bucket.count += 1;
    return next();
  };
}

app.use(express.json({ limit: '1mb' }));

  function getInterviewService(request) {
    return request.buildproofInterviewService || interviewService;
  }

  if (db) {
    app.use(async (request, response, next) => {
      if (!request.path.startsWith('/api/interviews') && !request.path.startsWith('/api/interview-reports') && request.path !== '/api/interview-proofs/drafts') return next();
      try {
        const ownerId = request.contextpulseOwnerId || 'local';
        request.buildproofInterviewService = createInterviewService({
          getApiKey: () => runtimeEnvironment.GEMINI_API_KEY || runtimeEnvironment.GOOGLE_API_KEY || '',
          model: runtimeEnvironment.GEMINI_MODEL || 'gemini-3.8-flash',
          loadState: async () => {
            const row = await db.prepare('SELECT state_json FROM interview_state WHERE owner_id = ?').bind(ownerId).first();
            return row?.state_json ? JSON.parse(row.state_json) : null;
          },
          saveState: async (state) => {
            await db.prepare('INSERT INTO interview_state (owner_id, state_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(owner_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at')
              .bind(ownerId, JSON.stringify(state), new Date().toISOString()).run();
          },
        });
        await request.buildproofInterviewService.ready;
        return next();
      } catch (error) {
        return next(error);
      }
    });
  }

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

function cleanText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function isPublicKey(value) {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  let number = 0n;
  for (const character of value) {
    const digit = base58Alphabet.indexOf(character);
    if (digit < 0) return false;
    number = number * 58n + BigInt(digit);
  }
  const leadingZeroBytes = value.match(/^1*/)[0].length;
  const significantBytes = number === 0n ? 0 : Math.ceil(number.toString(2).length / 8);
  return leadingZeroBytes + significantBytes === 32;
}

function validHttpUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol);
  } catch {
    return false;
  }
}

function submissionFields(body) {
  return {
    projectName: cleanText(body?.projectName, 80),
    skill: cleanText(body?.skill, 48),
    learnerWallet: cleanText(body?.learnerWallet, 64),
    evidenceUrl: cleanText(body?.evidenceUrl, 500),
    evidenceRef: cleanText(body?.evidenceRef, 80),
  };
}

function validateSubmissionFields(fields, response) {
  if (!fields.projectName || !fields.skill || !fields.learnerWallet || !fields.evidenceUrl) {
    response.status(400).json({ error: 'Add a project name, skill, wallet, and evidence URL.' });
    return false;
  }
  if (!isPublicKey(fields.learnerWallet)) {
    response.status(400).json({ error: 'Enter a valid Solana wallet address.' });
    return false;
  }
  if (!validHttpUrl(fields.evidenceUrl)) {
    response.status(400).json({ error: 'Evidence must be a valid http or https link.' });
    return false;
  }
  return true;
}

function claimFor(record, issuerWallet, issuedAt) {
  return {
    version: 1,
    id: record.id,
    projectName: record.projectName,
    skill: record.skill,
    learnerWallet: record.learnerWallet,
    evidenceUrl: record.evidenceUrl,
    evidenceRef: record.evidenceRef,
    rubricVersion: 'v1',
    rubric: record.rubric,
    reviewerNote: record.reviewerNote,
    issuedAt,
    issuerWallet,
  };
}

function hashClaim(claim) {
  return createHash('sha256').update(JSON.stringify(claim)).digest('hex');
}

async function fetchDevnetTransaction(signature) {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'buildproof',
      method: 'getTransaction',
      params: [signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }],
    }),
  });
  if (!response.ok) throw new Error(`Devnet RPC returned HTTP ${response.status}.`);
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message || 'Devnet RPC returned an error.');
  return payload.result;
}

function publicRecord(record) {
  const { ownerId: _ownerId, ...visible } = record;
  return visible;
}

function publicInterviewProof(record) {
  return {
    id: record.id,
    status: record.status,
    subjectWallet: record.subjectWallet,
    issuedAt: record.issuedAt,
    manifest: record.manifest,
    manifestHash: record.manifestHash,
    signature: record.signature,
    chainSlot: record.chainSlot,
    chainTime: record.chainTime,
  };
}

app.get('/api/health', (_request, response) => {
  response.json({ ok: true, network: 'devnet' });
});

app.post('/api/solana/rpc', guestRateLimit({ key: 'rpc', max: 120, windowMs: 60_000 }), async (request, response) => {
  const payload = request.body;
  if (!payload || payload.jsonrpc !== '2.0' || !browserRpcMethods.has(payload.method)) {
    return response.status(400).json({ error: 'This Solana RPC method is not available through BuildProof.' });
  }
  try {
    const upstream = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });
    const result = await upstream.json();
    if (!upstream.ok) return response.status(502).json({ error: 'The Devnet RPC request failed.' });
    return response.json(result);
  } catch {
    return response.status(502).json({ error: 'The Devnet RPC service could not be reached.' });
  }
});

app.get('/api/ai/status', (_request, response) => {
  response.json(interviewService.status());
});

app.get('/api/interviews', (_request, response) => {
  response.json(getInterviewService(_request).listSavedInterviews(_request.contextpulseOwnerId));
});

app.get('/api/interviews/:id', (request, response) => {
  const service = getInterviewService(request);
  const session = service.getSession(request.params.id, request.contextpulseOwnerId);
  if (!session) {
    const completed = service.getCompletedBySessionId(request.params.id, request.contextpulseOwnerId);
    if (completed) return response.json({ complete: true, reportId: completed.id });
    return response.status(404).json({ error: 'Saved interview not found.' });
  }
  delete session.ownerId;
  response.json(session);
});

app.get('/api/interview-reports/:id', async (request, response, next) => {
  try {
    const service = getInterviewService(request);
    const report = service.getCompletedReport(request.params.id, request.contextpulseOwnerId);
    if (!report) return response.status(404).json({ error: 'Saved interview report not found.' });
    const proofs = await readInterviewProofs();
    const issuedProof = proofs.find((record) => record.reportId === report.id && record.status === 'issued');
    delete report.ownerId;
    response.json({ ...report, publishedProof: issuedProof ? publicInterviewProof(issuedProof) : null });
  } catch (error) {
    return next(error);
  }
});

app.delete('/api/interview-reports/:id', async (request, response, next) => {
  try {
    response.json({ deleted: await getInterviewService(request).discardCompletedReport(request.params.id, request.contextpulseOwnerId) });
  } catch (error) { next(error); }
});

app.post('/api/interviews', guestRateLimit({ key: 'interview-start', max: 3, windowMs: 60 * 60_000 }), async (request, response) => {
  try {
    const interview = await getInterviewService(request).start({ ...(request.body || {}), ownerId: request.contextpulseOwnerId });
    response.status(201).json(interview);
  } catch (error) {
    if (error instanceof InterviewServiceError) return response.status(error.status).json({ error: error.message });
    return response.status(502).json({ error: 'Gemini could not start this interview. Check the connection and try again.' });
  }
});

app.post('/api/interviews/:id/answer', guestRateLimit({ key: 'interview-answer', max: 30, windowMs: 60 * 60_000 }), async (request, response) => {
  try {
    const result = await getInterviewService(request).answer(request.params.id, request.body?.answer, request.contextpulseOwnerId);
    response.json(result);
  } catch (error) {
    if (error instanceof InterviewServiceError) return response.status(error.status).json({ error: error.message });
    return response.status(502).json({ error: 'Gemini could not continue this interview. Please retry.' });
  }
});

app.delete('/api/interviews/:id', async (request, response, next) => {
  try {
    response.json({ deleted: await getInterviewService(request).discard(request.params.id, request.contextpulseOwnerId) });
  } catch (error) { next(error); }
});

app.post('/api/interview-proofs/drafts', async (request, response, next) => {
  try {
    if (request.body?.consentToPublish !== true) {
      return response.status(400).json({ error: 'Confirm that you want to publish this interview report before anchoring it.' });
    }
    const reportId = cleanText(request.body?.reportId, 80);
    const subjectWallet = cleanText(request.body?.subjectWallet, 64);
    if (!reportId || !isPublicKey(subjectWallet)) {
      return response.status(400).json({ error: 'The completed interview and a valid Solana wallet are required.' });
    }
    const completed = getInterviewService(request).getCompletedReport(reportId, request.contextpulseOwnerId);
    if (!completed) return response.status(404).json({ error: 'The completed interview expired. Start another interview to create a proof.' });

    const records = await readInterviewProofs();
    const existing = records.find((record) => record.reportId === reportId);
    if (existing) {
      if (existing.status === 'issued') {
        if (existing.subjectWallet !== subjectWallet) {
          return response.status(409).json({ error: 'This interview report is already anchored by a different wallet.' });
        }
        return response.json({ status: 'issued', proofId: existing.id, proof: publicInterviewProof(existing), reused: true });
      }
      if (existing.status !== 'pending' || !isInterviewProofManifest(existing.manifest) ||
          existing.manifest.subjectWallet !== existing.subjectWallet ||
          hashInterviewManifest(existing.manifest) !== existing.manifestHash) {
        return response.status(409).json({ error: 'The existing proof draft is invalid and cannot be resumed.' });
      }
      if (existing.subjectWallet !== subjectWallet) {
        return response.status(409).json({ error: 'A proof draft for this interview belongs to another wallet. Reconnect the wallet that started it to continue.' });
      }
      return response.json({
        status: 'pending',
        proofId: existing.id,
        manifest: existing.manifest,
        manifestHash: existing.manifestHash,
        memo: interviewMemoForHash(existing.manifestHash),
        reused: true,
      });
    }
    const issuedAt = new Date().toISOString();
    const manifest = createInterviewManifest({
      proofId: crypto.randomUUID(),
      subjectWallet,
      issuedAt,
      model: completed.model,
      questionCount: completed.questionCount,
      report: completed.report,
    });
    const manifestHash = hashInterviewManifest(manifest);
    const record = {
      id: manifest.proofId,
      reportId,
      ...(request.contextpulseOwnerId ? { ownerId: request.contextpulseOwnerId } : {}),
      status: 'pending',
      subjectWallet,
      issuedAt,
      manifest,
      manifestHash,
      signature: null,
      chainSlot: null,
      chainTime: null,
    };
    records.push(record);
    await writeInterviewProofs(records);
    return response.status(201).json({
      status: 'pending',
      proofId: record.id,
      manifest,
      manifestHash,
      memo: interviewMemoForHash(manifestHash),
      reused: false,
    });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/interview-proofs/:id/issue', async (request, response, next) => {
  try {
    const signature = cleanText(request.body?.signature, 100);
    if (!/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signature)) {
      return response.status(400).json({ error: 'A valid Devnet transaction signature is required.' });
    }
    const records = await readInterviewProofs();
    const record = records.find((item) => item.id === request.params.id);
    if (!record) return response.status(404).json({ error: 'Interview proof draft not found.' });
    if (request.contextpulseOwnerId && record.ownerId !== request.contextpulseOwnerId) return response.status(404).json({ error: 'Interview proof draft not found.' });
    if (record.status === 'issued') {
      if (record.signature === signature) return response.json(publicInterviewProof(record));
      return response.status(409).json({ error: 'This interview report already has an on-chain proof.' });
    }
    if (record.status !== 'pending' || !isInterviewProofManifest(record.manifest) || hashInterviewManifest(record.manifest) !== record.manifestHash) {
      return response.status(409).json({ error: 'The interview proof draft is invalid or no longer available.' });
    }
    const transaction = await fetchDevnetTransaction(signature);
    if (!transaction || transaction.meta?.err) {
      return response.status(422).json({ error: 'Devnet has not confirmed this transaction yet.' });
    }
    const signedByCandidate = transaction.transaction.message.accountKeys.some((key) => key.pubkey === record.subjectWallet && key.signer);
    const memo = transaction.transaction.message.instructions.find((instruction) => instruction.programId === memoProgram);
    if (!signedByCandidate || memo?.parsed !== interviewMemoForHash(record.manifestHash)) {
      return response.status(422).json({ error: 'The Devnet transaction does not contain this candidate-signed interview report hash.' });
    }
    record.status = 'issued';
    record.signature = signature;
    record.chainSlot = Number.isInteger(transaction.slot) ? transaction.slot : null;
    record.chainTime = Number.isInteger(transaction.blockTime) ? new Date(transaction.blockTime * 1000).toISOString() : null;
    await writeInterviewProofs(records);
    return response.status(201).json(publicInterviewProof(record));
  } catch (error) {
    return next(error);
  }
});

app.get('/api/interview-proofs/:id', async (request, response, next) => {
  try {
    const records = await readInterviewProofs();
    const record = records.find((item) => item.id === request.params.id && item.status === 'issued');
    if (!record) return response.status(404).json({ error: 'Issued interview proof not found.' });
    if (!isInterviewProofManifest(record.manifest) || hashInterviewManifest(record.manifest) !== record.manifestHash) {
      return response.status(409).json({ error: 'The saved interview report failed its integrity check.' });
    }
    return response.json(publicInterviewProof(record));
  } catch (error) {
    return next(error);
  }
});

app.get('/api/submissions', async (_request, response, next) => {
  try {
    const records = await readStore();
    response.json(records.filter((record) => !_request.contextpulseOwnerId || record.ownerId === _request.contextpulseOwnerId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicRecord));
  } catch (error) {
    next(error);
  }
});

app.post('/api/submissions', guestRateLimit({ key: 'submission-create', max: 10, windowMs: 60 * 60_000 }), async (request, response, next) => {
  try {
    const fields = submissionFields(request.body);
    if (!validateSubmissionFields(fields, response)) return;
    const records = await readStore();
    const record = {
      id: crypto.randomUUID(),
      ...fields,
      ...(request.contextpulseOwnerId ? { ownerId: request.contextpulseOwnerId } : {}),
      rubric: { worksAsShown: false, learnerContribution: false, skillFit: false },
      reviewerNote: '',
      status: 'pending',
      createdAt: new Date().toISOString(),
      reviewedAt: null,
      issuedAt: null,
      issuerWallet: null,
      claimHash: null,
      signature: null,
    };
    records.push(record);
    await writeStore(records);
    return response.status(201).json(publicRecord(record));
  } catch (error) {
    return next(error);
  }
});

app.patch('/api/submissions/:id', async (request, response, next) => {
  try {
    const fields = submissionFields(request.body);
    if (!validateSubmissionFields(fields, response)) return;
    const records = await readStore();
    const record = records.find((item) => item.id === request.params.id && (!request.contextpulseOwnerId || item.ownerId === request.contextpulseOwnerId));
    if (!record) return response.status(404).json({ error: 'Submission not found.' });
    if (record.status !== 'rejected') return response.status(409).json({ error: 'Only a submission with requested changes can be edited.' });
    Object.assign(record, fields, {
      status: 'pending',
      rubric: { worksAsShown: false, learnerContribution: false, skillFit: false },
      reviewerNote: '',
      reviewedAt: null,
    });
    await writeStore(records);
    return response.json(publicRecord(record));
  } catch (error) {
    return next(error);
  }
});

app.post('/api/submissions/:id/review', async (request, response, next) => {
  try {
    const decision = request.body?.decision;
    const reviewerNote = cleanText(request.body?.reviewerNote, 500);
    const rubric = request.body?.rubric;
    if (!['approved', 'rejected', 'pending'].includes(decision)) {
      return response.status(400).json({ error: 'Choose approve or request changes.' });
    }
    const records = await readStore();
    const record = records.find((item) => item.id === request.params.id && (!request.contextpulseOwnerId || item.ownerId === request.contextpulseOwnerId));
    if (!record) return response.status(404).json({ error: 'Submission not found.' });
    if (record.status === 'issued') return response.status(409).json({ error: 'An issued proof cannot be reviewed again.' });
    if (decision === 'pending' && record.status !== 'rejected') {
      return response.status(409).json({ error: 'Only a submission with requested changes can return to review.' });
    }
    if (decision === 'approved' && (!rubric || !rubric.worksAsShown || !rubric.learnerContribution || !rubric.skillFit)) {
      return response.status(400).json({ error: 'All three review checks must pass before approval.' });
    }
    record.status = decision;
    record.rubric = {
      worksAsShown: Boolean(rubric?.worksAsShown),
      learnerContribution: Boolean(rubric?.learnerContribution),
      skillFit: Boolean(rubric?.skillFit),
    };
    record.reviewerNote = reviewerNote;
    record.reviewedAt = decision === 'pending' ? null : new Date().toISOString();
    await writeStore(records);
    return response.json(publicRecord(record));
  } catch (error) {
    return next(error);
  }
});

app.post('/api/submissions/:id/issue', async (request, response, next) => {
  try {
    const records = await readStore();
    const record = records.find((item) => item.id === request.params.id && (!request.contextpulseOwnerId || item.ownerId === request.contextpulseOwnerId));
    if (!record) return response.status(404).json({ error: 'Submission not found.' });
    if (record.status !== 'approved') return response.status(409).json({ error: 'Approve the submission before issuing proof.' });
    if (record.signature) return response.status(409).json({ error: 'This submission already has an on-chain proof.' });

    const signature = cleanText(request.body?.signature, 100);
    const issuerWallet = cleanText(request.body?.issuerWallet, 64);
    const issuedAt = cleanText(request.body?.issuedAt, 40);
    const claimHash = cleanText(request.body?.claimHash, 64).toLowerCase();
    if (!signature || !isPublicKey(issuerWallet) || !/^\d{4}-\d\d-\d\dT/.test(issuedAt) || !/^[a-f0-9]{64}$/.test(claimHash)) {
      return response.status(400).json({ error: 'The signed proof details are incomplete.' });
    }
    const issuedMilliseconds = Date.parse(issuedAt);
    if (!Number.isFinite(issuedMilliseconds) || Math.abs(Date.now() - issuedMilliseconds) > 5 * 60_000) {
      return response.status(400).json({ error: 'The proof timestamp is stale. Please issue it again.' });
    }
    const expectedHash = hashClaim(claimFor(record, issuerWallet, issuedAt));
    if (expectedHash !== claimHash) {
      return response.status(400).json({ error: 'The proof details changed after signing. Please issue it again.' });
    }

    const transaction = await fetchDevnetTransaction(signature);
    if (!transaction || transaction.meta?.err) {
      return response.status(422).json({ error: 'Devnet has not confirmed this transaction yet.' });
    }
    const signedByIssuer = transaction.transaction.message.accountKeys.some((key) => key.pubkey === issuerWallet && key.signer);
    const memo = transaction.transaction.message.instructions.find((instruction) => instruction.programId === memoProgram);
    if (!signedByIssuer || !memo || memo.parsed !== `BuildProof:v1:${claimHash}`) {
      return response.status(422).json({ error: 'The Devnet transaction does not contain this signed BuildProof claim.' });
    }

    record.status = 'issued';
    record.issuerWallet = issuerWallet;
    record.issuedAt = issuedAt;
    record.claimHash = claimHash;
    record.signature = signature;
    await writeStore(records);
    return response.json(publicRecord(record));
  } catch (error) {
    return next(error);
  }
});

app.get('/api/proofs/:id', async (request, response, next) => {
  try {
    const records = await readStore();
    const record = records.find((item) => item.id === request.params.id && item.status === 'issued');
    if (!record) return response.status(404).json({ error: 'Issued proof not found.' });
    return response.json(publicRecord(record));
  } catch (error) {
    return next(error);
  }
});

if (!cloudflareEnv && runtimeEnvironment.NODE_ENV !== 'production' && vite) {
  const serveApp = async (request, response, next) => {
    try {
      const template = await readFile(path.join(root, 'src', 'index.html'), 'utf8');
      response.status(200).type('html').send(await vite.transformIndexHtml(request.originalUrl, template));
    } catch (error) {
      next(error);
    }
  };
  app.get('/', serveApp);
  app.get(/^\/(interview\/?|interviews\/[^/]+\/?|reports\/[^/]+\/?|review\/?|proofs\/?)$/, serveApp);
  app.use(vite.middlewares);
} else if (!cloudflareEnv && runtimeEnvironment.NODE_ENV === 'production') {
  app.use(express.static(path.join(root, 'dist')));
  app.get(/.*/, (_request, response) => response.sendFile(path.join(root, 'dist', 'index.html')));
}

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({ error: 'The BuildProof service could not finish this request.' });
});

return { app, ready: interviewService.ready, port, host };
}

