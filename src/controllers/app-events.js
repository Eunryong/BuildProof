export function bindAppEvents({ app, state, render, recordById, handleAction, submitForm, startInterview, submitInterviewAnswer, handleResumeFile }) {
  // The app replaces its contents on every render. Delegate from the stable root
  // so newly rendered controls (including saved-interview Delete buttons) keep working.
  app.addEventListener('click', (event) => {
    const target = event.target?.closest ? event.target : event.target?.parentElement;
    const button = target?.closest('button, [data-select]');
    if (!button || !app.contains(button)) return;

    if (button.matches('[data-view]')) {
      state.view = button.dataset.view;
      if (state.view === 'proofs') state.selectedId = state.records.find((record) => record.status === 'issued')?.id || null;
      else if (state.view === 'review') state.selectedId = state.records.find((record) => record.status !== 'issued')?.id || null;
      state.notice = null;
      history.replaceState({}, '', state.view === 'interview' ? '/#interview' : state.view === 'proofs' ? '/#proofs' : '/#review');
      render();
      return;
    }

    if (button.matches('[data-select]')) {
      state.selectedId = button.dataset.select;
      render();
      return;
    }

    if (button.matches('[data-action]')) handleAction({ currentTarget: button });
  });

  app.addEventListener('submit', (event) => {
    if (event.target.matches('#submit-form')) submitForm(event);
    else if (event.target.matches('#interview-start-form')) startInterview(event);
    else if (event.target.matches('#interview-answer-form')) submitInterviewAnswer(event);
  });

  app.addEventListener('input', (event) => {
    const target = event.target;
    if (target.matches('#interview-answer')) state.interview.draftAnswer = target.value;
    if (target.matches('#resume-text')) {
      state.interview.resumeText = target.value;
      state.interview.resumeFile = null;
      state.interview.resumeUrl = '';
      const urlInput = app.querySelector('#resume-url');
      if (urlInput) urlInput.value = '';
      const fileInput = app.querySelector('#resume-upload');
      if (fileInput) fileInput.value = '';
    }
    if (target.matches('#resume-url')) {
      state.interview.resumeUrl = target.value;
      if (state.interview.resumeUrl) {
        state.interview.resumeText = '';
        state.interview.resumeFile = null;
        const textarea = app.querySelector('#resume-text');
        const fileInput = app.querySelector('#resume-upload');
        if (textarea) textarea.value = '';
        if (fileInput) fileInput.value = '';
      }
    }
  });

  app.addEventListener('change', (event) => {
    const target = event.target;
    if (target.matches('#resume-upload')) handleResumeFile(event);
    if (target.matches('[data-interview-consent]')) {
      state.interview.publishConsent = target.checked;
      const button = app.querySelector('[data-action="issue-interview-proof"]');
      if (button) button.disabled = !state.interview.publishConsent || state.interview.busy || !state.interview.reportId;
    }
    if (target.matches('[data-rubric]')) {
      const record = recordById();
      if (record) record.rubric[target.dataset.rubric] = target.checked;
      const count = Object.values(record?.rubric || {}).filter(Boolean).length;
      const countNode = app.querySelector('.rubric-count');
      const approveButton = app.querySelector('[data-action="approve"]');
      if (countNode) countNode.textContent = `${count}/3`;
      if (approveButton) approveButton.disabled = count < 3;
    }
  });
}
