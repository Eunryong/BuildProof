import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createPersistence } from './models/persistence.js';
import * as records from './models/records.js';
import { browserRpcMethods, fetchDevnetTransaction, memoProgram } from './services/solana-devnet.js';
import { registerSystemRoutes } from './controllers/system-controller.js';
import { registerInterviewRoutes } from './controllers/interview-controller.js';
import { registerInterviewProofRoutes } from './controllers/interview-proof-controller.js';
import { registerSubmissionRoutes } from './controllers/submission-controller.js';
import { createInterviewStateMiddleware } from './middleware/interview-state.js';
import { createPublicDemoMiddleware } from './middleware/public-demo.js';
import { createInterviewService, InterviewServiceError } from './services/interview-service.js';
import {
  createInterviewManifest,
  hashInterviewManifest,
  interviewMemoForHash,
  isInterviewProofManifest,
} from './services/interview-proof.js';

let root = '';
try { root = path.dirname(path.dirname(fileURLToPath(import.meta.url))); } catch { /* Workers do not expose a module file URL. */ }

export async function createBuildProofApp({ runtimeEnvironment = process.env, cloudflareEnv = null, vite = null } = {}) {
  const port = Number(runtimeEnvironment.PORT || 8891);
  const host = runtimeEnvironment.HOST || '127.0.0.1';
  const dataDir = runtimeEnvironment.BUILDPROOF_DATA_DIR || path.join(root, 'data');
  const rpcUrl = runtimeEnvironment.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
  const publicDemoMode = runtimeEnvironment.PUBLIC_DEMO_MODE === '1';
  const publicSessionSecret = runtimeEnvironment.BUILDPROOF_SESSION_SECRET || '';
  const db = cloudflareEnv?.DB || null;
  const app = express();
  const persistence = createPersistence({ db, dataDir });
  const interviewService = createInterviewService({
    storageFile: db ? null : path.join(dataDir, 'interviews.json'),
    getApiKey: () => runtimeEnvironment.GEMINI_API_KEY || runtimeEnvironment.GOOGLE_API_KEY || '',
    model: runtimeEnvironment.GEMINI_MODEL || 'gemini-3.8-flash',
  });

  if (publicDemoMode && publicSessionSecret.length < 32) {
    throw new Error('BUILDPROOF_SESSION_SECRET must contain at least 32 characters when PUBLIC_DEMO_MODE=1.');
  }
  if (publicDemoMode) app.set('trust proxy', 1);

  const { identifyGuest, guestRateLimit } = createPublicDemoMiddleware({ enabled: publicDemoMode, secret: publicSessionSecret });
  const interviewState = createInterviewStateMiddleware({ db, runtimeEnvironment, defaultService: interviewService });
  app.use(identifyGuest);
  app.use(express.json({ limit: '1mb' }));
  app.use(interviewState.loadForRequest);

  const routeDependencies = {
    ...records,
    ...persistence,
    guestRateLimit,
    rpcUrl,
    browserRpcMethods,
    interviewService,
    getInterviewService: interviewState.getInterviewService,
    fetchDevnetTransaction: (signature) => fetchDevnetTransaction(rpcUrl, signature),
    createInterviewManifest,
    hashInterviewManifest,
    interviewMemoForHash,
    isInterviewProofManifest,
    memoProgram,
    InterviewServiceError,
  };
  registerSystemRoutes(app, routeDependencies);
  registerInterviewRoutes(app, routeDependencies);
  registerInterviewProofRoutes(app, routeDependencies);
  registerSubmissionRoutes(app, routeDependencies);

  if (!cloudflareEnv && runtimeEnvironment.NODE_ENV !== 'production' && vite) {
    const serveApp = async (request, response, next) => {
      try {
        const template = await readFile(path.join(root, 'src', 'index.html'), 'utf8');
        response.status(200).type('html').send(await vite.transformIndexHtml(request.originalUrl, template));
      } catch (error) {
        next(error);
      }
    };
    app.get('/', serveApp);
    app.get(/^\/(interview\/?|interviews\/[^/]+\/?|reports\/[^/]+\/?|review\/?|proofs\/?)$/, serveApp);
    app.use(vite.middlewares);
  } else if (!cloudflareEnv && runtimeEnvironment.NODE_ENV === 'production') {
    app.use(express.static(path.join(root, 'dist')));
    app.get(/.*/, (_request, response) => response.sendFile(path.join(root, 'dist', 'index.html')));
  }

  app.use((error, _request, response, _next) => {
    console.error(error);
    response.status(500).json({ error: 'The BuildProof service could not finish this request.' });
  });

  return { app, ready: interviewService.ready, port, host };
}
