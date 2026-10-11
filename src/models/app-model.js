export function createAppModel(state) {
function recordById(id = state.selectedId) {
  return state.records.find((record) => record.id === id) || null;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'The request could not be completed.');
  return body;
}

async function loadRecords(keepSelection = true) {
  const previousSelection = keepSelection ? state.selectedId : null;
  state.records = await api('/api/submissions');
  state.selectedId = state.records.some((record) => record.id === previousSelection)
    ? previousSelection
    : state.records.find((record) => record.status !== 'issued')?.id || state.records[0]?.id || null;
}

  return { recordById, api, loadRecords };
}
