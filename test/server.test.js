import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createInterviewManifest, hashInterviewManifest, interviewMemoForHash } from '../server/services/interview-proof.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let processHandle;
let port;
let dataDir;
let baseUrl;
let mockRpc;
let mockRpcUrl;
let rpcMemo = '';
const issuerWallet = '11111111111111111111111111111111';
let rpcSignerWallet = issuerWallet;
const memoProgram = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port: assigned } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return assigned;
}

async function startServer(overrides = {}) {
  port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  processHandle = spawn(process.execPath, ['server/local.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), BUILDPROOF_DATA_DIR: dataDir, HOST: '127.0.0.1', SOLANA_RPC_URL: mockRpcUrl, ...overrides },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  processHandle.stdout.on('data', (chunk) => { output += chunk; });
  processHandle.stderr.on('data', (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (processHandle.exitCode !== null) throw new Error(`Server exited before starting:\n${output}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch { /* Wait for Vite and Express to start. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not start:\n${output}`);
}

async function stopServer() {
  if (!processHandle || processHandle.exitCode !== null) return;
  processHandle.kill('SIGTERM');
  await Promise.race([once(processHandle, 'exit'), new Promise((resolve) => setTimeout(resolve, 2000))]);
}

test('submission review requires all checks and survives a server restart', async (t) => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'buildproof-test-'));
  const savedProfile = { candidateSummary: 'Durable interview test', skills: [], projectClaims: [] };
  const savedSessionId = 'saved-session-for-route-test';
  const savedReportId = 'saved-report-for-route-test';
  await writeFile(path.join(dataDir, 'interviews.json'), `${JSON.stringify({
    version: 1,
    sessions: [{
      id: savedSessionId, profile: savedProfile, history: [],
      currentQuestion: { question: 'How did you test recovery?', focus: 'Reliability' },
      language: 'en', pendingAnswer: 'I would retry after rollback.', createdAt: 100, updatedAt: 200,
    }],
    reports: [{
      id: savedReportId, sourceSessionId: 'completed-session', model: 'gemini-3.8-flash', questionCount: 5,
      profile: savedProfile, history: [{ question: 'How?', focus: 'Reliability', answer: 'I used a health check.' }],
      report: { summary: 'Durable report', criteria: [], strengths: [], areasToExplore: [], evidenceCoverage: 'low', scope: 'Test only.' },
      createdAt: 100, updatedAt: 300,
    }],
  }, null, 2)}\n`, { mode: 0o600 });
  const rpcPort = await freePort();
  mockRpcUrl = `http://127.0.0.1:${rpcPort}`;
  mockRpc = createHttpServer(async (request, response) => {
    for await (const _chunk of request) { /* Drain the JSON-RPC request body. */ }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      jsonrpc: '2.0', id: 'buildproof', result: {
        slot: 123,
        blockTime: 1791691200,
        meta: { err: null },
        transaction: { message: {
          accountKeys: [{ pubkey: rpcSignerWallet, signer: true }],
          instructions: [{ programId: memoProgram, parsed: rpcMemo }],
        } },
      },
    }));
  });
  mockRpc.listen(rpcPort, '127.0.0.1');
  await once(mockRpc, 'listening');
  t.after(async () => {
    await stopServer();
    await new Promise((resolve) => mockRpc.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  await startServer();

  const home = await fetch(baseUrl);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /BuildProof/);

  for (const route of ['/interview', `/interviews/${savedSessionId}`, `/reports/${savedReportId}`, '/review', '/proofs']) {
    const page = await fetch(`${baseUrl}${route}`);
    assert.equal(page.status, 200, `page route ${route} should load directly`);
    assert.match(await page.text(), /BuildProof/);
  }
  const savedListResponse = await fetch(`${baseUrl}/api/interviews`);
  assert.deepEqual(await savedListResponse.json(), {
    active: [{ id: savedSessionId, status: 'active', candidateSummary: 'Durable interview test', answerCount: 0, updatedAt: 200 }],
    completed: [{ id: savedReportId, status: 'complete', candidateSummary: 'Durable interview test', answerCount: 1, updatedAt: 300 }],
  });
  assert.equal((await (await fetch(`${baseUrl}/api/interviews/${savedSessionId}`)).json()).pendingAnswer, 'I would retry after rollback.');
  const savedReportBeforeIssue = await (await fetch(`${baseUrl}/api/interview-reports/${savedReportId}`)).json();
  assert.equal(savedReportBeforeIssue.report.summary, 'Durable report');
  assert.equal(savedReportBeforeIssue.publishedProof, null);

  const rpcProxyResponse = await fetch(`${baseUrl}/api/solana/rpc`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLatestBlockhash', params: [] }),
  });
  assert.equal(rpcProxyResponse.status, 200);
  const rpcProxyDenied = await fetch(`${baseUrl}/api/solana/rpc`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'requestAirdrop', params: [] }),
  });
  assert.equal(rpcProxyDenied.status, 400);

  const invalid = await fetch(`${baseUrl}/api/submissions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectName: 'Demo', skill: 'React', learnerWallet: 'not-a-wallet', evidenceUrl: 'https://example.com' }),
  });
  assert.equal(invalid.status, 400);

  const createdResponse = await fetch(`${baseUrl}/api/submissions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectName: 'Accessible landing page', skill: 'React',
      learnerWallet: '11111111111111111111111111111111',
      evidenceUrl: 'https://github.com/example/project/commit/abc123', evidenceRef: 'abc123',
    }),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();

  const incompleteApproval = await fetch(`${baseUrl}/api/submissions/${created.id}/review`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: 'approved', rubric: { worksAsShown: true, learnerContribution: false, skillFit: true } }),
  });
  assert.equal(incompleteApproval.status, 400);

  const rejected = await fetch(`${baseUrl}/api/submissions/${created.id}/review`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: 'rejected', reviewerNote: 'Please add a stable commit reference.', rubric: {} }),
  });
  assert.equal(rejected.status, 200);
  assert.equal((await rejected.json()).status, 'rejected');

  const revised = await fetch(`${baseUrl}/api/submissions/${created.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectName: 'Accessible landing page', skill: 'React accessibility',
      learnerWallet: '11111111111111111111111111111111',
      evidenceUrl: 'https://github.com/example/project/commit/def456', evidenceRef: 'def456',
    }),
  });
  assert.equal(revised.status, 200);
  const updatedRecord = await revised.json();
  assert.equal(updatedRecord.status, 'pending');
  assert.equal(updatedRecord.evidenceRef, 'def456');

  const approved = await fetch(`${baseUrl}/api/submissions/${created.id}/review`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: 'approved', rubric: { worksAsShown: true, learnerContribution: true, skillFit: true }, reviewerNote: 'Runs and matches the stated React skill.' }),
  });
  assert.equal(approved.status, 200);
  const approvedRecord = await approved.json();
  assert.equal(approvedRecord.status, 'approved');

  const issueBeforeChainReceipt = await fetch(`${baseUrl}/api/submissions/${created.id}/issue`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signature: '', issuerWallet: '', issuedAt: '', claimHash: '' }),
  });
  assert.equal(issueBeforeChainReceipt.status, 400);

  const issuedAt = new Date().toISOString();
  const claim = {
    version: 1,
    id: approvedRecord.id,
    projectName: approvedRecord.projectName,
    skill: approvedRecord.skill,
    learnerWallet: approvedRecord.learnerWallet,
    evidenceUrl: approvedRecord.evidenceUrl,
    evidenceRef: approvedRecord.evidenceRef,
    rubricVersion: 'v1',
    rubric: approvedRecord.rubric,
    reviewerNote: approvedRecord.reviewerNote,
    issuedAt,
    issuerWallet,
  };
  const claimHash = createHash('sha256').update(JSON.stringify(claim)).digest('hex');
  const issuePayload = { signature: 'mock-devnet-signature', issuerWallet, issuedAt, claimHash };
  rpcMemo = `BuildProof:v1:${'0'.repeat(64)}`;
  const mismatchedReceipt = await fetch(`${baseUrl}/api/submissions/${created.id}/issue`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(issuePayload),
  });
  assert.equal(mismatchedReceipt.status, 422);

  rpcMemo = `BuildProof:v1:${claimHash}`;
  const issuedResponse = await fetch(`${baseUrl}/api/submissions/${created.id}/issue`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(issuePayload),
  });
  assert.equal(issuedResponse.status, 200);
  const issued = await issuedResponse.json();
  assert.equal(issued.status, 'issued');
  assert.equal(issued.claimHash, claimHash);

  const publicProofResponse = await fetch(`${baseUrl}/api/proofs/${created.id}`);
  assert.equal(publicProofResponse.status, 200);
  assert.equal((await publicProofResponse.json()).issuerWallet, issuerWallet);

  const unapprovedDraft = await fetch(`${baseUrl}/api/interview-proofs/drafts`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reportId: 'missing', subjectWallet: issuerWallet, consentToPublish: false }),
  });
  assert.equal(unapprovedDraft.status, 400);

  const interviewManifest = createInterviewManifest({
    proofId: '123e4567-e89b-12d3-a456-426614174000',
    subjectWallet: issuerWallet,
    issuedAt: new Date().toISOString(),
    model: 'gemini-3.8-flash',
    questionCount: 5,
    salt: 'a'.repeat(64),
    report: {
      summary: 'A public summary.',
      criteria: [{ name: 'Technical accuracy', score: 4, observation: 'Supported by the answer.', evidenceTurn: 5, evidenceQuote: 'I tested the fallback path.' }],
      strengths: ['Explains trade-offs.'],
      areasToExplore: ['Test retry behavior.'],
      evidenceCoverage: 'medium',
      scope: 'A limited interview snapshot.',
      privateTranscript: 'This field must not be published.',
    },
  });
  assert.equal('privateTranscript' in interviewManifest.assessment.report, false);
  const interviewManifestHash = hashInterviewManifest(interviewManifest);
  const interviewProofId = interviewManifest.proofId;
  const interviewProofRecord = {
    id: interviewProofId,
    reportId: savedReportId,
    status: 'pending',
    subjectWallet: issuerWallet,
    issuedAt: interviewManifest.issuedAt,
    manifest: interviewManifest,
    manifestHash: interviewManifestHash,
    signature: null,
    chainSlot: null,
    chainTime: null,
  };
  await writeFile(path.join(dataDir, 'interview-proofs.json'), `${JSON.stringify([interviewProofRecord])}\n`, { mode: 0o600 });
  const resumedDraftResponse = await fetch(`${baseUrl}/api/interview-proofs/drafts`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reportId: savedReportId, subjectWallet: issuerWallet, consentToPublish: true }),
  });
  assert.equal(resumedDraftResponse.status, 200);
  const resumedDraft = await resumedDraftResponse.json();
  assert.equal(resumedDraft.status, 'pending');
  assert.equal(resumedDraft.reused, true);
  assert.equal(resumedDraft.proofId, interviewProofId);
  assert.equal(resumedDraft.manifestHash, interviewManifestHash);
  assert.equal(resumedDraft.memo, interviewMemoForHash(interviewManifestHash));

  const wrongWalletResume = await fetch(`${baseUrl}/api/interview-proofs/drafts`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reportId: savedReportId, subjectWallet: 'Vote111111111111111111111111111111111111111', consentToPublish: true }),
  });
  assert.equal(wrongWalletResume.status, 409);
  assert.match((await wrongWalletResume.json()).error, /belongs to another wallet/i);

  const interviewSignature = '1'.repeat(88);
  const pendingInterviewResponse = await fetch(`${baseUrl}/api/interview-proofs/${interviewProofId}`);
  assert.equal(pendingInterviewResponse.status, 404);
  rpcMemo = interviewMemoForHash('0'.repeat(64));
  const mismatchedInterviewReceipt = await fetch(`${baseUrl}/api/interview-proofs/${interviewProofId}/issue`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signature: interviewSignature }),
  });
  assert.equal(mismatchedInterviewReceipt.status, 422);
  rpcMemo = interviewMemoForHash(interviewManifestHash);
  rpcSignerWallet = 'Vote111111111111111111111111111111111111111';
  const wrongInterviewSigner = await fetch(`${baseUrl}/api/interview-proofs/${interviewProofId}/issue`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signature: interviewSignature }),
  });
  assert.equal(wrongInterviewSigner.status, 422);
  rpcSignerWallet = issuerWallet;
  const interviewIssueResponse = await fetch(`${baseUrl}/api/interview-proofs/${interviewProofId}/issue`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signature: interviewSignature }),
  });
  assert.equal(interviewIssueResponse.status, 201);
  const issuedInterviewProof = await interviewIssueResponse.json();
  assert.equal(issuedInterviewProof.status, 'issued');
  assert.equal(issuedInterviewProof.manifestHash, interviewManifestHash);
  assert.equal('reportId' in issuedInterviewProof, false);

  const alreadyIssuedDraftResponse = await fetch(`${baseUrl}/api/interview-proofs/drafts`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reportId: savedReportId, subjectWallet: issuerWallet, consentToPublish: true }),
  });
  assert.equal(alreadyIssuedDraftResponse.status, 200);
  const alreadyIssuedDraft = await alreadyIssuedDraftResponse.json();
  assert.equal(alreadyIssuedDraft.status, 'issued');
  assert.equal(alreadyIssuedDraft.reused, true);
  assert.equal(alreadyIssuedDraft.proof.signature, interviewSignature);

  const savedReportAfterIssue = await (await fetch(`${baseUrl}/api/interview-reports/${savedReportId}`)).json();
  assert.equal(savedReportAfterIssue.publishedProof.status, 'issued');
  assert.equal(savedReportAfterIssue.publishedProof.signature, interviewSignature);

  const publicInterviewProofResponse = await fetch(`${baseUrl}/api/interview-proofs/${interviewProofId}`);
  assert.equal(publicInterviewProofResponse.status, 200);
  const publicInterviewProof = await publicInterviewProofResponse.json();
  assert.equal(publicInterviewProof.manifest.assessment.report.summary, 'A public summary.');
  assert.equal('privateTranscript' in publicInterviewProof.manifest.assessment.report, false);

  await stopServer();
  await startServer();
  const listResponse = await fetch(`${baseUrl}/api/submissions`);
  const list = await listResponse.json();
  assert.equal(list.length, 1);
  assert.equal(list[0].status, 'issued');
  assert.equal(list[0].projectName, 'Accessible landing page');
  const restoredInterviewProof = await fetch(`${baseUrl}/api/interview-proofs/${interviewProofId}`);
  assert.equal(restoredInterviewProof.status, 200);
  assert.equal((await restoredInterviewProof.json()).manifestHash, interviewManifestHash);
  assert.equal((await (await fetch(`${baseUrl}/api/interviews/${savedSessionId}`)).json()).currentQuestion.question, 'How did you test recovery?');
  assert.equal((await (await fetch(`${baseUrl}/api/interview-reports/${savedReportId}`)).json()).history[0].answer, 'I used a health check.');
});

test('public demo keeps saved interview and review data isolated per browser', async (t) => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'buildproof-public-test-'));
  const secret = 'test-session-secret-with-at-least-thirty-two-bytes';
  const visitorA = 'c4c0ba41-570b-4b92-8ab6-fd65297f0f22';
  const visitorB = 'aec1dcad-5f25-4cd5-9bd4-b0b5981519ce';
  const cookie = (id) => `buildproof_guest=${id}.${createHmac('sha256', secret).update(id).digest('base64url')}`;
  await writeFile(path.join(dataDir, 'interviews.json'), `${JSON.stringify({
    version: 1,
    sessions: [{ id: 'private-session-a', ownerId: visitorA, profile: { candidateSummary: 'Visitor A profile', skills: [], projectClaims: [] }, history: [], currentQuestion: { question: 'Question?', focus: 'Test' }, createdAt: 100, updatedAt: 200 }],
    reports: [{ id: 'private-report-a', sourceSessionId: 'done-a', ownerId: visitorA, model: 'gemini-3.8-flash', questionCount: 5, profile: { candidateSummary: 'Visitor A report', skills: [], projectClaims: [] }, history: [], report: { summary: 'Private answer evidence' }, createdAt: 100, updatedAt: 300 }],
  })}\n`);
  await writeFile(path.join(dataDir, 'submissions.json'), `${JSON.stringify([{ id: 'private-submission-a', ownerId: visitorA, projectName: 'Visitor A project', skill: 'Testing', createdAt: '2026-10-11T00:00:00.000Z' }])}\n`);
  t.after(async () => {
    await stopServer();
    await rm(dataDir, { recursive: true, force: true });
  });
  await startServer({ PUBLIC_DEMO_MODE: '1', BUILDPROOF_SESSION_SECRET: secret });

  const requestAs = (path, id) => fetch(`${baseUrl}${path}`, { headers: { Cookie: cookie(id) } });
  const aList = await (await requestAs('/api/interviews', visitorA)).json();
  assert.equal(aList.active[0].id, 'private-session-a');
  assert.equal(aList.completed[0].id, 'private-report-a');
  assert.equal('ownerId' in aList.active[0], false);
  assert.deepEqual(await (await requestAs('/api/interviews', visitorB)).json(), { active: [], completed: [] });
  assert.equal((await requestAs('/api/interviews/private-session-a', visitorB)).status, 404);
  assert.equal((await requestAs('/api/interview-reports/private-report-a', visitorB)).status, 404);
  assert.deepEqual(await (await requestAs('/api/submissions', visitorB)).json(), []);
  const aSubmissions = await (await requestAs('/api/submissions', visitorA)).json();
  assert.equal(aSubmissions[0].projectName, 'Visitor A project');
  assert.equal('ownerId' in aSubmissions[0], false);

  const newVisitor = await fetch(`${baseUrl}/api/interviews`);
  assert.match(newVisitor.headers.get('set-cookie') || '', /buildproof_guest=.*; Path=\/; HttpOnly; Secure; SameSite=Lax/);
});
