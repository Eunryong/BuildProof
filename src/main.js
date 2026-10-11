import './style.css';
import { detectSolanaWallet } from './wallet.js';
import { createInitialState, rubricLabels } from './models/app-state.js';
import { createAppModel } from './models/app-model.js';
import { createAppView } from './views/app-view.js';
import { bindAppEvents } from './controllers/app-events.js';
import { createActionHandler } from './controllers/app-actions.js';
import { createBootstrapController } from './controllers/bootstrap-controller.js';
import { createInterviewController } from './controllers/interview-controller.js';
import { createNoticeController } from './controllers/notice-controller.js';
import { createProofController } from './controllers/proof-controller.js';
import { createSubmissionController } from './controllers/submission-controller.js';
import { createWalletController } from './controllers/wallet-controller.js';
import { dateLabel, escapeHtml, shortKey } from './utils/format.js';
import { memoProgram, solanaConnection } from './services/solana-client.js';

const app = document.querySelector('#app');
const state = createInitialState(location);
const isPublicDemo = window.BUILDPROOF_PUBLIC_DEMO === true;
const model = createAppModel(state);
const { render } = createAppView({
  app,
  state,
  rubricLabels,
  isPublicDemo,
  escapeHtml,
  shortKey,
  dateLabel,
  recordById: model.recordById,
});
const notices = createNoticeController({ state, render });
const wallet = createWalletController({ state, render, ...notices, shortKey });
const interview = createInterviewController({
  state,
  app,
  api: model.api,
  render,
  setNotice: notices.setNotice,
  location,
  isPublicDemo,
});
const submissions = createSubmissionController({
  state,
  app,
  api: model.api,
  loadRecords: model.loadRecords,
  render,
  setNotice: notices.setNotice,
  recordById: model.recordById,
  rubricLabels,
  isPublicDemo,
});
const proofs = createProofController({
  state,
  app,
  api: model.api,
  loadRecords: model.loadRecords,
  render,
  setNotice: notices.setNotice,
  recordById: model.recordById,
  connectWallet: wallet.connectWallet,
  shortKey,
  connection: solanaConnection,
  memoProgram,
  detectWallet: detectSolanaWallet,
});
const actions = {
  ...interview,
  ...submissions,
  ...proofs,
  ...wallet,
};
const handleAction = createActionHandler({
  state,
  app,
  render,
  setNotice: notices.setNotice,
  loadRecords: model.loadRecords,
  recordById: model.recordById,
  actions,
  location,
});

bindAppEvents({
  app,
  state,
  render,
  recordById: model.recordById,
  handleAction,
  submitForm: submissions.submitForm,
  startInterview: interview.startInterview,
  submitInterviewAnswer: interview.submitInterviewAnswer,
  handleResumeFile: interview.handleResumeFile,
});

createBootstrapController({ state, api: model.api, loadRecords: model.loadRecords, render, location })();
