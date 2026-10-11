export function createActionHandler({ state, app, render, setNotice, loadRecords, recordById, actions, location }) {
  return async function handleAction(event) {
    const button = event.currentTarget;
    const action = button.dataset.action;
    if (action === 'dismiss-notice') { state.notice = null; render(); return; }
    if (action === 'new-interview') { location.assign('/interview'); return; }
    if (action === 'discard-interview') { await actions.discardInterview(); return; }
    if (action === 'delete-saved-interview') { await actions.deleteSavedInterview(button); return; }
    if (action === 'open-submit') { state.editingId = null; app.querySelector('#submit-dialog')?.showModal(); return; }
    if (action === 'close-submit') { state.editingId = null; app.querySelector('#submit-dialog')?.close(); return; }
    if (action === 'refresh') {
      try { await loadRecords(); render(); setNotice('Submission list refreshed.', 'success'); }
      catch (error) { setNotice(error.message, 'error'); }
      return;
    }
    if (action === 'wallet') { await actions.connectWallet(); return; }
    if (action === 'use-wallet') {
      const input = app.querySelector('#learner-wallet');
      if (input && state.wallet) input.value = state.wallet;
      return;
    }
    if (action === 'approve' || action === 'request-changes') { await actions.saveReview(action === 'approve' ? 'approved' : 'rejected'); return; }
    if (action === 'edit-submission') {
      const record = recordById();
      if (!record) return;
      state.editingId = record.id;
      render();
      app.querySelector('#submit-dialog')?.showModal();
      return;
    }
    if (action === 'issue') { await actions.issueProof(); return; }
    if (action === 'issue-interview-proof') { await actions.issueInterviewProof(); return; }
    if (action === 'verify-interview-proof') { await actions.verifyInterviewProof(button.dataset.id); return; }
    if (action === 'copy-interview-proof' || action === 'copy-proof') {
      try { await navigator.clipboard.writeText(button.dataset.link); setNotice('Verification link copied.', 'success'); }
      catch { setNotice(button.dataset.link, 'info'); }
      return;
    }
    if (action === 'verify-selected') await actions.verifyProof(button.dataset.id);
  };
}
