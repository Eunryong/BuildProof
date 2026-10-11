import { Connection, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { detectSolanaWallet, walletUnavailableMessage } from './wallet.js';
import './style.css';

const RPC_URL = new URL('/api/solana/rpc', location.origin).toString();
const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const connection = new Connection(RPC_URL, 'confirmed');
const app = document.querySelector('#app');
const isPublicDemo = window.BUILDPROOF_PUBLIC_DEMO === true;
function initialView() {
  if (new URLSearchParams(location.search).has('proof') || new URLSearchParams(location.search).has('interview-proof')) return 'verification';
  if (/^\/proofs\/?$/.test(location.pathname) || location.hash === '#proofs') return 'proofs';
  if (/^\/review\/?$/.test(location.pathname) || location.hash === '#review') return 'review';
  return 'interview';
}

const state = {
  records: [],
  selectedId: null,
  view: initialView(),
  savedInterviews: { active: [], completed: [] },
  wallet: null,
  walletProvider: null,
  busy: false,
  editingId: null,
  notice: null,
  verification: null,
  interviewProofRecord: null,
  interviewProofError: '',
  interviewProofLoading: false,
  ai: { configured: false, model: 'gemini-3.8-flash' },
  interview: {
    phase: 'idle',
    id: null,
    profile: null,
    question: null,
    history: [],
    report: null,
    reportId: null,
    publishConsent: false,
    publishedProof: null,
    pendingProofDraft: null,
    pendingProofSubmission: null,
    resumeText: '',
    resumeFile: null,
    resumeUrl: '',
    draftAnswer: '',
    busy: false,
  },
};

const rubricLabels = [
  ['worksAsShown', 'It works as shown', 'The evidence opens and demonstrates the submitted project.'],
  ['learnerContribution', 'The learner’s contribution is clear', 'The submission points to work they can reasonably claim.'],
  ['skillFit', 'The work demonstrates this skill', 'The project shows practical use of the selected skill.'],
];

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function shortKey(value = '') {
  return value ? `${value.slice(0, 5)}…${value.slice(-5)}` : 'Wallet not set';
}

function dateLabel(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value));
}

function recordById(id = state.selectedId) {
  return state.records.find((record) => record.id === id) || null;
}

function setNotice(message, kind = 'info') {
  state.notice = { message, kind };
  render();
  window.setTimeout(() => {
    if (state.notice?.message === message) {
      state.notice = null;
      render();
    }
  }, 5000);
}

function setPersistentNotice(message, kind = 'info', action = null) {
  state.notice = { message, kind, action };
  render();
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'The request could not be completed.');
  return body;
}

async function loadRecords(keepSelection = true) {
  const previousSelection = keepSelection ? state.selectedId : null;
  state.records = await api('/api/submissions');
  state.selectedId = state.records.some((record) => record.id === previousSelection)
    ? previousSelection
    : state.records.find((record) => record.status !== 'issued')?.id || state.records[0]?.id || null;
}

function statusLabel(status) {
  return ({ pending: 'Awaiting review', approved: 'Ready to issue', rejected: 'Changes requested', issued: 'Issued' })[status] || status;
}

function navLink(view, label, count, icon) {
  const href = view === 'interview' ? '/interview' : view === 'proofs' ? '/proofs' : '/review';
  return `<a class="side-link ${state.view === view ? 'is-active' : ''}" href="${href}">
    <span class="side-icon">${icon}</span><span>${label}</span>${count ? `<span class="side-count">${count}</span>` : ''}
  </a>`;
}

function renderRecordList() {
  const records = state.view === 'proofs'
    ? state.records.filter((record) => record.status === 'issued')
    : state.records.filter((record) => record.status !== 'issued');
  if (!records.length) {
    return `<div class="empty-list"><span class="empty-glyph">⌁</span>
      <strong>${state.view === 'proofs' ? 'No proofs issued yet' : 'The review queue is clear'}</strong>
      <p>${state.view === 'proofs' ? 'Approved submissions will appear here after they are anchored on Devnet.' : 'Add a project submission to start a review.'}</p>
      ${state.view === 'review' ? '<button class="button button-small" data-action="open-submit">Submit evidence</button>' : ''}
    </div>`;
  }
  return records.map((record) => `<button class="submission-row ${state.selectedId === record.id ? 'is-selected' : ''}" data-select="${record.id}">
      <span class="row-status status-${record.status}">${record.status === 'issued' ? '●' : '◌'}</span>
      <span class="row-copy"><span class="row-title">${escapeHtml(record.projectName)}</span><span class="row-subtitle">${escapeHtml(record.skill)} · ${dateLabel(record.createdAt)}</span></span>
      <span class="row-arrow">↗</span>
    </button>`).join('');
}

