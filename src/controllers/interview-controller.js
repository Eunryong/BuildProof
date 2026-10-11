export function createInterviewController({ state, app, api, render, setNotice, location, isPublicDemo }) {
  async function handleResumeFile(event) {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    const isText = file.type.startsWith('text/') || /\.(txt|md)$/i.test(file.name);
    if (!isPdf && !isText) { setNotice('Choose a PDF, TXT, or Markdown resume.', 'error'); return; }
    if (file.size > 700 * 1024) { setNotice('Resume files must be smaller than 700 KB.', 'error'); return; }
    try {
      if (isPdf) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
        state.interview.resumeFile = { name: file.name, mimeType: 'application/pdf', data: btoa(binary) };
        state.interview.resumeText = '';
      } else {
        state.interview.resumeText = (await file.text()).slice(0, 24000);
        state.interview.resumeFile = null;
      }
      state.interview.resumeUrl = '';
      render();
      if (isText) {
        app.querySelector('#resume-text')?.focus();
        if (state.interview.resumeText.length >= 24000) setNotice('Resume text was limited to 24,000 characters.', 'info');
      }
    } catch {
      setNotice('The resume file could not be read. Try pasting the text instead.', 'error');
    }
  }

  async function startInterview(event) {
    event.preventDefault();
    const resumeText = app.querySelector('#resume-text')?.value.trim() || '';
    const resumeUrl = app.querySelector('#resume-url')?.value.trim() || '';
    const focusArea = app.querySelector('#focus-area')?.value.trim() || '';
    const language = app.querySelector('#interview-language')?.value || 'en';
    const sourceCount = Number(Boolean(resumeText)) + Number(Boolean(state.interview.resumeFile)) + Number(Boolean(resumeUrl));
    if (sourceCount !== 1) { setNotice('Choose one resume source: upload a file, paste text, or enter a direct file link.', 'error'); return; }
    state.interview.resumeText = resumeText;
    state.interview.resumeUrl = resumeUrl;
    state.interview.busy = true;
    state.notice = null;
    render();
    try {
      const result = await api('/api/interviews', {
        method: 'POST',
        body: JSON.stringify({ resumeText, resumeFile: state.interview.resumeFile, resumeUrl, focusArea, language }),
      });
      state.interview = {
        phase: 'active', id: result.id, profile: result.profile, question: result.question,
        history: [], report: null, reportId: null, publishConsent: false, publishedProof: null, pendingProofDraft: null, pendingProofSubmission: null,
        resumeText: '', resumeFile: null, resumeUrl: '', draftAnswer: '', busy: false,
      };
      state.notice = null;
      location.assign(`/interviews/${encodeURIComponent(result.id)}`);
    } catch (error) {
      state.interview.busy = false;
      render();
      setNotice(error.message, 'error');
    }
  }

  async function submitInterviewAnswer(event) {
    event.preventDefault();
    const answer = app.querySelector('#interview-answer')?.value.trim() || '';
    if (answer.length < 2) { setNotice('Add your answer before continuing.', 'error'); return; }
    const interview = state.interview;
    interview.draftAnswer = answer;
    interview.busy = true;
    state.notice = null;
    render();
    try {
      const result = await api(`/api/interviews/${encodeURIComponent(interview.id)}/answer`, {
        method: 'POST', body: JSON.stringify({ answer }),
      });
      interview.history.push({ question: interview.question.question, focus: interview.question.focus, answer });
      interview.draftAnswer = '';
      interview.busy = false;
      if (result.complete) {
        interview.phase = 'complete';
        interview.report = result.report;
        interview.reportId = result.reportId;
        interview.id = null;
        location.assign(`/reports/${encodeURIComponent(result.reportId)}`);
        return;
      }
      interview.question = result.question;
      state.notice = null;
      render();
    } catch (error) {
      interview.busy = false;
      render();
      setNotice(error.message, 'error');
    }
  }

  async function discardInterview() {
    const id = state.interview.id;
    if (id) {
      try { await api(`/api/interviews/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
      catch { /* A server restart already cleared the temporary session. */ }
    }
    state.interview = { phase: 'idle', id: null, profile: null, question: null, history: [], report: null, reportId: null, publishConsent: false, publishedProof: null, pendingProofDraft: null, pendingProofSubmission: null, resumeText: '', resumeFile: null, resumeUrl: '', draftAnswer: '', busy: false };
    state.notice = null;
    location.assign('/interview');
  }

  async function deleteSavedInterview(button) {
    const kind = button.dataset.kind;
    const id = button.dataset.id;
    if (!id) return;
    try {
      const endpoint = kind === 'completed' ? `/api/interview-reports/${encodeURIComponent(id)}` : `/api/interviews/${encodeURIComponent(id)}`;
      await api(endpoint, { method: 'DELETE' });
      if (state.interview.reportId === id || state.interview.id === id) {
        location.assign('/interview');
        return;
      }
      state.savedInterviews = await api('/api/interviews');
      setNotice(isPublicDemo ? 'Saved interview deleted.' : 'Saved interview deleted from this device.', 'success');
    } catch (error) { setNotice(error.message, 'error'); }
  }

  return { handleResumeFile, startInterview, submitInterviewAnswer, discardInterview, deleteSavedInterview };
}
