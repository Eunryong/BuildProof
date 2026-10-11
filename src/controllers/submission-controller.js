import { PublicKey } from '@solana/web3.js';

export function createSubmissionController({ state, app, api, loadRecords, render, setNotice, recordById, rubricLabels, isPublicDemo }) {
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

  return { submitForm, saveReview };
}
