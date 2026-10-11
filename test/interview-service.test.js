import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createInterviewService, InterviewServiceError } from '../interview-service.js';

const profile = {
  candidateSummary: 'AI engineer with experience building a retrieval service.',
  skills: [{ name: 'Python', evidence: 'Built API services', confidence: 'high' }],
  projectClaims: [{ project: 'Context search', claim: 'Implemented SQLite FTS5 retrieval', technicalAngles: ['ranking', 'thresholds'] }],
  firstQuestion: 'How did you choose the FTS5 ranking threshold in your project?',
  firstQuestionFocus: 'Search ranking',
};

function assertRequiredSchemaFieldsExist(schema) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.properties) {
    for (const field of schema.required || []) assert.ok(field in schema.properties, `required field ${field} must exist in properties`);
    for (const child of Object.values(schema.properties)) assertRequiredSchemaFieldsExist(child);
  }
  if (schema.items) assertRequiredSchemaFieldsExist(schema.items);
}

test('interview service creates adaptive questions, an evidence report, then clears the session', async () => {
  const responses = [profile,
    ...Array.from({ length: 4 }, (_, index) => ({ question: `Technical follow-up ${index + 2}?`, focus: 'Implementation detail' })),
    {
      summary: 'The candidate explained the search implementation with concrete evidence.',
      criteria: [{
        name: 'Technical accuracy', score: 4, observation: 'Explained the threshold and its trade-offs.',
        evidenceTurn: 5, evidenceQuote: 'I selected the threshold from validation queries.',
      }],
      strengths: ['Connects design decisions to observed query results.'],
      areasToExplore: ['Test behavior under typo-heavy queries.'],
      evidenceCoverage: 'medium',
      scope: 'This reflects only the five-answer interview session.',
    },
  ];
  const inputs = [];
  const service = createInterviewService({
    getApiKey: () => 'test-key',
    model: 'gemini-3.8-flash',
    clientFactory: (key) => {
      assert.equal(key, 'test-key');
      return { models: { generateContent: async (input) => {
        inputs.push(input);
        return { text: JSON.stringify(responses.shift()) };
      } } };
    },
  });

  const started = await service.start({ resumeText: 'A'.repeat(120), language: 'en' });
  assert.equal(started.model, 'gemini-3.8-flash');
  assert.equal(started.question.question, profile.firstQuestion);
  assert.equal(service.activeSessionCount, 1);
  assert.equal(inputs[0].config.responseMimeType, 'application/json');
  assertRequiredSchemaFieldsExist(inputs[0].config.responseSchema);

  for (let index = 1; index < 5; index += 1) {
    const result = await service.answer(started.id, `Answer ${index}: I selected the threshold from validation queries.`);
    assert.equal(result.complete, false);
    assert.equal(result.answered, index);
    assert.equal(result.question.question, `Technical follow-up ${index + 1}?`);
  }

  const final = await service.answer(started.id, 'I selected the threshold from validation queries.');
  assert.equal(final.complete, true);
  assert.ok(final.reportId);
  assert.equal(final.report.criteria[0].score, 4);
  assert.equal(final.report.criteria[0].evidenceTurn, 5);
  assert.equal(final.report.criteria.length, 5);
  assert.equal(final.report.evidenceCoverage, 'medium');
  assert.equal(service.activeSessionCount, 0);
  const completedReport = service.getCompletedReport(final.reportId);
  assert.equal(completedReport.model, 'gemini-3.8-flash');
  assert.equal(completedReport.questionCount, 5);
  assert.deepEqual(completedReport.report, final.report);
  assert.equal(await service.discardCompletedReport(final.reportId), true);
  assert.equal(service.getCompletedReport(final.reportId), null);
  assertRequiredSchemaFieldsExist(inputs.at(-1).config.responseSchema);
});

