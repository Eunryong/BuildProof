export function registerInterviewRoutes(app, { guestRateLimit, getInterviewService, readInterviewProofs, publicInterviewProof, InterviewServiceError }) {
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
}