function renderReview(record) {
  if (!record) return `<section class="empty-detail panel">
    <div class="empty-mark">BP<span>·</span></div><p class="eyebrow">BUILD PROOF / REVIEW DESK</p>
    <h2>Show what the work can do.</h2>
    <p>Submit a project link, review it against a clear rubric, then anchor a proof of the review on Solana Devnet.</p>
    <button class="button button-primary" data-action="open-submit">Submit project evidence <span>↗</span></button>
  </section>`;

  if (record.status === 'issued') return renderIssuedDetail(record);

  const checkRows = rubricLabels.map(([key, label, description]) => `<label class="rubric-item">
      <input type="checkbox" data-rubric="${key}" ${record.rubric?.[key] ? 'checked' : ''} ${record.status !== 'pending' ? 'disabled' : ''} />
      <span class="check-box" aria-hidden="true"></span><span class="rubric-copy"><strong>${label}</strong><small>${description}</small></span>
    </label>`).join('');
  const isApproved = record.status === 'approved';
  const evidenceHost = safeHost(record.evidenceUrl);
  return `<section class="detail-stack">
    <div class="detail-heading"><div><p class="eyebrow">${record.status === 'pending' ? 'INCOMING SUBMISSION' : 'REVIEW COMPLETE'}</p><h2>${escapeHtml(record.projectName)}</h2></div><span class="state-pill status-${record.status}"><i></i>${statusLabel(record.status)}</span></div>
    <div class="panel evidence-panel">
      <div class="panel-head"><div><p class="eyebrow">PROJECT EVIDENCE</p><h3>${escapeHtml(record.skill)}</h3></div><span class="evidence-mark">↗</span></div>
      <div class="evidence-meta"><span>Submitted ${dateLabel(record.createdAt)}</span><span>Recipient ${escapeHtml(shortKey(record.learnerWallet))}</span></div>
      <a class="evidence-link" href="${escapeHtml(record.evidenceUrl)}" target="_blank" rel="noreferrer"><span class="link-domain">${escapeHtml(evidenceHost)}</span><span class="link-url">${escapeHtml(record.evidenceUrl)}</span><span class="external-arrow">↗</span></a>
      ${record.evidenceRef ? `<p class="commit-ref"><span>COMMIT / VERSION</span><code>${escapeHtml(record.evidenceRef)}</code></p>` : '<p class="evidence-hint">A commit or version reference makes the reviewed snapshot easier to reproduce.</p>'}
    </div>
    <div class="panel rubric-panel">
      <div class="panel-head"><div><p class="eyebrow">REVIEW RUBRIC · V1</p><h3>Check the work, then approve.</h3></div><span class="rubric-count">${Object.values(record.rubric || {}).filter(Boolean).length}/3</span></div>
      <div class="rubric-list">${checkRows}</div>
      <label class="field-label note-label" for="reviewer-note">Reviewer note <span>Optional · included in the signed proof</span></label>
      <textarea id="reviewer-note" class="text-area" maxlength="500" placeholder="What did you verify in this submission?" ${record.status !== 'pending' ? 'disabled' : ''}>${escapeHtml(record.reviewerNote || '')}</textarea>
      ${record.status === 'rejected' ? `<div class="review-result result-rejected"><div><strong>Changes requested</strong><p>${escapeHtml(record.reviewerNote || 'Update the evidence and send it back for review.')}</p></div><button class="button button-small" data-action="edit-submission">Edit submission</button></div>` : ''}
      ${isApproved ? `<div class="review-result result-approved"><span class="approval-stamp">✓</span><div><strong>Review approved</strong><p>Connect the issuer wallet to create the Devnet proof.</p></div></div>` : ''}
      <div class="review-actions">
        ${record.status === 'pending' ? `<button class="button button-quiet" data-action="request-changes">Request changes</button><button class="button button-primary" data-action="approve" ${Object.values(record.rubric || {}).filter(Boolean).length < 3 ? 'disabled' : ''}>Approve review <span>→</span></button>` : ''}
        ${isApproved ? `<button class="button button-primary issue-button" data-action="issue" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Waiting for Devnet confirmation…' : state.wallet ? 'Issue proof on Devnet' : 'Connect issuer wallet to issue'} <span>↗</span></button>` : ''}
      </div>
    </div>
  </section>`;
}

function safeHost(value) {
  try { return new URL(value).hostname.replace(/^www\./, ''); } catch { return 'Project link'; }
}

function renderIssuedDetail(record) {
  const proofLink = `${location.origin}/?proof=${encodeURIComponent(record.id)}`;
  return `<section class="detail-stack">
    <div class="detail-heading"><div><p class="eyebrow">ISSUED PROOF</p><h2>${escapeHtml(record.projectName)}</h2></div><span class="state-pill status-issued"><i></i>Anchored on Devnet</span></div>
    <div class="proof-artifact">
      <div class="proof-topline"><span>BUILDPROOF / SKILL RECORD</span><span class="proof-seal">✓</span></div>
      <p class="proof-skill">${escapeHtml(record.skill)}</p>
      <div class="proof-owner"><span>BUILDER WALLET</span><code>${escapeHtml(shortKey(record.learnerWallet))}</code></div>
      <div class="proof-footer"><span>REVIEWED ${dateLabel(record.reviewedAt).toUpperCase()}</span><span>SOLANA · DEVNET</span></div>
    </div>
    <div class="panel receipt-panel"><div class="panel-head"><div><p class="eyebrow">ON-CHAIN RECEIPT</p><h3>Evidence commitment</h3></div><span class="live-dot">Confirmed</span></div>
      <p class="receipt-copy">The reviewer wallet signed a hash of this skill claim, evidence link, and rubric result. The full project stays at its original URL.</p>
      <div class="hash-line"><span>CLAIM SHA-256</span><code>${escapeHtml(record.claimHash)}</code></div>
      <div class="hash-line"><span>ISSUER</span><code>${escapeHtml(record.issuerWallet)}</code></div>
      <a class="explorer-link" href="https://explorer.solana.com/tx/${encodeURIComponent(record.signature)}?cluster=devnet" target="_blank" rel="noreferrer">View transaction on Solana Explorer <span>↗</span></a>
      <div class="receipt-actions"><button class="button button-primary" data-action="copy-proof" data-link="${escapeHtml(proofLink)}">Copy verification link</button><a class="button button-quiet" href="${escapeHtml(proofLink)}">Open verification page <span>↗</span></a></div>
    </div>
    ${record.reviewerNote ? `<div class="panel note-panel"><p class="eyebrow">REVIEWER NOTE</p><p>${escapeHtml(record.reviewerNote)}</p></div>` : ''}
  </section>`;
}

function renderProofsList() {
  const record = recordById();
  if (!record) return renderReview(null);
  return renderIssuedDetail(record);
}

function renderInterview() {
  const interview = state.interview;
  const modelName = escapeHtml(state.ai.model || 'gemini-3.8-flash');
  if (interview.phase === 'idle') {
    return `<section class="interview-start panel">
      <div class="interview-hero"><p class="eyebrow">PERSONALIZED TECHNICAL INTERVIEW</p><h2>Show the technical depth behind your experience.</h2><p>Gemini reads your resume, builds questions around the projects and skills it finds, then probes your answers with technical follow-ups.</p><span class="model-chip">✦ ${modelName}</span></div>
      <div class="ai-setup ${state.ai.configured ? 'is-ready' : 'is-missing'}"><span class="ai-setup-mark">${state.ai.configured ? '✓' : '!'}</span><div><strong>${state.ai.configured ? 'Gemini is ready' : 'Gemini API key needed'}</strong><p>${state.ai.configured ? 'Your resume creates the interview profile. The original resume text or file is not saved.' : isPublicDemo ? 'The Gemini API key is missing from this Cloudflare Worker. Add it as a Worker secret and deploy again.' : 'Add GEMINI_API_KEY to the local .env file, then restart BuildProof to enable interviews.'}</p></div></div>
      <form id="interview-start-form" class="interview-form">
        <label class="field-label" for="resume-upload">Resume file <span>Choose one source · PDF/TXT/MD up to 700 KB</span></label>
        <input id="resume-upload" class="text-input file-input" type="file" accept="application/pdf,.pdf,text/plain,.txt,text/markdown,.md" />${interview.resumeFile?.name ? `<p class="field-hint">Loaded: ${escapeHtml(interview.resumeFile.name)}</p>` : ''}
        <label class="field-label" for="resume-url">Resume file link <span>Public, direct HTTPS link to a PDF, TXT, or Markdown file</span></label>
        <input id="resume-url" class="text-input" type="url" inputmode="url" autocomplete="url" maxlength="2048" placeholder="https://example.com/resume.pdf" value="${escapeHtml(interview.resumeUrl)}" />
        <p class="field-hint">Private Drive/Dropbox preview pages are not supported. The link must open the file directly.</p>
        <label class="field-label" for="resume-text">Resume text <span>Or paste at least 100 characters</span></label>
        <textarea id="resume-text" class="text-area resume-text" maxlength="24000" placeholder="Paste your experience, projects, technical skills, and contributions here…">${escapeHtml(interview.resumeText)}</textarea>
        <div class="interview-options"><div><label class="field-label" for="focus-area">Focus area <span>Optional</span></label><input id="focus-area" class="text-input" maxlength="120" placeholder="e.g. Backend systems, AI engineering" /></div><div><label class="field-label" for="interview-language">Interview language</label><select id="interview-language" class="text-input"><option value="ko">한국어</option><option value="en">English</option></select></div></div>
        <div class="form-note interview-privacy"><span>ⓘ</span><p>${isPublicDemo ? 'Your resume is sent to Google Gemini to create the interview profile, but the original resume text or file is not saved. The extracted profile, questions, answers, and report are saved in Cloudflare D1 and linked to this browser. Delete an interview from this page to remove its saved record. Do not submit information you do not want processed by Gemini or stored by this demo.' : 'Your resume is sent to Google Gemini to create the interview profile, but the original resume text or file is not saved. The extracted profile, questions, answers, and report are saved on this BuildProof host in data/interviews.json so you can reload or reopen each page. Delete an interview from this page to remove its saved record. Do not submit information you do not want processed by Gemini or stored locally.'}</p></div>
        <div class="dialog-actions"><button class="button button-primary" type="submit" ${!state.ai.configured || interview.busy ? 'disabled' : ''}>${interview.busy ? 'Preparing your interview…' : 'Create my interview'} <span>→</span></button></div>
      </form>
    </section>${renderSavedInterviews()}`;
  }

  if (interview.phase === 'active') {
    const turns = interview.history.map((turn, index) => `<article class="interview-turn"><div class="turn-label"><span>QUESTION ${index + 1}</span><span>${escapeHtml(turn.focus || 'Technical discussion')}</span></div><h3>${escapeHtml(turn.question)}</h3><p class="turn-answer">${escapeHtml(turn.answer)}</p></article>`).join('');
    const questionNumber = interview.history.length + 1;
    return `<section class="interview-session">
      <div class="interview-session-head"><div><p class="eyebrow">LIVE INTERVIEW · ${escapeHtml(state.ai.model)}</p><h2>${escapeHtml(interview.profile?.candidateSummary || 'Resume-based technical review')}</h2></div><button class="button button-quiet" data-action="discard-interview">Discard</button></div>
      <div class="interview-profile panel"><div class="panel-head"><div><p class="eyebrow">SKILLS FOUND IN YOUR RESUME</p><h3>Questions will test these claims</h3></div><span class="turn-progress">${questionNumber} / 5</span></div><div class="skill-chips">${(interview.profile?.skills || []).map((skill) => `<span class="skill-chip">${escapeHtml(skill.name)}</span>`).join('') || '<span class="skill-chip">Project experience</span>'}</div><p class="profile-summary">${escapeHtml(interview.profile?.candidateSummary || '')}</p></div>
      <div class="interview-transcript">${turns}</div>
      <article class="current-question panel"><div class="turn-label"><span>QUESTION ${questionNumber} OF 5</span><span>${escapeHtml(interview.question?.focus || 'Technical discussion')}</span></div><h3>${escapeHtml(interview.question?.question || '')}</h3>
        <form id="interview-answer-form"><label class="field-label" for="interview-answer">Your answer</label><textarea id="interview-answer" class="text-area interview-answer" maxlength="6000" placeholder="Explain what you did, why you chose that approach, and what you learned…" required>${escapeHtml(interview.draftAnswer)}</textarea><div class="dialog-actions"><button class="button button-primary" type="submit" ${interview.busy ? 'disabled' : ''}>${interview.busy ? 'Gemini is preparing the next step…' : questionNumber === 5 ? 'Finish and review answers' : 'Send answer'} <span>→</span></button></div></form>
      </article>
    </section>`;
  }

  const report = interview.report;
  const criteria = (report?.criteria || []).map((criterion) => `<article class="criterion-card"><div class="criterion-head"><strong>${escapeHtml(criterion.name)}</strong><span>${criterion.score}/4</span></div><div class="score-track"><i style="width:${Math.max(0, Math.min(100, criterion.score * 25))}%"></i></div><p>${escapeHtml(criterion.observation)}</p>${criterion.evidenceQuote ? `<blockquote>“${escapeHtml(criterion.evidenceQuote)}”<cite>Answer ${criterion.evidenceTurn}</cite></blockquote>` : '<small class="evidence-missing">No exact answer excerpt could be linked.</small>'}</article>`).join('');
  return `<section class="interview-report">
    <div class="report-heading"><div><p class="eyebrow">INTERVIEW REPORT · ${modelName}</p><h2>Technical review complete.</h2></div><span class="coverage-chip coverage-${escapeHtml(report?.evidenceCoverage || 'low')}">${escapeHtml(report?.evidenceCoverage || 'low')} evidence coverage</span></div>
    <article class="report-summary panel"><p class="eyebrow">ASSESSMENT SUMMARY</p><p>${escapeHtml(report?.summary || '')}</p><small>${escapeHtml(report?.scope || '')}</small></article>
    <div class="panel report-criteria"><div class="panel-head"><div><p class="eyebrow">EVIDENCE-BASED RUBRIC</p><h3>What the interview showed</h3></div><span class="turn-progress">${interview.history.length} answers</span></div><div class="criterion-grid">${criteria}</div></div>
    <div class="report-columns"><article class="panel report-list"><p class="eyebrow">STRENGTHS OBSERVED</p>${(report?.strengths || []).map((item) => `<p class="report-list-item"><span>＋</span>${escapeHtml(item)}</p>`).join('') || '<p class="report-list-empty">No strengths were identified.</p>'}</article><article class="panel report-list"><p class="eyebrow">AREAS TO EXPLORE</p>${(report?.areasToExplore || []).map((item) => `<p class="report-list-item"><span>↗</span>${escapeHtml(item)}</p>`).join('') || '<p class="report-list-empty">No additional areas were identified.</p>'}</article></div>
    <p class="report-disclaimer">This is an AI-generated interview snapshot based on the answers shown. It is not a hiring decision or a complete certification.</p>
    <section class="panel report-publication">
      <div><p class="eyebrow">OPTIONAL PUBLIC PROOF</p><h3>Anchor this interview report on Devnet</h3><p>The public report includes these scores, observations, and selected answer excerpts. It does not include your resume or full transcript. Anyone with the verification link can view it; the on-chain hash cannot be removed.</p></div>
      ${interview.publishedProof ? `<div class="published-proof"><strong>Report anchored on Devnet</strong><code>${escapeHtml(shortKey(interview.publishedProof.signature))}</code><a href="/?interview-proof=${encodeURIComponent(interview.publishedProof.id)}">Open public verification page ↗</a><button class="button button-small" data-action="copy-interview-proof" data-link="${escapeHtml(`${location.origin}/?interview-proof=${interview.publishedProof.id}`)}">Copy verification link</button></div>` : `<label class="publish-consent"><input type="checkbox" data-interview-consent ${interview.publishConsent ? 'checked' : ''} /><span>I reviewed the report and agree to publish it as a public proof.</span></label><div class="dialog-actions"><button class="button button-primary" data-action="issue-interview-proof" ${!interview.publishConsent || interview.busy || !interview.reportId ? 'disabled' : ''}>${interview.busy ? 'Anchoring report…' : interview.pendingProofSubmission ? 'Retry proof verification' : interview.pendingProofDraft ? 'Retry report signing' : 'Publish report and sign on Devnet'} <span>↗</span></button></div>`}
    </section>
    <div class="review-actions"><button class="button button-quiet" data-action="new-interview">Start another interview <span>↗</span></button><button class="button button-quiet" data-action="delete-saved-interview" data-kind="completed" data-id="${escapeHtml(interview.reportId || '')}">Delete this report and answers</button></div>
  </section>`;
}

function renderSavedInterviews() {
  const active = state.savedInterviews.active || [];
  const completed = state.savedInterviews.completed || [];
  const items = [
    ...active.map((item) => ({ ...item, href: `/interviews/${encodeURIComponent(item.id)}`, action: 'Continue interview' })),
    ...completed.map((item) => ({ ...item, href: `/reports/${encodeURIComponent(item.id)}`, action: 'Open report' })),
  ].sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt));
  const rows = items.map((item) => `<article class="saved-interview-row"><div><strong>${escapeHtml(item.candidateSummary || 'Technical interview')}</strong><p>${item.status === 'active' ? 'In progress' : 'Report ready'} · ${item.answerCount} answers · ${escapeHtml(dateLabel(item.updatedAt))}</p></div><div class="saved-interview-actions"><a class="button button-small" href="${item.href}">${item.action}</a><button class="button button-small button-quiet" data-action="delete-saved-interview" data-kind="${item.status === 'active' ? 'active' : 'completed'}" data-id="${escapeHtml(item.id)}">Delete</button></div></article>`).join('');
  return `<section class="panel saved-interviews"><div class="panel-head"><div><p class="eyebrow">${isPublicDemo ? 'YOUR INTERVIEW HISTORY' : 'LOCAL INTERVIEW HISTORY'}</p><h3>Saved interviews</h3></div><span class="turn-progress">${items.length}</span></div>${rows ? `<div class="saved-interview-list">${rows}</div>` : `<p class="saved-interviews-empty">${isPublicDemo ? 'Your saved interviews will appear here and remain available to this browser after reloading the page.' : 'Your saved interviews will appear here. They remain available after reloading this page or restarting BuildProof.'}</p>`}</section>`;
}

function renderInterviewProofVerification() {
  const record = state.interviewProofRecord;
  if (state.interviewProofLoading) return `<main class="verify-shell"><a class="brand" href="/">${brandIcon()}<span>BuildProof</span></a><section class="panel verify-card"><p class="eyebrow">PUBLIC VERIFICATION</p><h1>Loading proof…</h1></section></main>`;
  if (!record) return `<main class="verify-shell"><a class="brand" href="/">${brandIcon()}<span>BuildProof</span></a><section class="panel verify-card"><p class="eyebrow">PUBLIC VERIFICATION</p><h1>Interview proof not found</h1><p>${escapeHtml(state.interviewProofError || 'This proof may have been removed from the BuildProof server.')}</p><a class="button button-primary" href="/#interview">Open BuildProof</a></section></main>`;
  const manifest = record.manifest;
  const report = manifest.assessment.report;
  const criteria = (Array.isArray(report.criteria) ? report.criteria : []).map((criterion) => `<article class="criterion-card"><div class="criterion-head"><strong>${escapeHtml(criterion.name)}</strong><span>${criterion.score}/4</span></div><div class="score-track"><i style="width:${Math.max(0, Math.min(100, criterion.score * 25))}%"></i></div><p>${escapeHtml(criterion.observation)}</p>${criterion.evidenceQuote ? `<blockquote>“${escapeHtml(criterion.evidenceQuote)}”<cite>Answer ${criterion.evidenceTurn}</cite></blockquote>` : ''}</article>`).join('');
  const verdict = state.verification;
  const verdictId = `interview-${record.id}`;
  return `<main class="verify-shell">
    <a class="brand" href="/">${brandIcon()}<span>BuildProof</span></a>
    <section class="verify-hero"><p class="eyebrow">PUBLIC INTERVIEW PROOF / SOLANA DEVNET</p><h1>Interview record.<br /><em>Anchored by its owner.</em></h1><p>This record commits to the report below. It is an AI-assisted interview snapshot, not an independent certification.</p></section>
    <article class="panel verify-card">
      <div class="verify-card-head"><div><p class="eyebrow">AI-ASSISTED TECHNICAL INTERVIEW</p><h2>${escapeHtml(report.summary || 'Technical interview report')}</h2></div><span class="proof-seal large">✓</span></div>
      <dl class="verify-facts"><div><dt>Candidate wallet</dt><dd><code>${escapeHtml(record.subjectWallet)}</code></dd></div><div><dt>Model and rubric</dt><dd>${escapeHtml(manifest.assessment.provider)} · ${escapeHtml(manifest.assessment.model)} · ${escapeHtml(manifest.assessment.rubricVersion)}</dd></div><div><dt>Interview answers</dt><dd>${manifest.assessment.questionCount}</dd></div><div><dt>Report issued</dt><dd>${dateLabel(manifest.issuedAt)}</dd></div><div><dt>Evidence coverage</dt><dd>${escapeHtml(report.evidenceCoverage)}</dd></div></dl>
      <section class="proof-report-section"><p class="eyebrow">ASSESSMENT CRITERIA</p><div class="criterion-grid">${criteria}</div></section>
      ${Array.isArray(report.strengths) && report.strengths.length ? `<section class="proof-report-section"><p class="eyebrow">STRENGTHS OBSERVED</p>${report.strengths.map((item) => `<p class="report-list-item">＋ ${escapeHtml(item)}</p>`).join('')}</section>` : ''}
      ${Array.isArray(report.areasToExplore) && report.areasToExplore.length ? `<section class="proof-report-section"><p class="eyebrow">AREAS TO EXPLORE</p>${report.areasToExplore.map((item) => `<p class="report-list-item">↗ ${escapeHtml(item)}</p>`).join('')}</section>` : ''}
      <div class="verify-result ${verdict?.id === verdictId ? (verdict.ok ? 'is-valid' : 'is-invalid') : ''}"><span class="verify-result-icon">${verdict?.id === verdictId ? (verdict.ok ? '✓' : '!') : '◌'}</span><div><strong>${verdict?.id === verdictId ? (verdict.ok ? 'Proof verified on Devnet' : 'Proof could not be verified') : 'Ready to verify'}</strong><p>${verdict?.id === verdictId ? escapeHtml(verdict.message) : 'BuildProof will compare this report hash and candidate wallet with the signed Devnet transaction.'}</p></div></div>
      <div class="verify-actions"><button class="button button-primary" data-action="verify-interview-proof" data-id="${escapeHtml(record.id)}" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Checking Devnet…' : 'Verify on Devnet'} <span>↗</span></button><a class="button button-quiet" href="https://explorer.solana.com/tx/${encodeURIComponent(record.signature)}?cluster=devnet" target="_blank" rel="noreferrer">Open Explorer</a></div>
      <p class="verify-footnote">Only the salted report hash is on-chain. The public report is stored by this BuildProof server. Resume text and the full interview transcript are not part of this proof.</p>
    </article>
    <a class="back-link" href="/#interview">← Open BuildProof</a>
  </main>`;
}

function renderVerificationPage() {
  const id = new URLSearchParams(location.search).get('proof');
  const record = state.records.find((item) => item.id === id && item.status === 'issued');
  if (!record) return `<main class="verify-shell"><a class="brand" href="/">${brandIcon()}<span>BuildProof</span></a><section class="panel verify-card"><p class="eyebrow">PUBLIC VERIFICATION</p><h1>Proof not found</h1><p>${isPublicDemo ? 'This BuildProof deployment has no issued record with that ID.' : 'This local BuildProof instance has no issued record with that ID.'}</p><a class="button button-primary" href="/">Open review desk</a></section></main>`;
  const verdict = state.verification;
  return `<main class="verify-shell">
    <a class="brand" href="/">${brandIcon()}<span>BuildProof</span></a>
    <section class="verify-hero"><p class="eyebrow">PUBLIC VERIFICATION / SOLANA DEVNET</p><h1>Evidence, reviewed.<br /><em>Proof, portable.</em></h1><p>Compare the submitted claim with the signed on-chain receipt.</p></section>
    <article class="panel verify-card">
      <div class="verify-card-head"><div><p class="eyebrow">SKILL PROOF</p><h2>${escapeHtml(record.skill)}</h2><p class="verify-project">${escapeHtml(record.projectName)}</p></div><span class="proof-seal large">✓</span></div>
      <dl class="verify-facts"><div><dt>Builder wallet</dt><dd><code>${escapeHtml(record.learnerWallet)}</code></dd></div><div><dt>Evidence</dt><dd><a href="${escapeHtml(record.evidenceUrl)}" target="_blank" rel="noreferrer">${escapeHtml(safeHost(record.evidenceUrl))} ↗</a></dd></div>${record.evidenceRef ? `<div><dt>Commit / version</dt><dd><code>${escapeHtml(record.evidenceRef)}</code></dd></div>` : ''}<div><dt>Reviewed</dt><dd>${dateLabel(record.reviewedAt)}</dd></div><div><dt>Issuer</dt><dd><code>${escapeHtml(shortKey(record.issuerWallet))}</code></dd></div></dl>
      <div class="verify-result ${verdict?.id === id ? (verdict.ok ? 'is-valid' : 'is-invalid') : ''}">
        <span class="verify-result-icon">${verdict?.id === id ? (verdict.ok ? '✓' : '!') : '◌'}</span>
        <div><strong>${verdict?.id === id ? (verdict.ok ? 'Receipt verified on Devnet' : 'Receipt could not be verified') : 'Ready to verify'}</strong><p>${verdict?.id === id ? escapeHtml(verdict.message) : 'BuildProof will recalculate the claim hash and compare it with the signed Devnet transaction.'}</p></div>
      </div>
      <div class="verify-actions"><button class="button button-primary" data-action="verify-selected" data-id="${record.id}" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Checking Devnet…' : 'Verify on Devnet'} <span>↗</span></button><a class="button button-quiet" href="https://explorer.solana.com/tx/${encodeURIComponent(record.signature)}?cluster=devnet" target="_blank" rel="noreferrer">Open Explorer</a></div>
      <p class="verify-footnote">Only the claim hash is stored on-chain. Review details and evidence remain in this BuildProof service.</p>
    </article>
    <a class="back-link" href="/">← Open BuildProof review desk</a>
  </main>`;
}

function brandIcon() {
  return `<span class="brand-glyph" aria-hidden="true"><svg viewBox="0 0 36 36"><path d="M8 7.5h19.5L31 11H11.5L8 14.5h19.5L31 18H11.5L8 21.5h19.5L31 25H8l-3.5-3.5L8 18l-3.5-3.5L8 11z"/><path d="M24 28.5h4v4h-4z"/></svg></span>`;
}

function renderShell() {
  const pendingCount = state.records.filter((record) => record.status === 'pending').length;
  const issuedCount = state.records.filter((record) => record.status === 'issued').length;
  const record = recordById();
  const editingRecord = state.editingId ? recordById(state.editingId) : null;
  const isInterview = state.view === 'interview';
  const pageTitle = isInterview ? 'AI interview' : state.view === 'proofs' ? 'Proof registry' : 'Review desk';
  const pageEyebrow = isInterview ? 'PERSONALIZED TECHNICAL REVIEW' : state.view === 'proofs' ? 'PORTABLE RECORDS' : 'HUMAN REVIEW';
  return `<div class="app-shell">
    <header class="topbar"><a class="brand" href="/">${brandIcon()}<span>BuildProof</span><span class="brand-beta">${isPublicDemo ? 'PUBLIC DEMO' : 'LOCAL PREVIEW'}</span></a><div class="topbar-right"><span class="network-label"><span class="network-dot"></span>Devnet</span><button class="wallet-button ${state.wallet ? 'wallet-connected' : ''}" data-action="wallet">${state.wallet ? `<span class="wallet-indicator"></span>${escapeHtml(shortKey(state.wallet))}` : '<span class="wallet-icon">⌑</span>Connect wallet'}</button></div></header>
    ${state.notice ? `<div class="notice notice-${state.notice.kind}" role="status"><span>${escapeHtml(state.notice.message)}${state.notice.action ? ` <a href="${escapeHtml(state.notice.action.url)}" target="_blank" rel="noreferrer">${escapeHtml(state.notice.action.label)} ↗</a>` : ''}</span><button data-action="dismiss-notice" aria-label="Dismiss">×</button></div>` : ''}
    <aside class="sidebar"><div class="sidebar-top"><p class="eyebrow">WORKSPACE</p>${navLink('interview', 'AI interview', 0, '✦')}${navLink('review', 'Review desk', pendingCount, '⌂')}${navLink('proofs', 'Issued proofs', issuedCount, '◇')}</div>
      <div class="sidebar-bottom"><div class="sidebar-rule"></div><div class="review-principle"><span class="principle-mark">BP</span><div><strong>${isInterview ? 'Grounded questions' : 'Evidence first'}</strong><p>${isInterview ? 'Each question probes a claim from your resume.' : 'Every proof links to reviewed work.'}</p></div></div><div class="data-note"><span class="data-lock">▧</span><p>${isInterview ? isPublicDemo ? 'Interview data is stored in Cloudflare D1 and linked to this browser until deleted.' : 'Interview profile, questions, answers, and reports are saved on this host until deleted.' : isPublicDemo ? 'Submissions are scoped to this browser. Only a claim hash goes on-chain.' : 'Submissions stay on this device. Only a claim hash goes on-chain.'}</p></div></div>
    </aside>
    <main class="main-content"><div class="page-top"><div><p class="eyebrow">BUILDPROOF / ${pageEyebrow}</p><h1>${pageTitle}<span class="title-period">.</span></h1></div>${isInterview ? `<span class="model-chip page-model">✦ ${escapeHtml(state.ai.model)}</span>` : '<button class="button button-primary submit-top" data-action="open-submit">Submit evidence <span>＋</span></button>'}</div>
      ${isInterview ? `<div class="interview-content">${renderInterview()}</div>` : `<div class="workbench"><section class="queue-column"><div class="queue-header"><div><p class="eyebrow">${state.view === 'proofs' ? 'YOUR PROOF RECORDS' : 'SUBMISSIONS'}</p><h2>${state.view === 'proofs' ? `${issuedCount} issued` : `${pendingCount} to review`}</h2></div><button class="icon-button" data-action="refresh" aria-label="Refresh submissions" title="Refresh">⟳</button></div><div class="submission-list">${renderRecordList()}</div>
        <button class="new-submission-link" data-action="open-submit"><span>＋</span> Add a project submission</button>
      </section><section class="detail-column">${state.view === 'proofs' ? renderProofsList() : renderReview(record)}</section></div>`}
      <footer class="page-footer"><span>BuildProof is an evidence review prototype.</span><span><a href="https://explorer.solana.com/?cluster=devnet" target="_blank" rel="noreferrer">Solana Devnet ↗</a><span class="footer-sep">/</span>${isPublicDemo ? 'Cloudflare demo' : 'Local data'}</span></footer>
    </main>
    <dialog class="submit-dialog" id="submit-dialog"><form method="dialog" class="dialog-close-form"><button class="dialog-close" aria-label="Close">×</button></form><p class="eyebrow">${editingRecord ? 'UPDATE SUBMISSION / V1 RUBRIC' : 'NEW SUBMISSION / V1 RUBRIC'}</p><h2>${editingRecord ? 'Update your evidence.' : 'Put the work on the table.'}</h2><p class="dialog-intro">Share a project snapshot and the wallet that should receive its proof.</p>
      <form id="submit-form" class="submit-form">
        <label class="field-label" for="project-name">Project name <span>Required</span></label><input id="project-name" name="projectName" class="text-input" required maxlength="80" placeholder="e.g. Accessible product landing page" value="${escapeHtml(editingRecord?.projectName || '')}" />
        <label class="field-label" for="skill">Skill shown <span>Required</span></label><input id="skill" name="skill" class="text-input" required maxlength="48" placeholder="e.g. React, Rust, UI engineering" value="${escapeHtml(editingRecord?.skill || '')}" />
        <label class="field-label" for="evidence-url">Evidence URL <span>GitHub, demo, or deployed project</span></label><input id="evidence-url" name="evidenceUrl" class="text-input" type="url" required placeholder="https://github.com/you/project/commit/…" value="${escapeHtml(editingRecord?.evidenceUrl || '')}" />
        <p class="field-hint">A commit-specific GitHub link makes the reviewed version reproducible.</p>
        <label class="field-label" for="evidence-ref">Commit or version <span>Optional</span></label><input id="evidence-ref" name="evidenceRef" class="text-input" maxlength="80" placeholder="e.g. 7f3a2d1 or v1.2" value="${escapeHtml(editingRecord?.evidenceRef || '')}" />
        <label class="field-label" for="learner-wallet">Builder wallet <span>Required · Solana address</span></label><div class="wallet-field-row"><input id="learner-wallet" name="learnerWallet" class="text-input" required minlength="32" maxlength="44" placeholder="Paste the wallet that should receive this proof" value="${escapeHtml(editingRecord?.learnerWallet || state.wallet || '')}" /><button class="button button-small" type="button" data-action="use-wallet" ${state.wallet ? '' : 'disabled'}>Use connected</button></div>
        <div class="form-note"><span>ⓘ</span><p>Do not include private code, personal details, or secrets. The proof links to public evidence; it does not copy your project on-chain.</p></div>
        <div class="dialog-actions"><button class="button button-quiet" type="button" data-action="close-submit">Cancel</button><button class="button button-primary" type="submit">${editingRecord ? 'Save updates' : 'Send for review'} <span>→</span></button></div>
      </form>
    </dialog>
  </div>`;
}

function render() {
  const params = new URLSearchParams(location.search);
  app.innerHTML = state.view === 'verification'
    ? (params.has('interview-proof') ? renderInterviewProofVerification() : renderVerificationPage())
    : renderShell();
  bindEvents();
}

function bindEvents() {
  app.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => {
    state.view = button.dataset.view;
    if (state.view === 'proofs') state.selectedId = state.records.find((record) => record.status === 'issued')?.id || null;
    else if (state.view === 'review') state.selectedId = state.records.find((record) => record.status !== 'issued')?.id || null;
    state.notice = null;
    history.replaceState({}, '', state.view === 'interview' ? '/#interview' : state.view === 'proofs' ? '/#proofs' : '/#review');
    render();
  }));
  app.querySelectorAll('[data-select]').forEach((button) => button.addEventListener('click', () => {
    state.selectedId = button.dataset.select;
    render();
  }));
  app.querySelectorAll('[data-action]').forEach((button) => button.addEventListener('click', handleAction));
  const form = app.querySelector('#submit-form');
  form?.addEventListener('submit', submitForm);
  app.querySelector('#interview-start-form')?.addEventListener('submit', startInterview);
  app.querySelector('#interview-answer-form')?.addEventListener('submit', submitInterviewAnswer);
  app.querySelector('#interview-answer')?.addEventListener('input', (event) => { state.interview.draftAnswer = event.currentTarget.value; });
  app.querySelector('#resume-text')?.addEventListener('input', (event) => {
    state.interview.resumeText = event.currentTarget.value;
    state.interview.resumeFile = null;
    state.interview.resumeUrl = '';
    const urlInput = app.querySelector('#resume-url');
    if (urlInput) urlInput.value = '';
    const fileInput = app.querySelector('#resume-upload');
    if (fileInput) fileInput.value = '';
  });
  app.querySelector('#resume-url')?.addEventListener('input', (event) => {
    state.interview.resumeUrl = event.currentTarget.value;
    if (state.interview.resumeUrl) {
      state.interview.resumeText = '';
      state.interview.resumeFile = null;
      const textarea = app.querySelector('#resume-text');
      const fileInput = app.querySelector('#resume-upload');
      if (textarea) textarea.value = '';
      if (fileInput) fileInput.value = '';
    }
  });
  app.querySelector('#resume-upload')?.addEventListener('change', handleResumeFile);
  app.querySelector('[data-interview-consent]')?.addEventListener('change', (event) => {
    state.interview.publishConsent = event.currentTarget.checked;
    const button = app.querySelector('[data-action="issue-interview-proof"]');
    if (button) button.disabled = !state.interview.publishConsent || state.interview.busy || !state.interview.reportId;
  });
  app.querySelectorAll('[data-rubric]').forEach((checkbox) => checkbox.addEventListener('change', () => {
    const record = recordById();
    if (record) record.rubric[checkbox.dataset.rubric] = checkbox.checked;
    const count = Object.values(record?.rubric || {}).filter(Boolean).length;
    const countNode = app.querySelector('.rubric-count');
    const approveButton = app.querySelector('[data-action="approve"]');
    if (countNode) countNode.textContent = `${count}/3`;
    if (approveButton) approveButton.disabled = count < 3;
  }));
}

async function handleAction(event) {
  const button = event.currentTarget;
  const action = button.dataset.action;
  if (action === 'dismiss-notice') { state.notice = null; render(); return; }
  if (action === 'new-interview') { location.assign('/interview'); return; }
  if (action === 'discard-interview') { await discardInterview(); return; }
  if (action === 'delete-saved-interview') { await deleteSavedInterview(button); return; }
  if (action === 'open-submit') { state.editingId = null; app.querySelector('#submit-dialog')?.showModal(); return; }
  if (action === 'close-submit') { state.editingId = null; app.querySelector('#submit-dialog')?.close(); return; }
  if (action === 'refresh') {
    try { await loadRecords(); render(); setNotice('Submission list refreshed.', 'success'); }
    catch (error) { setNotice(error.message, 'error'); }
    return;
  }
  if (action === 'wallet') { await connectWallet(); return; }
  if (action === 'use-wallet') {
    const input = app.querySelector('#learner-wallet');
    if (input && state.wallet) input.value = state.wallet;
    return;
  }
  if (action === 'approve' || action === 'request-changes') { await saveReview(action === 'approve' ? 'approved' : 'rejected'); return; }
  if (action === 'edit-submission') {
    const record = recordById();
    if (!record) return;
    state.editingId = record.id;
    render();
    app.querySelector('#submit-dialog')?.showModal();
    return;
  }
  if (action === 'issue') { await issueProof(); return; }
  if (action === 'issue-interview-proof') { await issueInterviewProof(); return; }
  if (action === 'verify-interview-proof') { await verifyInterviewProof(button.dataset.id); return; }
  if (action === 'copy-interview-proof') {
    try { await navigator.clipboard.writeText(button.dataset.link); setNotice('Verification link copied.', 'success'); }
    catch { setNotice(button.dataset.link, 'info'); }
    return;
  }
  if (action === 'copy-proof') {
    try { await navigator.clipboard.writeText(button.dataset.link); setNotice('Verification link copied.', 'success'); }
    catch { setNotice(button.dataset.link, 'info'); }
    return;
  }
  if (action === 'verify-selected') { await verifyProof(button.dataset.id); }
}

async function connectWallet() {
  const wallet = detectSolanaWallet(window);
  if (!wallet) {
    const isEmbedded = window.top !== window.self;
    setPersistentNotice(
      walletUnavailableMessage(isEmbedded),
      'error',
      { label: 'Get Phantom', url: 'https://phantom.com/download' },
    );
    return;
  }
  try {
    const response = await wallet.provider.connect();
    state.walletProvider = wallet.provider;
    state.wallet = response.publicKey?.toString() || wallet.provider.publicKey?.toString() || null;
    render();
    setNotice(state.wallet ? `Connected ${wallet.name} ${shortKey(state.wallet)}. The issuer account needs Devnet SOL to issue a proof.` : 'Wallet connection returned no address.', state.wallet ? 'success' : 'error');
  } catch (error) {
    setNotice(error.message || 'Wallet connection was cancelled.', 'error');
  }
}

async function submitForm(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form));
  try {
    values.learnerWallet = new PublicKey(values.learnerWallet).toBase58();
  } catch {
    setNotice('Enter a valid Solana wallet address for the builder.', 'error');
    return;
  }
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const endpoint = state.editingId ? `/api/submissions/${state.editingId}` : '/api/submissions';
    const method = state.editingId ? 'PATCH' : 'POST';
    const record = await api(endpoint, { method, body: JSON.stringify(values) });
    await loadRecords(false);
    state.selectedId = record.id;
    state.editingId = null;
    app.querySelector('#submit-dialog')?.close();
    render();
    setNotice(method === 'PATCH' ? 'Submission updated and returned to the review desk.' : 'Submission added to the review desk.', 'success');
  } catch (error) {
    setNotice(error.message, 'error');
    submit.disabled = false;
  }
}

async function handleResumeFile(event) {
  const file = event.currentTarget.files?.[0];
  if (!file) return;
  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  const isText = file.type.startsWith('text/') || /\.(txt|md)$/i.test(file.name);
  if (!isPdf && !isText) { setNotice('Choose a PDF, TXT, or Markdown resume.', 'error'); return; }
  if (file.size > 700 * 1024) { setNotice('Resume files must be smaller than 700 KB.', 'error'); return; }
  try {
    if (isPdf) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
      state.interview.resumeFile = { name: file.name, mimeType: 'application/pdf', data: btoa(binary) };
      state.interview.resumeText = '';
    } else {
      state.interview.resumeText = (await file.text()).slice(0, 24000);
      state.interview.resumeFile = null;
    }
    state.interview.resumeUrl = '';
    render();
    if (isText) {
      const textarea = app.querySelector('#resume-text');
      textarea?.focus();
      if (state.interview.resumeText.length >= 24000) setNotice('Resume text was limited to 24,000 characters.', 'info');
    }
  } catch {
    setNotice('The resume file could not be read. Try pasting the text instead.', 'error');
  }
}

async function startInterview(event) {
  event.preventDefault();
  const resumeText = app.querySelector('#resume-text')?.value.trim() || '';
  const resumeUrl = app.querySelector('#resume-url')?.value.trim() || '';
  const focusArea = app.querySelector('#focus-area')?.value.trim() || '';
  const language = app.querySelector('#interview-language')?.value || 'en';
  const sourceCount = Number(Boolean(resumeText)) + Number(Boolean(state.interview.resumeFile)) + Number(Boolean(resumeUrl));
  if (sourceCount !== 1) { setNotice('Choose one resume source: upload a file, paste text, or enter a direct file link.', 'error'); return; }
  state.interview.resumeText = resumeText;
  state.interview.resumeUrl = resumeUrl;
  state.interview.busy = true;
  state.notice = null;
  render();
  try {
    const result = await api('/api/interviews', {
      method: 'POST',
      body: JSON.stringify({ resumeText, resumeFile: state.interview.resumeFile, resumeUrl, focusArea, language }),
    });
    state.interview = {
      phase: 'active', id: result.id, profile: result.profile, question: result.question,
      history: [], report: null, reportId: null, publishConsent: false, publishedProof: null, pendingProofDraft: null, pendingProofSubmission: null,
      resumeText: '', resumeFile: null, resumeUrl: '', draftAnswer: '', busy: false,
    };
    state.notice = null;
    location.assign(`/interviews/${encodeURIComponent(result.id)}`);
  } catch (error) {
    state.interview.busy = false;
    render();
    setNotice(error.message, 'error');
  }
}

async function submitInterviewAnswer(event) {
  event.preventDefault();
  const answer = app.querySelector('#interview-answer')?.value.trim() || '';
  if (answer.length < 2) { setNotice('Add your answer before continuing.', 'error'); return; }
  const interview = state.interview;
  interview.draftAnswer = answer;
  interview.busy = true;
  state.notice = null;
  render();
  try {
    const result = await api(`/api/interviews/${encodeURIComponent(interview.id)}/answer`, {
      method: 'POST', body: JSON.stringify({ answer }),
    });
    interview.history.push({ question: interview.question.question, focus: interview.question.focus, answer });
    interview.draftAnswer = '';
    interview.busy = false;
    if (result.complete) {
      interview.phase = 'complete';
      interview.report = result.report;
      interview.reportId = result.reportId;
      interview.id = null;
      location.assign(`/reports/${encodeURIComponent(result.reportId)}`);
      return;
    } else {
      interview.question = result.question;
    }
    state.notice = null;
    render();
  } catch (error) {
    interview.busy = false;
    render();
    setNotice(error.message, 'error');
  }
}

async function discardInterview() {
  const id = state.interview.id;
  if (id) {
    try { await api(`/api/interviews/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
    catch { /* A server restart already cleared the temporary session. */ }
  }
  state.interview = { phase: 'idle', id: null, profile: null, question: null, history: [], report: null, reportId: null, publishConsent: false, publishedProof: null, pendingProofDraft: null, pendingProofSubmission: null, resumeText: '', resumeFile: null, resumeUrl: '', draftAnswer: '', busy: false };
  state.notice = null;
  location.assign('/interview');
}