test('interview state and completed reports survive service restarts, including a failed Gemini retry', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'buildproof-interviews-'));
  const storageFile = path.join(dataDir, 'interviews.json');
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const makeService = (responses) => createInterviewService({
    getApiKey: () => 'test-key',
    storageFile,
    clientFactory: () => ({ models: { generateContent: async () => {
      const value = typeof responses === 'function' ? await responses() : responses.shift();
      if (value instanceof Error) throw value;
      return { text: JSON.stringify(value) };
    } } }),
  });

  const first = makeService([profile, { question: 'What failed in production?', focus: 'Failure handling' }]);
  const started = await first.start({ resumeText: 'PRIVATE TEST RESUME TEXT '.repeat(8), language: 'en' });
  await first.answer(started.id, 'Answer 1: I selected the threshold from validation queries.');

  const restarted = makeService([{ question: 'How did you measure recovery?', focus: 'Operations' }]);
  await restarted.ready;
  const restored = restarted.getSession(started.id);
  assert.equal(restored.history.length, 1);
  assert.equal(restored.history[0].answer, 'Answer 1: I selected the threshold from validation queries.');
  assert.equal(restored.currentQuestion.question, 'What failed in production?');
  await restarted.answer(started.id, 'Answer 2: I added a health check and retry path.');

  const quotaFailure = makeService(() => new Error('429 quota exceeded'));
  await quotaFailure.ready;
  await assert.rejects(
    quotaFailure.answer(started.id, 'Answer 3: I rolled back, then replayed the queued work.'),
    (error) => error instanceof InterviewServiceError && error.status === 429,
  );

  const resumed = makeService([
    { question: 'How did you prevent repeated failure?', focus: 'Resilience' },
    { question: 'What would you change next?', focus: 'Trade-offs' },
    {
      summary: 'The candidate described concrete recovery and reliability work.',
      criteria: [{ name: 'Technical accuracy', score: 3, observation: 'Described a recovery path.', evidenceTurn: 3, evidenceQuote: 'I rolled back, then replayed the queued work.' }],
      strengths: ['Uses measured recovery steps.'], areasToExplore: ['Test larger outage scenarios.'],
      evidenceCoverage: 'medium', scope: 'A limited synthetic QA interview.',
    },
  ]);
  await resumed.ready;
  assert.equal(resumed.getSession(started.id).pendingAnswer, 'Answer 3: I rolled back, then replayed the queued work.');
  await resumed.answer(started.id, 'Answer 3: I rolled back, then replayed the queued work.');
  await resumed.answer(started.id, 'Answer 4: I would add a queue-drain test and an alert threshold.');
  const completed = await resumed.answer(started.id, 'Answer 5: I would test failover under sustained load.');
  assert.equal(completed.complete, true);
  assert.equal(resumed.getSession(started.id), null);

  const afterRestart = makeService([]);
  await afterRestart.ready;
  const savedReport = afterRestart.getCompletedReport(completed.reportId);
  assert.equal(savedReport.history.length, 5);
  assert.equal(savedReport.report.summary, 'The candidate described concrete recovery and reliability work.');
  assert.equal(afterRestart.listSavedInterviews().completed[0].id, completed.reportId);
  const persisted = await readFile(storageFile, 'utf8');
  assert.equal(persisted.includes('PRIVATE TEST RESUME TEXT'), false);
  assert.equal(await afterRestart.discardCompletedReport(completed.reportId), true);
  assert.equal(afterRestart.getCompletedReport(completed.reportId), null);
});

test('interview service reports a missing API key without making a model call', async () => {
  const service = createInterviewService({ getApiKey: () => '', clientFactory: () => { throw new Error('must not initialize'); } });
  assert.deepEqual(service.status(), { configured: false, model: 'gemini-3.8-flash' });
  await assert.rejects(
    service.start({ resumeText: 'A'.repeat(120) }),
    (error) => error instanceof InterviewServiceError && error.status === 503 && /GEMINI_API_KEY/.test(error.message),
  );
});

test('interview service rejects empty and oversized resume inputs', async () => {
  const service = createInterviewService({ getApiKey: () => 'test-key', clientFactory: () => ({ models: { generateContent: async () => ({ text: JSON.stringify(profile) }) } }) });
  await assert.rejects(service.start({ resumeText: 'too short' }), /at least 100 characters/);
  await assert.rejects(service.start({ resumeFile: { mimeType: 'application/pdf', data: Buffer.alloc(700 * 1024 + 1).toString('base64') } }), /smaller than 700 KB/);
});

test('interview service requires exactly one resume source and rejects local links', async () => {
  const service = createInterviewService({ getApiKey: () => 'test-key', clientFactory: () => ({ models: { generateContent: async () => ({ text: JSON.stringify(profile) }) } }) });
  await assert.rejects(service.start({ resumeText: 'A'.repeat(120), resumeUrl: 'https://example.com/resume.pdf' }), /exactly one resume source/);
  await assert.rejects(service.start({ resumeUrl: 'https://localhost/resume.pdf' }), /public website/);
});
