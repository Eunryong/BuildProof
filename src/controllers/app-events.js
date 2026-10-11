export function bindAppEvents({ app, state, render, recordById, handleAction, submitForm, startInterview, submitInterviewAnswer, handleResumeFile }) {
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
  app.querySelector('#submit-form')?.addEventListener('submit', submitForm);
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
