import assert from 'node:assert/strict';
import test from 'node:test';
import { createInterviewManifest, hashInterviewManifest } from '../interview-proof.js';

test('interview proof manifest contains only the consented report fields and hashes deterministically', () => {
  const manifest = createInterviewManifest({
    proofId: '123e4567-e89b-12d3-a456-426614174000',
    subjectWallet: '11111111111111111111111111111111',
    issuedAt: '2026-10-11T00:00:00.000Z',
    model: 'gemini-3.8-flash',
    questionCount: 5,
    salt: 'b'.repeat(64),
    report: {
      summary: 'A limited assessment.',
      criteria: [{ name: 'Technical depth', score: 3, observation: 'Explains the chosen approach.', evidenceTurn: 2, evidenceQuote: 'I compared both implementations.' }],
      strengths: ['Explains trade-offs.'],
      areasToExplore: ['Discuss load testing.'],
      evidenceCoverage: 'medium',
      scope: 'Interview snapshot only.',
      transcript: [{ question: 'Private question', answer: 'Private full answer' }],
      resume: 'Private resume text',
    },
  });

  assert.equal(manifest.schema, 'buildproof.interview/v1');
  assert.equal(manifest.assessment.provider, 'Google Gemini');
  assert.equal(manifest.assessment.questionCount, 5);
  assert.equal('transcript' in manifest.assessment.report, false);
  assert.equal('resume' in manifest.assessment.report, false);
  const reordered = Object.fromEntries(Object.entries(manifest).reverse());
  assert.equal(hashInterviewManifest(manifest), hashInterviewManifest(reordered));
  assert.match(hashInterviewManifest(manifest), /^[a-f0-9]{64}$/);
});
