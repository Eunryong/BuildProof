import { createHash, randomBytes } from 'node:crypto';

export const INTERVIEW_PROOF_SCHEMA = 'buildproof.interview/v1';
export const INTERVIEW_RUBRIC_VERSION = 'technical-v1';
export const INTERVIEW_MEMO_PREFIX = 'BuildProof:interview:v1:';

function boundedText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

export function publicInterviewReport(report) {
  const criteria = Array.isArray(report?.criteria) ? report.criteria.slice(0, 5).map((criterion) => ({
    name: boundedText(criterion?.name, 100),
    score: Math.max(1, Math.min(4, Number.isInteger(criterion?.score) ? criterion.score : 1)),
    observation: boundedText(criterion?.observation, 500),
    evidenceTurn: Number.isInteger(criterion?.evidenceTurn) ? criterion.evidenceTurn : null,
    evidenceQuote: boundedText(criterion?.evidenceQuote, 240),
  })) : [];

  return {
    summary: boundedText(report?.summary, 1000),
    criteria,
    strengths: Array.isArray(report?.strengths) ? report.strengths.slice(0, 5).map((item) => boundedText(item, 240)) : [],
    areasToExplore: Array.isArray(report?.areasToExplore) ? report.areasToExplore.slice(0, 5).map((item) => boundedText(item, 240)) : [],
    evidenceCoverage: ['low', 'medium', 'high'].includes(report?.evidenceCoverage) ? report.evidenceCoverage : 'low',
    scope: boundedText(report?.scope, 500),
  };
}

export function createInterviewManifest({ proofId, subjectWallet, issuedAt, model, questionCount, report, salt = randomBytes(32).toString('hex') }) {
  return {
    schema: INTERVIEW_PROOF_SCHEMA,
    proofId,
    subjectWallet,
    issuedAt,
    salt,
    assessment: {
      provider: 'Google Gemini',
      model: boundedText(model, 100),
      rubricVersion: INTERVIEW_RUBRIC_VERSION,
      questionCount: Math.max(1, Math.min(5, Number.isInteger(questionCount) ? questionCount : 5)),
      report: publicInterviewReport(report),
    },
  };
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

export function hashInterviewManifest(manifest) {
  return createHash('sha256').update(stableStringify(manifest)).digest('hex');
}

export function interviewMemoForHash(hash) {
  return `${INTERVIEW_MEMO_PREFIX}${hash}`;
}

export function isInterviewProofManifest(value) {
  return Boolean(
    value && typeof value === 'object' &&
    value.schema === INTERVIEW_PROOF_SCHEMA &&
    typeof value.proofId === 'string' &&
    typeof value.subjectWallet === 'string' &&
    typeof value.issuedAt === 'string' &&
    typeof value.salt === 'string' &&
    value.assessment && typeof value.assessment === 'object' &&
    typeof value.assessment.model === 'string' &&
    value.assessment.rubricVersion === INTERVIEW_RUBRIC_VERSION &&
    value.assessment.report && typeof value.assessment.report === 'object'
  );
}