async function deleteSavedInterview(button) {
  const kind = button.dataset.kind;
  const id = button.dataset.id;
  if (!id) return;
  try {
    const endpoint = kind === 'completed' ? `/api/interview-reports/${encodeURIComponent(id)}` : `/api/interviews/${encodeURIComponent(id)}`;
    await api(endpoint, { method: 'DELETE' });
    if (state.interview.reportId === id || state.interview.id === id) {
      location.assign('/interview');
      return;
    }
    state.savedInterviews = await api('/api/interviews');
    setNotice(isPublicDemo ? 'Saved interview deleted.' : 'Saved interview deleted from this device.', 'success');
  } catch (error) { setNotice(error.message, 'error'); }
}

async function saveReview(decision) {
  const record = recordById();
  if (!record) return;
  const rubric = Object.fromEntries(rubricLabels.map(([key]) => [key, Boolean(app.querySelector(`[data-rubric="${key}"]`)?.checked)]));
  const reviewerNote = app.querySelector('#reviewer-note')?.value.trim() || '';
  try {
    await api(`/api/submissions/${record.id}/review`, { method: 'POST', body: JSON.stringify({ decision, rubric, reviewerNote }) });
    await loadRecords();
    render();
    setNotice(decision === 'approved' ? 'Review approved. Connect an issuer wallet to anchor the proof.' : `Changes requested. The submission remains in your ${isPublicDemo ? 'review list' : 'local review list'}.`, decision === 'approved' ? 'success' : 'info');
  } catch (error) { setNotice(error.message, 'error'); }
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

async function sha256(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

async function sha256Stable(value) {
  const bytes = new TextEncoder().encode(stableStringify(value));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function finishInterviewProofSubmission() {
  const interview = state.interview;
  const pending = interview.pendingProofSubmission;
  if (!pending) return;
  if (pending.latestBlockhash) {
    const signatureStatus = async () => {
      const response = await connection.getSignatureStatuses([pending.signature], { searchTransactionHistory: true });
      const status = response.value[0];
      if (status?.err) throw new Error('Devnet rejected the proof transaction. The existing draft is still available to retry.');
      return status && ['confirmed', 'finalized'].includes(status.confirmationStatus);
    };
    if (!(await signatureStatus())) {
      try {
        const confirmation = await connection.confirmTransaction({ signature: pending.signature, ...pending.latestBlockhash }, 'confirmed');
        if (confirmation.value.err) throw new Error('Devnet rejected the proof transaction. The existing draft is still available to retry.');
      } catch (error) {
        // A transaction may have landed just as the blockhash expired. Check its signature before reporting failure.
        if (!(await signatureStatus())) throw error;
      }
    }
  }
  const issued = await api(`/api/interview-proofs/${encodeURIComponent(pending.proofId)}/issue`, {
    method: 'POST', body: JSON.stringify({ signature: pending.signature }),
  });
  interview.publishedProof = issued;
  interview.pendingProofDraft = null;
  interview.pendingProofSubmission = null;
}

async function issueInterviewProof() {
  const interview = state.interview;
  if (!interview.reportId || !interview.publishConsent) return;
  if (!state.wallet || !state.walletProvider) {
    await connectWallet();
    if (!state.wallet || !state.walletProvider) return;
  }

  interview.busy = true;
  render();
  try {
    if (interview.pendingProofSubmission) {
      await finishInterviewProofSubmission();
    } else {
      if (!interview.pendingProofDraft) {
        const draft = await api('/api/interview-proofs/drafts', {
          method: 'POST',
          body: JSON.stringify({ reportId: interview.reportId, subjectWallet: state.wallet, consentToPublish: true }),
        });
        if (draft.status === 'issued') {
          interview.publishedProof = draft.proof;
        } else {
          interview.pendingProofDraft = draft;
        }
      }
      if (!interview.publishedProof) {
        const draft = interview.pendingProofDraft;
        if (draft.manifest.subjectWallet !== state.wallet) throw new Error('The connected wallet changed. Reconnect the wallet that started this proof draft.');
        const latestBlockhash = await connection.getLatestBlockhash('confirmed');
        const transaction = new Transaction({
          feePayer: new PublicKey(state.wallet),
          recentBlockhash: latestBlockhash.blockhash,
        }).add(new TransactionInstruction({
          programId: MEMO_PROGRAM,
          keys: [],
          data: new TextEncoder().encode(draft.memo),
        }));
        const signed = await state.walletProvider.signTransaction(transaction);
        const signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed' });
        interview.pendingProofSubmission = { proofId: draft.proofId, signature, latestBlockhash };
        await finishInterviewProofSubmission();
      }
    }
    interview.busy = false;
    render();
    setNotice('The interview report is anchored and saved for public verification.', 'success');
  } catch (error) {
    interview.busy = false;
    render();
    setNotice(error.message || 'The interview report could not be anchored. You can retry this step.', 'error');
  }
}

async function issueProof() {
  const record = recordById();
  if (!record) return;
  const wallet = detectSolanaWallet(window);
  if (!state.wallet || !wallet) { await connectWallet(); if (!state.wallet) return; }
  state.walletProvider = wallet?.provider || state.walletProvider;
  const provider = state.walletProvider;
  if (provider?.isConnected === false) { await connectWallet(); if (!state.wallet) return; }
  state.busy = true;
  render();
  try {
    const issuerWallet = state.wallet;
    const issuedAt = new Date().toISOString();
    const claimHash = await sha256(claimFor(record, issuerWallet, issuedAt));
    const latestBlockhash = await connection.getLatestBlockhash('confirmed');
    const transaction = new Transaction({
      feePayer: new PublicKey(issuerWallet),
      recentBlockhash: latestBlockhash.blockhash,
    }).add(new TransactionInstruction({
      programId: MEMO_PROGRAM,
      keys: [],
      data: new TextEncoder().encode(`BuildProof:v1:${claimHash}`),
    }));
    const signed = await provider.signTransaction(transaction);
    const signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed' });
    await connection.confirmTransaction({ signature, ...latestBlockhash }, 'confirmed');
    const issued = await api(`/api/submissions/${record.id}/issue`, {
      method: 'POST',
      body: JSON.stringify({ signature, issuerWallet, issuedAt, claimHash }),
    });
    await loadRecords(false);
    state.selectedId = issued.id;
    state.busy = false;
    render();
    setNotice('Proof issued and confirmed on Solana Devnet.', 'success');
  } catch (error) {
    state.busy = false;
    render();
    setNotice(error.message || 'The Devnet proof could not be issued. Check the wallet network and try again.', 'error');
  }
}

async function verifyProof(id) {
  state.busy = true;
  state.verification = null;
  render();
  try {
    const record = await api(`/api/proofs/${id}`);
    const expectedHash = await sha256(claimFor(record, record.issuerWallet, record.issuedAt));
    if (expectedHash !== record.claimHash) throw new Error('The saved claim does not match its SHA-256 commitment.');
    const transaction = await connection.getParsedTransaction(record.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    if (!transaction || transaction.meta?.err) throw new Error('Devnet returned no successful transaction for this receipt.');
    const signerPresent = transaction.transaction.message.accountKeys.some((key) => key.pubkey.toBase58() === record.issuerWallet && key.signer);
    const memo = transaction.transaction.message.instructions.find((instruction) => instruction.programId.toBase58() === MEMO_PROGRAM.toBase58() && 'parsed' in instruction);
    if (!signerPresent || memo?.parsed !== `BuildProof:v1:${expectedHash}`) throw new Error('The receipt signer or claim hash does not match the transaction.');
    state.verification = { id, ok: true, message: `Claim hash, issuer signature, and Devnet transaction all match. Transaction ${shortKey(record.signature)}.` };
  } catch (error) {
    state.verification = { id, ok: false, message: error.message || 'Could not verify this receipt.' };
  } finally {
    state.busy = false;
    render();
  }
}

async function verifyInterviewProof(id) {
  state.busy = true;
  state.verification = null;
  render();
  try {
    const record = state.interviewProofRecord;
    if (!record || record.id !== id || record.status !== 'issued') throw new Error('The public interview proof is not available.');
    const expectedHash = await sha256Stable(record.manifest);
    if (expectedHash !== record.manifestHash) throw new Error('The saved report does not match its SHA-256 commitment.');
    const transaction = await connection.getParsedTransaction(record.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    if (!transaction || transaction.meta?.err) throw new Error('Devnet returned no successful transaction for this report.');
    const signerPresent = transaction.transaction.message.accountKeys.some((key) => key.pubkey.toBase58() === record.subjectWallet && key.signer);
    const memo = transaction.transaction.message.instructions.find((instruction) => instruction.programId.toBase58() === MEMO_PROGRAM.toBase58() && 'parsed' in instruction);
    if (!signerPresent || memo?.parsed !== `BuildProof:interview:v1:${expectedHash}`) throw new Error('The candidate wallet or report hash does not match the Devnet transaction.');
    state.verification = { id: `interview-${id}`, ok: true, message: `Report hash, candidate wallet, and Devnet transaction match. Transaction ${shortKey(record.signature)}.` };
  } catch (error) {
    state.verification = { id: `interview-${id}`, ok: false, message: error.message || 'Could not verify this interview proof.' };
  } finally {
    state.busy = false;
    render();
  }
}

async function bootstrap() {
  try {
    await loadRecords(false);
    try { state.ai = await api('/api/ai/status'); }
    catch { state.ai = { configured: false, model: 'gemini-3.8-flash' }; }
    const wallet = detectSolanaWallet(window);
    state.walletProvider = wallet?.provider || null;
    const provider = state.walletProvider;
    if (provider?.isConnected && provider.publicKey) state.wallet = provider.publicKey.toString();
    const sessionRoute = location.pathname.match(/^\/interviews\/([^/]+)\/?$/);
    const reportRoute = location.pathname.match(/^\/reports\/([^/]+)\/?$/);
    if (sessionRoute) {
      const saved = await api(`/api/interviews/${encodeURIComponent(decodeURIComponent(sessionRoute[1]))}`);
      if (saved.complete && saved.reportId) {
        location.replace(`/reports/${encodeURIComponent(saved.reportId)}`);
        return;
      }
      state.interview = {
        phase: 'active', id: saved.id, profile: saved.profile, question: saved.currentQuestion,
        history: saved.history || [], report: null, reportId: null, publishConsent: false, publishedProof: null,
        pendingProofDraft: null, pendingProofSubmission: null, resumeText: '', resumeFile: null, resumeUrl: '',
        draftAnswer: saved.pendingAnswer || '', busy: false,
      };
    } else if (reportRoute) {
      const saved = await api(`/api/interview-reports/${encodeURIComponent(decodeURIComponent(reportRoute[1]))}`);
      state.interview = {
        phase: 'complete', id: null, profile: saved.profile, question: null, history: saved.history || [],
        report: saved.report, reportId: saved.id, publishConsent: false, publishedProof: saved.publishedProof || null,
        pendingProofDraft: null, pendingProofSubmission: null, resumeText: '', resumeFile: null, resumeUrl: '', draftAnswer: '', busy: false,
      };
    } else if (state.view === 'interview') {
      state.savedInterviews = await api('/api/interviews');
    }
    const proofId = new URLSearchParams(location.search).get('proof');
    if (proofId) {
      state.view = 'verification';
      state.selectedId = proofId;
    }
    const interviewProofId = new URLSearchParams(location.search).get('interview-proof');
    if (interviewProofId) {
      state.view = 'verification';
      state.interviewProofLoading = true;
      render();
      try {
        state.interviewProofRecord = await api(`/api/interview-proofs/${encodeURIComponent(interviewProofId)}`);
      } catch (error) {
        state.interviewProofError = error.message;
      } finally {
        state.interviewProofLoading = false;
      }
    }
  } catch (error) {
    state.notice = { message: error.message || 'The BuildProof service is unavailable.', kind: 'error' };
  }
  render();
}

bootstrap();
