import { httpServerHandler } from 'cloudflare:node';
import { env } from 'cloudflare:workers';
import { createBuildProofApp } from './server.js';

const runtimeEnvironment = {
  ...process.env,
  NODE_ENV: 'production',
  PUBLIC_DEMO_MODE: env.PUBLIC_DEMO_MODE || '1',
  BUILDPROOF_SESSION_SECRET: env.BUILDPROOF_SESSION_SECRET || '',
  GEMINI_API_KEY: env.GEMINI_API_KEY || '',
  GEMINI_MODEL: env.GEMINI_MODEL || 'gemini-3.8-flash',
  SOLANA_RPC_URL: env.SOLANA_RPC_URL || 'https://api.devnet.solana.com',
};

const { app, ready } = await createBuildProofApp({ runtimeEnvironment, cloudflareEnv: env });
await ready;
app.listen(3000);
const handleApiRequest = httpServerHandler({ port: 3000 });

export default {
  fetch(request, bindings, context) {
    if (new URL(request.url).pathname.startsWith('/api/')) {
      return typeof handleApiRequest === 'function'
        ? handleApiRequest(request, bindings, context)
        : handleApiRequest.fetch(request, bindings, context);
    }
    return bindings.ASSETS.fetch(request).then(async (assetResponse) => {
      if (!(assetResponse.headers.get('content-type') || '').includes('text/html')) return assetResponse;
      const html = (await assetResponse.text()).replace('</head>', '<script>window.BUILDPROOF_PUBLIC_DEMO = true;</script></head>');
      const headers = new Headers(assetResponse.headers);
      headers.delete('content-length');
      return new Response(html, { status: assetResponse.status, statusText: assetResponse.statusText, headers });
    });
  },
};
