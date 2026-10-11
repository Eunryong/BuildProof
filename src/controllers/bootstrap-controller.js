import { detectSolanaWallet } from '../wallet.js';

export function createBootstrapController({ state, api, loadRecords, render, location }) {
  return async function bootstrap() {
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
  };
}
