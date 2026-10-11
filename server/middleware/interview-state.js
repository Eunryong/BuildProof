import { createInterviewService } from '../services/interview-service.js';

export function createInterviewStateMiddleware({ db, runtimeEnvironment, defaultService }) {
  function getInterviewService(request) {
    return request.buildproofInterviewService || defaultService;
  }

  async function loadForRequest(request, _response, next) {
    if (!db) return next();
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
  }

  return { getInterviewService, loadForRequest };
}
