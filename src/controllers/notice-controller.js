export function createNoticeController({ state, render }) {
  function setNotice(message, kind = 'info') {
    state.notice = { message, kind };
    render();
    window.setTimeout(() => {
      if (state.notice?.message === message) {
        state.notice = null;
        render();
      }
    }, 5000);
  }

  function setPersistentNotice(message, kind = 'info', action = null) {
    state.notice = { message, kind, action };
    render();
  }

  return { setNotice, setPersistentNotice };
}
