export function createInitialState(location = window.location) {
function initialView() {
  if (new URLSearchParams(location.search).has('proof') || new URLSearchParams(location.search).has('interview-proof')) return 'verification';
  if (/^\/proofs\/?$/.test(location.pathname) || location.hash === '#proofs') return 'proofs';
  if (/^\/review\/?$/.test(location.pathname) || location.hash === '#review') return 'review';
  return 'interview';
}

return {
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
}

export const rubricLabels = [
  ['worksAsShown', 'It works as shown', 'The evidence opens and demonstrates the submitted project.'],
  ['learnerContribution', 'The learner’s contribution is clear', 'The submission points to work they can reasonably claim.'],
  ['skillFit', 'The work demonstrates this skill', 'The project shows practical use of the selected skill.'],
];
