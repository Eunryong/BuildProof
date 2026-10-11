import assert from 'node:assert/strict';
import test from 'node:test';
import { bindAppEvents } from '../src/controllers/app-events.js';

test('delegated actions continue working for controls rendered after the event binding', () => {
  const listeners = new Map();
  const app = {
    innerHTML: '',
    addEventListener(type, listener) { listeners.set(type, listener); },
    contains() { return true; },
    querySelector() { return null; },
  };
  let handledButton = null;

  bindAppEvents({
    app,
    state: { records: [], interview: {}, savedInterviews: {} },
    render() {},
    recordById() { return null; },
    handleAction({ currentTarget }) { handledButton = currentTarget; },
    submitForm() {},
    startInterview() {},
    submitInterviewAnswer() {},
    handleResumeFile() {},
  });

  // A render replaces the child controls but keeps the app root and its listener.
  app.innerHTML = '<button data-action="delete-saved-interview">Delete</button>';
  const deleteButton = {
    dataset: { action: 'delete-saved-interview', id: 'demo-session' },
    matches(selector) { return selector === 'button, [data-select]' || selector === '[data-action]'; },
  };
  listeners.get('click')({ target: { closest: () => deleteButton } });

  assert.equal(handledButton, deleteButton);
  assert.equal(handledButton.dataset.id, 'demo-session');
});
